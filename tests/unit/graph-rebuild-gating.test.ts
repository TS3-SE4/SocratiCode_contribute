// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * An incremental update rebuilds the code graph only when something the graph
 * is built from actually changed.
 *
 * The rebuild covers the whole repository — measured at 15.9s over 2,713 files
 * and 26.8s over 3,872 — and it previously ran whenever any indexed file
 * changed. 20 of the 63 indexed extensions cannot be parsed by ast-grep (.md,
 * .json, .yaml, .sql and .txt among them), so a documentation commit or a
 * database migration paid for a full rebuild that produced an identical graph.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Last metadata payload written, echoed back by `retrieve`, and a count of
 * stored chunk points. Both are needed: without them `updateProjectIndex` sees
 * an empty collection and delegates to a full index, which rebuilds the graph
 * unconditionally and would make every case here vacuous.
 */
let lastMetadata: Record<string, unknown> | null = null;
let storedPoints = 0;

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
      for (const point of body.points) {
        if (typeof point.payload?.indexingStatus === "string") lastMetadata = point.payload;
        else storedPoints++;
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

// getAstGrepLang stays real: the gate is precisely a question about which
// extensions it recognises, and stubbing it would test the stub.
vi.mock("../../src/services/code-graph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/code-graph.js")>();
  return {
    ...actual,
    ensureDynamicLanguages: vi.fn(),
    rebuildGraph: vi.fn(async () => ({ nodes: [], edges: [] })),
    removeGraph: vi.fn(async () => undefined),
  };
});

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
  lastMetadata = null;
  storedPoints = 0;
  process.env = {
    ...originalEnv,
    QDRANT_MODE: "external",
    EMBEDDING_PROVIDER: "openai",
    EMBEDDING_MODEL: "test-model",
    EMBEDDING_DIMENSIONS: "3",
    EMBEDDING_DOCUMENT_INCLUDE_PATH: "false",
  };
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "socraticode-graphgate-"));
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await fsp.rm(tmp, { recursive: true, force: true });
  vi.clearAllMocks();
});

/**
 * Index a project, apply `mutate`, then run an incremental update. Returns how
 * many times the update alone rebuilt the graph.
 */
async function rebuildsAfter(
  files: Record<string, string>,
  mutate: (project: string) => Promise<void>,
): Promise<number> {
  const indexer = await import("../../src/services/indexer.js");
  const codeGraph = await import("../../src/services/code-graph.js");
  const project = await fsp.mkdtemp(path.join(tmp, "project-"));
  for (const [name, contents] of Object.entries(files)) {
    await fsp.writeFile(path.join(project, name), contents);
  }

  await indexer.indexProject(project);
  vi.mocked(codeGraph.rebuildGraph).mockClear();

  await mutate(project);
  const result = await indexer.updateProjectIndex(project);
  // If the update had delegated to a full index it would rebuild
  // unconditionally, so pin that it took the incremental path.
  expect(result.cancelled).toBe(false);

  return vi.mocked(codeGraph.rebuildGraph).mock.calls.length;
}

describe("code graph rebuild gating", () => {
  it("skips the rebuild when only an unparseable file changed", async () => {
    const rebuilds = await rebuildsAfter(
      { "a.ts": "export const a = 1;\n", "README.md": "# hello\n" },
      async (project) => {
        await fsp.writeFile(path.join(project, "README.md"), "# hello, again\n");
      },
    );
    expect(rebuilds).toBe(0);
  });

  it("still rebuilds when a source file changed", async () => {
    const rebuilds = await rebuildsAfter(
      { "a.ts": "export const a = 1;\n", "README.md": "# hello\n" },
      async (project) => {
        await fsp.writeFile(path.join(project, "a.ts"), "export const a = 2;\n");
      },
    );
    expect(rebuilds).toBe(1);
  });

  it("still rebuilds when a source file was removed", async () => {
    const rebuilds = await rebuildsAfter(
      { "a.ts": "export const a = 1;\n", "b.ts": "export const b = 2;\n" },
      async (project) => {
        await fsp.rm(path.join(project, "b.ts"));
      },
    );
    expect(rebuilds).toBe(1);
  });

  it("rebuilds for an extensionless file rather than guessing", async () => {
    // The indexer resolves these to a language by reading the file, so the
    // extension cannot answer the question. A redundant rebuild is a safe way
    // to be wrong here; a stale graph is not.
    const rebuilds = await rebuildsAfter(
      { "a.ts": "export const a = 1;\n", Dockerfile: "FROM node:22\n" },
      async (project) => {
        await fsp.writeFile(path.join(project, "Dockerfile"), "FROM node:24\n");
      },
    );
    expect(rebuilds).toBe(1);
  });
});
