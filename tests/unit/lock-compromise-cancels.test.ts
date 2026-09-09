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
/** When set, the next metadata upsert fires the compromise once. */
let fireOnNextUpsert = false;
/** When set, the next embedding batch fires the compromise once. */
let fireOnNextEmbed = false;
/**
 * Last metadata payload written, echoed back by `retrieve`, and a count of
 * stored chunk points. Without both, `updateProjectIndex` sees an empty
 * collection and delegates to `indexProject` — so a test aimed at its own
 * terminal write would never reach it.
 */
let lastMetadata: Record<string, unknown> | null = null;
let storedPoints = 0;
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
        points_count: storedPoints,
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
      return lastMetadata === null ? [] : [{ payload: lastMetadata }];
    }
    async upsert(_c: string, body: { points: Array<{ payload?: Record<string, unknown> }> }) {
      if (fireOnNextUpsert) {
        fireOnNextUpsert = false;
        compromise?.(new Error("ENOENT: lock file no longer exists"));
      }
      for (const p of body.points) {
        const status = p.payload?.indexingStatus;
        if (typeof status === "string") {
          savedStatuses.push(status);
          lastMetadata = p.payload ?? null;
        } else {
          storedPoints++;
        }
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
    // Opt-in per test: a run used only as setup must not lose its lock.
    if (fireOnNextEmbed) {
      fireOnNextEmbed = false;
      compromise?.(new Error("ENOENT: lock file no longer exists"));
    }
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
  fireOnNextUpsert = false;
  fireOnNextEmbed = false;
  lastMetadata = null;
  storedPoints = 0;
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

  it("swallows a handler that rejects, not just one that throws", async () => {
    // The callback runs from proper-lockfile's timer with nothing awaiting it,
    // so a rejected promise would surface as an unhandled rejection rather than
    // being caught by the try/catch around the synchronous call.
    const { logger } = await import("../../src/services/logger.js");
    const { acquireProjectLock } = await import("../../src/services/lock.js");
    await acquireProjectLock(tmp, "index", async () => {
      throw new Error("async handler blew up");
    });

    compromise?.(new Error("reclaimed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "Lock compromise handler failed",
      expect.objectContaining({ error: "async handler blew up" }),
    );
  });
});

describe("indexProject when the lock is lost mid-run", () => {
  it("stops, and leaves the collection short of completed", async () => {
    const indexer = await import("../../src/services/indexer.js");
    const project = await fsp.mkdtemp(path.join(tmp, "project-"));

    // Cancellation is checked at the top of each batch, so a single-batch
    // project would finish before the flag was ever read and would pass whether
    // or not the handler is wired. Derived from the constant rather than
    // hard-coded, so a change to the batch size cannot quietly reduce this to
    // one batch.
    const { INDEX_BATCH_SIZE } = await import("../../src/constants.js");
    for (let i = 0; i < INDEX_BATCH_SIZE + 10; i++) {
      await fsp.writeFile(path.join(project, `f${i}.ts`), `export const v${i} = ${i};\n`);
    }

    fireOnNextEmbed = true;
    const result = await indexer.indexProject(project);

    expect(result.cancelled).toBe(true);
    // The damage this prevents: a run that kept writing alongside the new lock
    // holder and then declared the collection healthy.
    expect(savedStatuses).not.toContain("completed");
    expect(savedStatuses).toContain("in-progress");
  });

  it("does not complete when the compromise lands during the final batch", async () => {
    // The batch loop checks at the top of each batch, so a compromise inside
    // the last one is never seen there. A single-batch project makes that the
    // only case: without a terminal gate the run marks the collection healthy
    // while another process may have been writing to it.
    const indexer = await import("../../src/services/indexer.js");
    const { INDEX_BATCH_SIZE } = await import("../../src/constants.js");
    const project = await fsp.mkdtemp(path.join(tmp, "single-batch-"));
    for (let i = 0; i < Math.max(1, INDEX_BATCH_SIZE - 10); i++) {
      await fsp.writeFile(path.join(project, `f${i}.ts`), `export const v${i} = ${i};\n`);
    }

    fireOnNextEmbed = true;
    const result = await indexer.indexProject(project);

    expect(result.cancelled).toBe(true);
    expect(savedStatuses).not.toContain("completed");
  });

  it("does not complete when nothing changed and the compromise lands anyway", async () => {
    // An update with no changed files skips the batch loop entirely, so there
    // is no in-loop check to reach. It still deletes chunks for missing files
    // and still writes the terminal status.
    const indexer = await import("../../src/services/indexer.js");
    const project = await fsp.mkdtemp(path.join(tmp, "no-change-"));
    await fsp.writeFile(path.join(project, "a.ts"), "export const a = 1;\n");

    await indexer.indexProject(project);
    expect(savedStatuses).toContain("completed");

    savedStatuses.length = 0;
    fireOnNextUpsert = true;
    const result = await indexer.updateProjectIndex(project);

    // Nothing was re-indexed, so this genuinely took the incremental path
    // rather than delegating to a full index.
    expect(result.added).toBe(0);
    expect(result.chunksCreated).toBe(0);
    expect(result.cancelled).toBe(true);
    expect(savedStatuses).not.toContain("completed");
  });
});
