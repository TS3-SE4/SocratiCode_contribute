// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EffectiveIndexProfile } from "../../src/services/index-profile.js";

let collectionInfo: { pointsCount: number; status: string } | null = null;
let storedHashes: Map<string, string> | null = null;
let storedProfile: EffectiveIndexProfile | null = null;
let tempRoot = "";

/** Points whose payload.relativePath is in here fail to upsert. */
const failUpsertFor = new Set<string>();

const savedMetadata: Array<{ hashes: Map<string, string>; status: string }> = [];
const deletedFiles: string[] = [];

vi.mock("../../src/services/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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

vi.mock("../../src/services/qdrant.js", () => ({
  deleteCollection: vi.fn(async () => undefined),
  deleteFileChunks: vi.fn(async (_collection: string, relativePath: string) => {
    deletedFiles.push(relativePath);
  }),
  deleteProjectMetadata: vi.fn(async () => undefined),
  ensureCollection: vi.fn(async () => undefined),
  getCollectionInfo: vi.fn(async () => collectionInfo),
  getProjectMetadata: vi.fn(async () => null),
  loadProjectEffectiveProfile: vi.fn(async () => storedProfile),
  loadProjectHashes: vi.fn(async () => (storedHashes === null ? null : new Map(storedHashes))),
  saveProjectMetadata: vi.fn(async (
    _collection: string,
    _projectPath: string,
    _filesTotal: number,
    _filesIndexed: number,
    hashes: Map<string, string>,
    status: string,
  ) => {
    storedHashes = new Map(hashes);
    savedMetadata.push({ hashes: new Map(hashes), status });
  }),
  // Mirrors the real per-point fallback: points that fail are skipped, and the
  // owning file's relativePath is reported back to the caller.
  upsertPreEmbeddedChunks: vi.fn(async (
    _collection: string,
    points: Array<{ payload: Record<string, unknown> }>,
  ) => {
    const skippedPaths = new Set<string>();
    let pointsSkipped = 0;
    for (const p of points) {
      const rel = p.payload?.relativePath;
      if (typeof rel === "string" && failUpsertFor.has(rel)) {
        pointsSkipped++;
        skippedPaths.add(rel);
      }
    }
    return { pointsSkipped, skippedPaths };
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

async function loadIndexer() {
  vi.resetModules();
  process.env = {
    ...originalEnv,
    EMBEDDING_PROVIDER: "openai",
    EMBEDDING_MODEL: "test-model",
    EMBEDDING_DIMENSIONS: "3",
    EMBEDDING_CONTEXT_LENGTH: "512",
    EMBEDDING_DOCUMENT_INCLUDE_PATH: "false",
    MAX_CHUNK_CHARS: "2000",
    MAX_FILE_SIZE_MB: "1",
  };
  return import("../../src/services/indexer.js");
}

beforeEach(async () => {
  collectionInfo = null;
  storedHashes = null;
  storedProfile = null;
  savedMetadata.length = 0;
  deletedFiles.length = 0;
  failUpsertFor.clear();
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "socraticode-partial-upsert-"));
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await fsp.rm(tempRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("partial upsert skips must not mark a file as indexed", () => {
  it("withholds the hash of a file whose points were skipped during a full index", async () => {
    const indexer = await loadIndexer();
    const project = await fsp.mkdtemp(path.join(tempRoot, "project-"));
    await fsp.writeFile(path.join(project, "kept.ts"), "export const kept = 1;\n");
    await fsp.writeFile(path.join(project, "lost.ts"), "export const lost = 2;\n");

    failUpsertFor.add("lost.ts");

    await indexer.indexProject(project);

    const hashes = savedMetadata.at(-1)?.hashes ?? new Map();
    expect(hashes.has("kept.ts")).toBe(true);
    // The file whose points were skipped has no chunks in the collection, so
    // recording its hash would suppress every future attempt to index it.
    expect(hashes.has("lost.ts")).toBe(false);
  });

  it("re-indexes a previously skipped file on the next incremental run", async () => {
    const indexer = await loadIndexer();
    const project = await fsp.mkdtemp(path.join(tempRoot, "project-"));
    const lostContent = "export const lost = 2;\n";
    await fsp.writeFile(path.join(project, "kept.ts"), "export const kept = 1;\n");
    await fsp.writeFile(path.join(project, "lost.ts"), lostContent);

    // First pass: lost.ts fails to upsert.
    failUpsertFor.add("lost.ts");
    await indexer.indexProject(project);
    expect(storedHashes?.has("lost.ts")).toBe(false);

    // Second pass with Qdrant healthy: the file must be picked up again even
    // though nothing about it changed on disk.
    failUpsertFor.clear();
    collectionInfo = { pointsCount: 1, status: "green" };
    const result = await indexer.updateProjectIndex(project);

    expect(result.chunksCreated).toBeGreaterThan(0);
    expect(storedHashes?.get("lost.ts")).toBe(indexer.hashContent(lostContent));
  });

  it("does not count skipped chunks as created", async () => {
    const indexer = await loadIndexer();
    const project = await fsp.mkdtemp(path.join(tempRoot, "project-"));
    await fsp.writeFile(path.join(project, "kept.ts"), "export const kept = 1;\n");
    await fsp.writeFile(path.join(project, "lost.ts"), "export const lost = 2;\n");

    failUpsertFor.add("lost.ts");

    const result = await indexer.indexProject(project);

    // Two files chunked, one never landed in Qdrant.
    expect(result.chunksCreated).toBe(1);
  });

  it("does not report a skipped file as indexed", async () => {
    const indexer = await loadIndexer();
    const project = await fsp.mkdtemp(path.join(tempRoot, "project-"));
    await fsp.writeFile(path.join(project, "kept.ts"), "export const kept = 1;\n");
    await fsp.writeFile(path.join(project, "lost.ts"), "export const lost = 2;\n");

    failUpsertFor.add("lost.ts");

    const result = await indexer.indexProject(project);

    // Two files were walked, one never landed. Reporting 2 would claim a clean
    // run and hide the file whose hash was withheld precisely so it is retried.
    expect(result.filesIndexed).toBe(1);
  });
});
