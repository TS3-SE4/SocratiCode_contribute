// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Recovery from an interrupted update, in place, without a new collection.
 *
 * An interrupted run leaves the hash map and the stored points out of step: the
 * hashes are checkpointed as `in-progress`, chunks for files that went missing
 * are deleted, and the pruned hash map is written back only afterwards. Stop in
 * between and the collection holds hashes for points that no longer exist.
 *
 * Nothing recovered from that. The next run read the file, computed the same
 * content hash, matched the stale entry and skipped it — and `indexProject()`
 * took the same skip — so the chunks were never rebuilt and the only way back
 * was deleting the collection.
 *
 * Qdrant and the whole indexing/recovery path are real here. Only embedding
 * readiness and generation are stubbed, so the test needs no model service; the
 * vectors' values are irrelevant to what is being proven, their presence is not.
 */

import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const DIMENSIONS = 3;

vi.mock("../../src/services/embedding-provider.js", () => ({
  getEmbeddingProvider: vi.fn(async () => ({
    ensureReady: vi.fn(async () => ({
      modelPulled: false,
      containerStarted: false,
      imagePulled: false,
    })),
  })),
}));

vi.mock("../../src/services/embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/embeddings.js")>();
  return {
    ...actual,
    generateEmbeddings: vi.fn(async (texts: string[]) =>
      texts.map(() => Array.from({ length: DIMENSIONS }, () => 0.1)),
    ),
  };
});

const { collectionName, projectIdFromPath } = await import("../../src/config.js");
const { ensureQdrantReady } = await import("../../src/services/docker.js");
const { indexProject, updateProjectIndex } = await import("../../src/services/indexer.js");
const {
  deleteFileChunks,
  getCollectionInfo,
  listIndexedFilePaths,
  loadProjectEffectiveProfile,
  loadProjectHashes,
  saveProjectMetadata,
} = await import("../../src/services/qdrant.js");
const { isDockerAvailable } = await import("../helpers/fixtures.js");
const { cleanupTestCollections, waitForQdrant } = await import("../helpers/setup.js");
type EffectiveIndexProfile = import("../../src/services/index-profile.js").EffectiveIndexProfile;

/**
 * Locally this skips without Docker. In CI it must not: a test that skips itself
 * is a silent no-op, and a silent no-op reads exactly like a passing boundary
 * check. REQUIRE_QDRANT=1 turns an unreachable backend into a failure.
 */
const requireQdrant = process.env.REQUIRE_QDRANT === "1";
const shouldRun = requireQdrant || isDockerAvailable();

const originalEnv = { ...process.env };
let root = "";

async function exists(p: string): Promise<boolean> {
  return fsp.access(p).then(
    () => true,
    () => false,
  );
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, body);
  }
}

/**
 * Put the collection into the state an interruption leaves behind: the file's
 * chunks deleted, its hash still present, status `in-progress`. The file on disk
 * is untouched, which is what makes the stale hash match on the next run.
 */
async function simulateInterruptedRemoval(
  collection: string,
  projectPath: string,
  relativePath: string,
): Promise<void> {
  await deleteFileChunks(collection, relativePath);
  const staleHashes = await loadProjectHashes(collection);
  expect(staleHashes?.has(relativePath)).toBe(true);

  // Write back the profile the index actually established, not a freshly
  // requested one — only the stored profile is guaranteed to match, and if the
  // two ever diverged this would quietly exercise a profile change instead of
  // an interruption.
  const storedProfile = await loadProjectEffectiveProfile(collection);
  expect(storedProfile).not.toBeNull();
  await saveProjectMetadata(
    collection,
    projectPath,
    staleHashes?.size ?? 0,
    staleHashes?.size ?? 0,
    staleHashes ?? new Map(),
    "in-progress",
    storedProfile as EffectiveIndexProfile,
  );

  expect((await listIndexedFilePaths(collection)).has(relativePath)).toBe(false);
}

describe.skipIf(!shouldRun)("recovery from an interrupted update", () => {
  beforeAll(async () => {
    if (!requireQdrant) await ensureQdrantReady();
    const ready = await waitForQdrant(60_000);
    if (!ready) {
      throw new Error(
        requireQdrant
          ? "REQUIRE_QDRANT=1 but Qdrant is not reachable — this regression must fail rather than skip."
          : "Qdrant did not become ready",
      );
    }
  }, 180_000);

  beforeEach(async () => {
    process.env = { ...originalEnv, EMBEDDING_DIMENSIONS: String(DIMENSIONS) };
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "socraticode-interrupted-"));
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fsp.rm(root, { recursive: true, force: true });
  });

  afterAll(() => {
    vi.clearAllMocks();
  });

  // Startup drives recovery through indexProject(); a git hook drives it through
  // updateProjectIndex(). Both must restore the file, so both are exercised.
  for (const entry of ["updateProjectIndex", "indexProject"] as const) {
    it(`restores a file whose chunks were removed, via ${entry}(), in the same collection`, async () => {
      const project = path.join(root, `repo-${entry}`);
      await fsp.mkdir(project, { recursive: true });
      await writeFiles(project, {
        "kept.ts": "export const kept = 1;\n",
        "lost.ts": "export const lost = 2;\n",
      });

      try {
        await indexProject(project);
        const collection = collectionName(projectIdFromPath(path.resolve(project)));
        const pointsWhenHealthy = (await getCollectionInfo(collection))?.pointsCount ?? 0;
        expect((await listIndexedFilePaths(collection)).has("lost.ts")).toBe(true);

        await simulateInterruptedRemoval(collection, path.resolve(project), "lost.ts");

        if (entry === "updateProjectIndex") await updateProjectIndex(project);
        else await indexProject(project);

        const recovered = await listIndexedFilePaths(collection);
        expect(recovered.has("lost.ts")).toBe(true);
        expect(recovered.has("kept.ts")).toBe(true);
        expect((await getCollectionInfo(collection))?.pointsCount).toBe(pointsWhenHealthy);
      } finally {
        await cleanupTestCollections(project).catch(() => undefined);
      }
    }, 180_000);
  }

  it("recovers from the original checkout when two worktrees share a project id", async () => {
    // The originally reported shape. A pinned projectId makes both checkouts
    // resolve to one collection, so a run from the linked checkout — where the
    // file genuinely does not exist — removes content belonging to the main
    // one; interrupt that and the main checkout could never restore it.
    //
    // The linked checkout has to materially participate or this collapses into
    // the synthetic case above with unused setup: the differing source tree and
    // the persisted project path both come from `linked`, and only the removal
    // of the points is simulated, because the interruption window itself cannot
    // be hit deterministically.
    const main = path.join(root, "shared");
    await fsp.mkdir(main, { recursive: true });
    execFileSync("git", ["init", "-b", "main", main], { stdio: ["pipe", "pipe", "pipe"] });
    execFileSync("git", ["config", "user.name", "test"], { cwd: main });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: main });
    await writeFiles(main, {
      ".socraticode.json": JSON.stringify({ projectId: "shared_worktree_recovery" }),
      "shared.ts": "export const shared = 1;\n",
      "only-in-main.ts": "export const onlyMain = 2;\n",
    });
    execFileSync("git", ["add", "-A"], { cwd: main });
    execFileSync("git", ["commit", "-m", "init"], { cwd: main });

    // A branch that does not carry the file. This is what makes an index run
    // from the linked checkout delete its chunks in the first place.
    const linked = path.join(root, "shared-worktree");
    execFileSync("git", ["worktree", "add", "-b", "feature", linked], { cwd: main });
    execFileSync("git", ["rm", "-q", "only-in-main.ts"], { cwd: linked });
    execFileSync("git", ["commit", "-m", "drop only-in-main"], { cwd: linked });

    try {
      // Without a shared id the two checkouts never touch one collection and
      // none of what follows is about worktrees.
      expect(projectIdFromPath(linked)).toBe(projectIdFromPath(main));
      expect(await exists(path.join(main, "only-in-main.ts"))).toBe(true);
      expect(await exists(path.join(linked, "only-in-main.ts"))).toBe(false);

      await indexProject(main);
      const collection = collectionName(projectIdFromPath(path.resolve(main)));
      const pointsWhenHealthy = (await getCollectionInfo(collection))?.pointsCount ?? 0;
      expect((await listIndexedFilePaths(collection)).has("only-in-main.ts")).toBe(true);

      // The linked checkout's update: the file is absent there, so its chunks
      // go — and the pruned hashes are never written, because it is
      // interrupted. The project path recorded in metadata is the linked one.
      await simulateInterruptedRemoval(collection, path.resolve(linked), "only-in-main.ts");

      // Startup's entry point, from the checkout that still has the file.
      await indexProject(main);

      const recovered = await listIndexedFilePaths(collection);
      expect(recovered.has("only-in-main.ts")).toBe(true);
      expect(recovered.has("shared.ts")).toBe(true);
      expect((await getCollectionInfo(collection))?.pointsCount).toBe(pointsWhenHealthy);
    } finally {
      await cleanupTestCollections(main).catch(() => undefined);
    }
  }, 180_000);

  it("leaves a healthy completed index alone", async () => {
    // The reconciliation must not become a reason to re-embed a clean index:
    // scoped to `in-progress`, a completed run does no scroll and no extra work.
    const project = path.join(root, "healthy");
    await fsp.mkdir(project, { recursive: true });
    await writeFiles(project, { "a.ts": "export const a = 1;\n" });

    try {
      await indexProject(project);
      const collection = collectionName(projectIdFromPath(path.resolve(project)));
      const before = await loadProjectHashes(collection);

      const result = await updateProjectIndex(project);

      expect(result).toMatchObject({ added: 0, updated: 0, chunksCreated: 0 });
      expect((await loadProjectHashes(collection))?.size).toBe(before?.size);
    } finally {
      await cleanupTestCollections(project).catch(() => undefined);
    }
  }, 180_000);
});
