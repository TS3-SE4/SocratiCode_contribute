// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Recovery from an interrupted update, without a new collection.
 *
 * An interrupted run leaves the hash map and the stored points out of step: the
 * hashes are checkpointed as `in-progress`, chunks for files that went missing
 * are deleted, and the pruned hash map is only written afterwards. Stop in
 * between and the collection holds hashes for points that no longer exist.
 *
 * Nothing recovered from that. The next run read the file, computed the same
 * content hash, matched the stale entry and skipped it — and a full
 * `codebase_index` took the same skip — so the chunks were never rebuilt. The
 * only way back was deleting the collection.
 *
 * This reproduces the whole sequence against a real Qdrant, including the part
 * that matters operationally: recovery happens in place.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collectionName, projectIdFromPath } from "../../src/config.js";
import { ensureQdrantReady } from "../../src/services/docker.js";
import { indexProject, updateProjectIndex } from "../../src/services/indexer.js";
import {
  deleteFileChunks,
  getCollectionInfo,
  listIndexedFilePaths,
  loadProjectHashes,
  saveProjectMetadata,
} from "../../src/services/qdrant.js";
import { isDockerAvailable } from "../helpers/fixtures.js";
import { cleanupTestCollections, waitForQdrant } from "../helpers/setup.js";

/**
 * Locally this skips without Docker. In CI it must not: a test that skips
 * itself is a silent no-op, and a silent no-op reads exactly like a passing
 * boundary check. REQUIRE_QDRANT=1 turns an unreachable backend into a failure.
 */
const requireQdrant = process.env.REQUIRE_QDRANT === "1";
const shouldRun = requireQdrant || isDockerAvailable();

let root = "";
let project = "";

/** Distinct content per file so each produces its own chunk. */
async function writeProject(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, body);
  }
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
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "socraticode-interrupted-"));
    project = path.join(root, "repo");
    await fsp.mkdir(project, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTestCollections(project).catch(() => undefined);
    await fsp.rm(root, { recursive: true, force: true });
  });

  afterAll(async () => {
    await cleanupTestCollections(project).catch(() => undefined);
  });

  it("re-indexes a file whose chunks were removed, in the same collection", async () => {
    await writeProject(project, {
      "kept.ts": "export const kept = 1;\n",
      "lost.ts": "export const lost = 2;\n",
    });

    await indexProject(project);
    const collection = collectionName(projectIdFromPath(path.resolve(project)));

    const afterIndex = await listIndexedFilePaths(collection);
    expect(afterIndex.has("kept.ts")).toBe(true);
    expect(afterIndex.has("lost.ts")).toBe(true);
    const pointsAfterIndex = (await getCollectionInfo(collection))?.pointsCount ?? 0;

    // Reproduce an interruption: chunks for a file are deleted, and the run
    // stops before the pruned hash map is checkpointed — so the hash survives
    // while the points do not. The file on disk is untouched, which is what
    // makes the stale hash match on the next run.
    await deleteFileChunks(collection, "lost.ts");
    const staleHashes = await loadProjectHashes(collection);
    expect(staleHashes?.has("lost.ts")).toBe(true);
    await saveProjectMetadata(
      collection,
      path.resolve(project),
      2,
      2,
      staleHashes ?? new Map(),
      "in-progress",
      // Reuse whatever profile the index established, so this differs from the
      // completed state only in the status and the missing points.
      (await import("../../src/services/index-profile.js")).requestedIndexProfile("code"),
    );

    expect((await listIndexedFilePaths(collection)).has("lost.ts")).toBe(false);

    // Recovery: an ordinary incremental, in the same collection.
    await updateProjectIndex(project);

    const recovered = await listIndexedFilePaths(collection);
    expect(recovered.has("lost.ts")).toBe(true);
    expect(recovered.has("kept.ts")).toBe(true);
    expect((await getCollectionInfo(collection))?.pointsCount).toBe(pointsAfterIndex);
  }, 180_000);

  it("leaves a healthy completed index alone", async () => {
    // The reconciliation must not become a reason to re-embed a clean index:
    // scoped to `in-progress`, a completed run does no scroll and no extra work.
    await writeProject(project, { "a.ts": "export const a = 1;\n" });
    await indexProject(project);

    const collection = collectionName(projectIdFromPath(path.resolve(project)));
    const before = await loadProjectHashes(collection);

    const result = await updateProjectIndex(project);

    expect(result).toMatchObject({ added: 0, updated: 0, chunksCreated: 0 });
    expect((await loadProjectHashes(collection))?.size).toBe(before?.size);
  }, 180_000);
});
