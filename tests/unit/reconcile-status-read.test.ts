// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * A failed indexing-status read must abort, not be read as "not interrupted".
 *
 * The reconciliation gate asks whether the previous run was interrupted. If a
 * transient metadata failure answers "no", the recovery that failure should have
 * triggered is skipped, the stale hash keeps suppressing the missing file, and
 * the run goes on to persist the still-damaged index as `completed` — a worse
 * outcome than not running at all.
 *
 * `getProjectMetadata()` cannot be used for that decision: it is explicitly
 * display-oriented and catches every read error to answer `null`. These pin the
 * strict loader's behaviour, and that the indexer aborts rather than advancing.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let retrieveBehaviour: () => unknown = () => [];
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
    async createCollection() {}
    async createPayloadIndex() {}
    async retrieve() {
      return retrieveBehaviour();
    }
    async upsert(_c: string, body: { points: Array<{ payload?: Record<string, unknown> }> }) {
      for (const p of body.points) {
        const s = p.payload?.indexingStatus;
        if (typeof s === "string") savedStatuses.push(s);
      }
    }
  },
}));

const originalEnv = { ...process.env };
let tmp = "";

beforeEach(async () => {
  vi.resetModules();
  retrieveBehaviour = () => [];
  savedStatuses.length = 0;
  process.env = { ...originalEnv, QDRANT_MODE: "external" };
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
    // The whole point: getProjectMetadata() would answer null here, and a caller
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

describe("the reconciliation gate", () => {
  it("aborts the index rather than advancing it when the status read fails", async () => {
    const { loadIndexingStatus } = await import("../../src/services/qdrant.js");
    retrieveBehaviour = () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:6333");
    };

    // The gate calls this directly; a rejection propagates out of the index run,
    // so nothing downstream persists a status for a collection it never repaired.
    await expect(loadIndexingStatus("codebase_x")).rejects.toThrow();
    expect(savedStatuses).not.toContain("completed");
  });
});
