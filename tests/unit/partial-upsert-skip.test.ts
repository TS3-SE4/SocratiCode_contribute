// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * A point that still fails after the per-point fallback must fail the whole
 * upsert. Anything less lets a caller record a file as indexed whose chunks were
 * deleted and never replaced, stranding it at zero chunks behind a content hash
 * that suppresses every future re-index.
 *
 * These exercise the real `upsertPreEmbeddedChunks`, stubbing only the Qdrant
 * client beneath it, so the batch -> per-point fallback runs as shipped.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Points carrying this path are rejected by the stub client. */
const POISON_PATH = "src/lost.ts";

const upsertCalls: Array<{ collection: string; ids: string[] }> = [];

vi.mock("../../src/services/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/services/qdrant-client-compat.js", () => ({
  ensureQdrantClientCompatibility: vi.fn(),
}));

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: class {
    async upsert(collection: string, body: { points: Array<{ id: string; payload?: Record<string, unknown> }> }) {
      const ids = body.points.map((p) => p.id);
      const poisoned = body.points.some((p) => p.payload?.relativePath === POISON_PATH);
      if (poisoned) {
        // Fails whether sent in a batch or on its own, so the per-point
        // fallback isolates it rather than curing it.
        throw new Error("Bad Request: invalid point");
      }
      upsertCalls.push({ collection, ids });
    }
  },
}));

function point(id: string, relativePath: string) {
  return {
    id,
    vector: [0.1, 0.2, 0.3],
    bm25Text: `text for ${relativePath}`,
    payload: { relativePath, content: "x" },
  };
}

beforeEach(() => {
  upsertCalls.length = 0;
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("upsertPreEmbeddedChunks partial failure handling", () => {
  it("throws when a point still fails after the per-point fallback", async () => {
    const { upsertPreEmbeddedChunks } = await import("../../src/services/qdrant.js");

    await expect(
      upsertPreEmbeddedChunks("codebase_test", [
        point("00000000-0000-4000-8000-000000000001", "src/kept.ts"),
        point("00000000-0000-4000-8000-000000000002", POISON_PATH),
      ]),
    ).rejects.toThrow(/1\/2 point\(s\) failed/);
  });

  it("names the affected file and the collection in the error", async () => {
    const { upsertPreEmbeddedChunks } = await import("../../src/services/qdrant.js");

    const err = await upsertPreEmbeddedChunks("codebase_test", [
      point("00000000-0000-4000-8000-000000000001", "src/kept.ts"),
      point("00000000-0000-4000-8000-000000000002", POISON_PATH),
    ]).catch((e: unknown) => e as Error);

    expect(err.message).toContain(POISON_PATH);
    expect(err.message).toContain("codebase_test");
  });

  it("still stores the healthy points of a mixed batch before failing", async () => {
    const { upsertPreEmbeddedChunks } = await import("../../src/services/qdrant.js");

    await upsertPreEmbeddedChunks("codebase_test", [
      point("00000000-0000-4000-8000-000000000001", "src/kept.ts"),
      point("00000000-0000-4000-8000-000000000002", POISON_PATH),
    ]).catch(() => undefined);

    // The batch call fails, then the fallback writes the good point on its own.
    // Losing it would be a second, quieter data-loss bug.
    const stored = upsertCalls.flatMap((c) => c.ids);
    expect(stored).toContain("00000000-0000-4000-8000-000000000001");
    expect(stored).not.toContain("00000000-0000-4000-8000-000000000002");
  });

  it("resolves without error when every point lands", async () => {
    const { upsertPreEmbeddedChunks } = await import("../../src/services/qdrant.js");

    await expect(
      upsertPreEmbeddedChunks("codebase_test", [
        point("00000000-0000-4000-8000-000000000001", "src/kept.ts"),
        point("00000000-0000-4000-8000-000000000003", "src/also-kept.ts"),
      ]),
    ).resolves.toBeUndefined();

    expect(upsertCalls).toHaveLength(1);
  });
});
