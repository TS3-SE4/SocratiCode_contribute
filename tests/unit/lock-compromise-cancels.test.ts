// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Losing the index lock mid-run must stop the run.
 *
 * The lock is keyed by project id and the collection it guards is shared, so a
 * compromised lock means another process may now be indexing what this run is
 * still writing to. `onCompromised` previously logged and dropped the lock from
 * the held map, and the run carried on writing — two writers on one collection,
 * which is the state the reconciliation on resume exists to survive rather than
 * one to enter deliberately.
 *
 * Cancellation returns before the terminal `completed` write, so the collection
 * is left `in-progress` and the next run reconciles it.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** proper-lockfile's compromise callback, captured at acquire time. */
let compromise: ((err: Error) => void) | null = null;
let embedCalls = 0;
/** Every indexingStatus value written to the metadata collection. */
const savedStatuses: string[] = [];

vi.mock("../../src/services/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("proper-lockfile", () => ({
  default: {
    lock: vi.fn(async (_file: string, opts?: { onCompromised?: (err: Error) => void }) => {
      compromise = opts?.onCompromised ?? null;
      return async () => {};
    }),
  },
}));

vi.mock("../../src/services/qdrant-client-compat.js", () => ({
  ensureQdrantClientCompatibility: vi.fn(),
}));

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: class {
    async getCollections() {
      return { collections: [{ name: "socraticode_metadata" }] };
    }
    async getCollection() {
      return {
        points_count: 0,
        status: "green",
        config: { params: { vectors: { dense: { size: 3, distance: "Cosine" } } } },
      };
    }
    async createCollection() {}
    async createPayloadIndex() {}
    async scroll() {
      return { points: [], next_page_offset: null };
    }
    async delete() {}
    async retrieve() {
      return [];
    }
    async upsert(_c: string, body: { points: Array<{ payload?: Record<string, unknown> }> }) {
      for (const p of body.points) {
        const s = p.payload?.indexingStatus;
        if (typeof s === "string") savedStatuses.push(s);
      }
    }
  },
}));

vi.mock("../../src/services/embedding-provider.js", () => ({
  getEmbeddingProvider: vi.fn(async () => ({
    ensureReady: vi.fn(async () => ({
      modelPulled: false,
      containerStarted: false,
      imagePulled: false,
    })),
  })),
}));

vi.mock("../../src/services/embeddings.js", () => ({
  prepareDocumentText: vi.fn((content: string) => content),
  generateEmbeddings: vi.fn(async (texts: string[]) => {
    embedCalls++;
    // Lose the lock while the first batch is in flight. Cancellation is checked
    // between batches, so the run must have more than one batch for this to be
    // observable at all — see the file count below.
    if (embedCalls === 1) compromise?.(new Error("ENOENT: lock file no longer exists"));
    return texts.map(() => [0.1, 0.1, 0.1]);
  }),
}));

vi.mock("../../src/services/code-graph.js", () => ({
  ensureDynamicLanguages: vi.fn(),
  getAstGrepLang: vi.fn(() => null),
  rebuildGraph: vi.fn(async () => ({ nodes: [], edges: [] })),
  removeGraph: vi.fn(async () => undefined),
}));

vi.mock("../../src/services/elixir-templates.js", () => ({
  analyzeElixirTemplate: vi.fn(() => null),
  ensureElixirTemplateParsers: vi.fn(async () => undefined),
  isElixirTemplateExtension: vi.fn(() => false),
}));

vi.mock("../../src/services/symbol-graph-incremental.js", () => ({
  updateChangedFilesSymbolGraph: vi.fn(async () => ({ updated: 0, removed: 0 })),
}));

vi.mock("../../src/services/symbol-graph-store.js", () => ({
  loadSymbolGraphMeta: vi.fn(async () => null),
}));

const originalEnv = { ...process.env };
let tmp = "";

beforeEach(async () => {
  vi.resetModules();
  compromise = null;
  embedCalls = 0;
  savedStatuses.length = 0;
  process.env = {
    ...originalEnv,
    QDRANT_MODE: "external",
    EMBEDDING_PROVIDER: "openai",
    EMBEDDING_MODEL: "test-model",
    EMBEDDING_DIMENSIONS: "3",
    EMBEDDING_DOCUMENT_INCLUDE_PATH: "false",
  };
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "socraticode-lock-"));
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await fsp.rm(tmp, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("acquireProjectLock", () => {
  it("hands a compromise on to the caller", async () => {
    const { acquireProjectLock } = await import("../../src/services/lock.js");
    const seen: Error[] = [];

    expect(await acquireProjectLock(tmp, "index", (err) => seen.push(err))).toBe(true);
    expect(compromise).not.toBeNull();

    compromise?.(new Error("reclaimed"));
    expect(seen.map((e) => e.message)).toEqual(["reclaimed"]);
  });

  it("swallows a throwing handler — it runs from a timer with nowhere to throw", async () => {
    const { acquireProjectLock } = await import("../../src/services/lock.js");
    await acquireProjectLock(tmp, "index", () => {
      throw new Error("handler blew up");
    });

    expect(() => compromise?.(new Error("reclaimed"))).not.toThrow();
  });
});

describe("indexProject when the lock is lost mid-run", () => {
  it("stops, and leaves the collection short of completed", async () => {
    const indexer = await import("../../src/services/indexer.js");
    const project = await fsp.mkdtemp(path.join(tmp, "project-"));

    // INDEX_BATCH_SIZE is 50 and cancellation is checked at the top of each
    // batch, so a single-batch project would finish before the flag was ever
    // read and would pass whether or not the handler is wired.
    for (let i = 0; i < 60; i++) {
      await fsp.writeFile(path.join(project, `f${i}.ts`), `export const v${i} = ${i};\n`);
    }

    const result = await indexer.indexProject(project);

    expect(result.cancelled).toBe(true);
    // The damage this prevents: a run that kept writing alongside the new lock
    // holder and then declared the collection healthy.
    expect(savedStatuses).not.toContain("completed");
    expect(savedStatuses).toContain("in-progress");
  });
});
