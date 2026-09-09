// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Caller-level behaviour around partial Qdrant writes and completion reporting.
 *
 * Only the Qdrant client and the metadata store are stubbed — `indexProject`
 * and `upsertPreEmbeddedChunks` both run as shipped, so the batch -> per-point
 * fallback and the caller's reaction to it are exercised together.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EffectiveIndexProfile } from "../../src/services/index-profile.js";

/** Points whose payload.relativePath is in here are rejected by the stub client. */
const failUpsertFor = new Set<string>();

let storedHashes: Map<string, string> | null = null;
let storedProfile: EffectiveIndexProfile | null = null;
let collectionInfo: { pointsCount: number; status: string } | null = null;
let tempRoot = "";

const savedMetadata: Array<{
  filesTotal: number;
  filesIndexed: number;
  hashes: Map<string, string>;
  status: string;
}> = [];

vi.mock("../../src/services/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: class {
    async upsert(_collection: string, body: { points: Array<{ payload?: Record<string, unknown> }> }) {
      if (body.points.some((p) => failUpsertFor.has(String(p.payload?.relativePath)))) {
        throw new Error("Bad Request: invalid point");
      }
    }
  },
}));

vi.mock("../../src/services/qdrant-client-compat.js", () => ({
  ensureQdrantClientCompatibility: vi.fn(),
}));

vi.mock("../../src/services/embedding-provider.js", () => ({
  getEmbeddingProvider: vi.fn(async () => ({
    ensureReady: vi.fn(async () => ({ modelPulled: false, containerStarted: false, imagePulled: false })),
  })),
}));

vi.mock("../../src/services/embeddings.js", () => ({
  prepareDocumentText: vi.fn((content: string) => content),
  generateEmbeddings: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.1, 0.1])),
}));

// Keep the real upsertPreEmbeddedChunks; stub only the metadata/collection I/O.
vi.mock("../../src/services/qdrant.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/qdrant.js")>();
  return {
    ...actual,
    deleteCollection: vi.fn(async () => undefined),
    deleteFileChunks: vi.fn(async () => undefined),
    deleteProjectMetadata: vi.fn(async () => undefined),
    ensureCollection: vi.fn(async () => undefined),
    getCollectionInfo: vi.fn(async () => collectionInfo),
    getProjectMetadata: vi.fn(async () => null),
    loadProjectEffectiveProfile: vi.fn(async () => storedProfile),
    loadProjectHashes: vi.fn(async () => (storedHashes === null ? null : new Map(storedHashes))),
    saveProjectMetadata: vi.fn(async (
      _collection: string,
      _projectPath: string,
      filesTotal: number,
      filesIndexed: number,
      hashes: Map<string, string>,
      status: string,
      profile: EffectiveIndexProfile,
    ) => {
      storedHashes = new Map(hashes);
      storedProfile = profile;
      savedMetadata.push({ filesTotal, filesIndexed, hashes: new Map(hashes), status });
    }),
  };
});

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

async function loadIndexer(overrides: Record<string, string> = {}) {
  vi.resetModules();
  process.env = {
    ...originalEnv,
    EMBEDDING_PROVIDER: "openai",
    EMBEDDING_MODEL: "test-model",
    EMBEDDING_DIMENSIONS: "3",
    EMBEDDING_CONTEXT_LENGTH: "512",
    EMBEDDING_DOCUMENT_INCLUDE_PATH: "false",
    MAX_CHUNK_CHARS: "2000",
    MAX_FILE_SIZE_MB: "5",
    ...overrides,
  };
  return import("../../src/services/indexer.js");
}

beforeEach(async () => {
  storedHashes = null;
  storedProfile = null;
  collectionInfo = null;
  savedMetadata.length = 0;
  failUpsertFor.clear();
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "socraticode-indexer-partial-"));
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await fsp.rm(tempRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("completion reporting counts only files the index represents", () => {
  it("reports filesTotal 2 and filesIndexed 1 when one file is skipped as oversized", async () => {
    // 1 kB ceiling: small.ts is indexed, big.ts is skipped before chunking.
    const indexer = await loadIndexer({ MAX_FILE_SIZE_MB: "0.001" });
    const project = await fsp.mkdtemp(path.join(tempRoot, "project-"));
    await fsp.writeFile(path.join(project, "small.ts"), "export const small = 1;\n");
    await fsp.writeFile(path.join(project, "big.ts"), `// ${"x".repeat(4000)}\n`);

    const result = await indexer.indexProject(project);

    const meta = savedMetadata.at(-1);
    expect(meta?.filesTotal).toBe(2);
    expect(meta?.filesIndexed).toBe(1);
    // The returned and reported count must match what the index holds, not the
    // number of paths the walk turned up.
    expect(result.filesIndexed).toBe(1);
  });
});

describe("a partial Qdrant failure reaches the caller and is retried later", () => {
  it("propagates the failure, saves no completion, and re-indexes the file on the next healthy run", async () => {
    const indexer = await loadIndexer();
    const project = await fsp.mkdtemp(path.join(tempRoot, "project-"));
    const lostContent = "export const lost = 2;\n";
    await fsp.writeFile(path.join(project, "kept.ts"), "export const kept = 1;\n");
    await fsp.writeFile(path.join(project, "lost.ts"), lostContent);

    failUpsertFor.add("lost.ts");

    // 1. the partial Qdrant failure is propagated
    await expect(indexer.indexProject(project)).rejects.toThrow(/point\(s\) failed|upsert failed/i);

    // 2. no successful completion was saved, and the hash was never advanced
    expect(savedMetadata.some((m) => m.status === "completed")).toBe(false);
    expect(storedHashes?.has("lost.ts") ?? false).toBe(false);

    // 3. a subsequent healthy run selects the file and stores it
    failUpsertFor.clear();
    const result = await indexer.indexProject(project);

    expect(storedHashes?.get("lost.ts")).toBe(indexer.hashContent(lostContent));
    expect(result.filesIndexed).toBe(2);
    expect(savedMetadata.at(-1)?.status).toBe("completed");
  });
});
