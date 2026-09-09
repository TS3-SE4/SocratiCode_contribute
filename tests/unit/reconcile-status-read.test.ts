// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * A failed indexing-status read must abort the run, not be read as "not
 * interrupted".
 *
 * The reconciliation gate asks whether the previous run was interrupted. If a
 * transient metadata failure answers "no", the recovery that failure should have
 * triggered is skipped, the stale hash keeps suppressing the missing file, and
 * the run goes on to persist the still-damaged index as `completed` — a worse
 * outcome than not running at all.
 *
 * `getProjectMetadata()` cannot be used for that decision: it is explicitly
 * display-oriented and catches every read error to answer `null`.
 *
 * Only the Qdrant client is stubbed. `qdrant.js` and the indexer run for real,
 * so the second block exercises the actual entry point rather than asserting
 * against a function that could never have persisted anything.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Metadata `retrieve` behaviour, replaced per test. */
let retrieveBehaviour: (call: number) => unknown = () => [];
let retrieveCalls = 0;
const savedStatuses: string[] = [];

vi.mock("../../src/services/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
        points_count: 1,
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
      retrieveCalls++;
      return retrieveBehaviour(retrieveCalls);
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
  generateEmbeddings: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.1, 0.1])),
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

vi.mock("../../src/services/lock.js", () => ({
  acquireProjectLock: vi.fn(async () => true),
  releaseProjectLock: vi.fn(async () => undefined),
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
  retrieveBehaviour = () => [];
  retrieveCalls = 0;
  savedStatuses.length = 0;
  process.env = {
    ...originalEnv,
    QDRANT_MODE: "external",
    EMBEDDING_PROVIDER: "openai",
    EMBEDDING_MODEL: "test-model",
    EMBEDDING_DIMENSIONS: "3",
    EMBEDDING_DOCUMENT_INCLUDE_PATH: "false",
  };
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "socraticode-status-"));
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await fsp.rm(tmp, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("loadIndexingStatus", () => {
  it("returns null when there is genuinely no metadata", async () => {
    const { loadIndexingStatus } = await import("../../src/services/qdrant.js");
    retrieveBehaviour = () => [];
    expect(await loadIndexingStatus("codebase_x")).toBeNull();
  });

  it("reads the persisted status", async () => {
    const { loadIndexingStatus } = await import("../../src/services/qdrant.js");
    retrieveBehaviour = () => [{ payload: { indexingStatus: "in-progress" } }];
    expect(await loadIndexingStatus("codebase_x")).toBe("in-progress");
  });

  it("treats an absent status as completed, for records written before the field", async () => {
    const { loadIndexingStatus } = await import("../../src/services/qdrant.js");
    retrieveBehaviour = () => [{ payload: { projectPath: "/p" } }];
    expect(await loadIndexingStatus("codebase_x")).toBe("completed");
  });

  it("propagates a transport failure instead of reporting no metadata", async () => {
    // The whole point: getProjectMetadata() answers null here, and a caller
    // deciding "was this interrupted?" would read that as "no".
    const { loadIndexingStatus } = await import("../../src/services/qdrant.js");
    retrieveBehaviour = () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:6333");
    };
    await expect(loadIndexingStatus("codebase_x")).rejects.toThrow(/ECONNREFUSED/);
  });

  it("refuses to guess when the stored status is unrecognised", async () => {
    const { loadIndexingStatus } = await import("../../src/services/qdrant.js");
    retrieveBehaviour = () => [{ payload: { indexingStatus: "half-done" } }];
    await expect(loadIndexingStatus("codebase_x")).rejects.toThrow(/Unrecognised indexingStatus/);
  });

  it("still answers null for a missing collection, which is not a failure", async () => {
    const { loadIndexingStatus } = await import("../../src/services/qdrant.js");
    retrieveBehaviour = () => {
      throw Object.assign(new Error("Not found"), { status: 404 });
    };
    expect(await loadIndexingStatus("codebase_x")).toBeNull();
  });
});

describe("indexProject when the status read fails", () => {
  it("rejects, and does not persist a completed status over a collection it never repaired", async () => {
    const indexer = await import("../../src/services/indexer.js");
    const project = await fsp.mkdtemp(path.join(tmp, "project-"));
    await fsp.writeFile(path.join(project, "a.ts"), "export const a = 1;\n");

    // Exactly one read fails: the reconciliation gate's, which is the second.
    // The hash load precedes it and must succeed or the run would abort there;
    // every read after it must also succeed, or this would pass whether the gate
    // is strict or lenient — the run would reject either way and the assertion
    // would prove nothing. With only call 2 failing, a lenient gate swallows the
    // error, carries on, and persists `completed`; a strict gate aborts.
    const metadata = [
      {
        payload: {
          projectPath: project,
          fileHashes: JSON.stringify({ "a.ts": "stale-hash" }),
          indexingStatus: "in-progress",
        },
      },
    ];
    retrieveBehaviour = (call) => {
      if (call === 2) throw new Error("connect ECONNREFUSED 127.0.0.1:6333");
      return metadata;
    };

    await expect(indexer.indexProject(project)).rejects.toThrow(/ECONNREFUSED/);

    // The damage this guards against: marking an unrepaired index healthy.
    expect(savedStatuses).not.toContain("completed");
    expect(retrieveCalls).toBeGreaterThanOrEqual(2);
  });
});
