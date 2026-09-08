// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Regression for partial Qdrant writes, against a real Qdrant.
 *
 * A batch containing one valid and one genuinely invalid point must:
 *   1. fail the batch upsert,
 *   2. store the valid point via the per-point fallback,
 *   3. surface the remaining failure rather than reporting success,
 *   4. leave the affected file's stored hash unadvanced, so
 *   5. a later healthy run re-indexes it.
 *
 * (4) and (5) are the point of the exercise. Before this, a partially-skipped
 * file was recorded as current, which stranded it at zero chunks permanently:
 * no later incremental looked at it again, and a full re-index hash-matched and
 * skipped it too.
 *
 * The invalid point is rejected by Qdrant itself — a dense vector of the wrong
 * width — rather than by a stub, so the batch/per-point fallback is exercised
 * exactly as it runs in production.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectionName, projectIdFromPath } from "../../src/config.js";
import { ensureQdrantReady } from "../../src/services/docker.js";
import { requestedIndexProfile } from "../../src/services/index-profile.js";
import {
  ensureCollection,
  getCollectionInfo,
  loadProjectHashes,
  saveProjectMetadata,
  upsertPreEmbeddedChunks,
} from "../../src/services/qdrant.js";
import { isDockerAvailable } from "../helpers/fixtures.js";
import { deleteTestCollection, waitForQdrant } from "../helpers/setup.js";

/**
 * Locally this skips without Docker. In CI it must not: a test that skips
 * itself is a silent no-op, and a silent no-op is indistinguishable from a
 * passing boundary check. REQUIRE_QDRANT=1 therefore turns an unreachable
 * backend into a failure — the same reason the Rust graph job asserts
 * `rustc --version` before running its skip-capable test.
 */
const requireQdrant = process.env.REQUIRE_QDRANT === "1";
const dockerAvailable = isDockerAvailable();
const shouldRun = requireQdrant || dockerAvailable;

const TEST_PROJECT = "/tmp/socraticode-partial-upsert-integration";
const TEST_COLLECTION = collectionName(projectIdFromPath(TEST_PROJECT));

const KEPT_ID = "11111111-1111-4111-8111-111111111111";
const LOST_ID = "22222222-2222-4222-8222-222222222222";
const KEPT_PATH = "src/kept.ts";
const LOST_PATH = "src/lost.ts";

/** Width the collection was actually created with, read back from Qdrant. */
let denseSize = 0;

function pointOfWidth(id: string, relativePath: string, width: number) {
  return {
    id,
    vector: Array.from({ length: width }, () => 0.1),
    bm25Text: `contents of ${relativePath}`,
    payload: { relativePath, content: "chunk", contentHash: `hash-${relativePath}` },
  };
}

describe.skipIf(!shouldRun)("partial Qdrant upsert fails the whole operation", () => {
  beforeAll(async () => {
    if (!requireQdrant) {
      await ensureQdrantReady();
    }
    const ready = await waitForQdrant(60_000);
    if (!ready) {
      throw new Error(
        requireQdrant
          ? "REQUIRE_QDRANT=1 but Qdrant is not reachable. This regression must fail rather " +
            "than skip: set QDRANT_MODE/QDRANT_HOST/QDRANT_PORT to a running instance."
          : "Qdrant did not become ready",
      );
    }

    await deleteTestCollection(TEST_COLLECTION);
    await ensureCollection(TEST_COLLECTION);

    const info = await getCollectionInfo(TEST_COLLECTION);
    if (!info?.denseVectorSize) {
      throw new Error("test setup: could not read the collection's dense vector width");
    }
    denseSize = info.denseVectorSize;
  }, 180_000);

  afterAll(async () => {
    await deleteTestCollection(TEST_COLLECTION);
  });

  it("stores the valid point, then throws naming the invalid one", async () => {
    const err = await upsertPreEmbeddedChunks(TEST_COLLECTION, [
      pointOfWidth(KEPT_ID, KEPT_PATH, denseSize),
      // Wrong width — Qdrant rejects this in the batch and again on its own.
      pointOfWidth(LOST_ID, LOST_PATH, denseSize + 3),
    ]).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(LOST_PATH);
    expect(err.message).toContain("1/2");

    // Failing the operation must not throw away the point that did land.
    const info = await getCollectionInfo(TEST_COLLECTION);
    expect(info?.pointsCount).toBe(1);
  }, 120_000);

  it("leaves the stored hash unadvanced so a later healthy run retries the file", async () => {
    const priorHash = "hash-from-previous-index";
    await saveProjectMetadata(
      TEST_COLLECTION,
      TEST_PROJECT,
      1,
      1,
      new Map([[LOST_PATH, priorHash]]),
      "completed",
      requestedIndexProfile("code"),
    );

    // A caller that honours the throw never reaches its hash update.
    await upsertPreEmbeddedChunks(TEST_COLLECTION, [
      pointOfWidth(KEPT_ID, KEPT_PATH, denseSize),
      pointOfWidth(LOST_ID, LOST_PATH, denseSize + 3),
    ]).catch(() => undefined);

    const hashes = await loadProjectHashes(TEST_COLLECTION);
    expect(hashes?.get(LOST_PATH)).toBe(priorHash);

    // With the stale hash intact the file still looks changed, so the next run
    // re-indexes it — and now that the point is well-formed, it lands.
    await expect(
      upsertPreEmbeddedChunks(TEST_COLLECTION, [
        pointOfWidth(LOST_ID, LOST_PATH, denseSize),
      ]),
    ).resolves.toBeUndefined();

    const info = await getCollectionInfo(TEST_COLLECTION);
    expect(info?.pointsCount).toBe(2);
  }, 120_000);
});
