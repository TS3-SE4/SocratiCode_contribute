// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * `listCodebaseCollections()` enumerates the metadata collection, and both
 * halves of how it did so were wrong.
 *
 * It issued a single `limit: 100` scroll with no cursor, so a deployment with
 * more than a hundred metadata points silently lost every entry past the
 * hundredth — from a list the manage tools present as complete.
 *
 * It also asked for the whole payload to read one string. Metadata points carry
 * the project's entire path-to-hash map, so the request scaled with the size of
 * every indexed repository rather than with the number of projects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ScrollOptions {
  limit?: number;
  offset?: unknown;
  with_payload?: unknown;
  with_vector?: unknown;
}

/** Every scroll issued against the metadata collection, in order. */
let scrollCalls: ScrollOptions[] = [];
/** Metadata points the fake backend holds, paged out `limit` at a time. */
let metadataPoints: Array<{ id: number; payload: Record<string, unknown> }> = [];

vi.mock("../../src/services/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/services/qdrant-client-compat.js", () => ({
  ensureQdrantClientCompatibility: vi.fn(),
}));

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: class {
    async getCollections() {
      return {
        collections: [{ name: "codebase_realone" }, { name: "socraticode_metadata" }],
      };
    }
    async scroll(_name: string, opts: ScrollOptions) {
      scrollCalls.push(opts);
      const limit = opts.limit ?? 100;
      const start = typeof opts.offset === "number" ? opts.offset : 0;
      const page = metadataPoints.slice(start, start + limit);
      const next = start + limit < metadataPoints.length ? start + limit : null;
      // Mirror Qdrant's contract: honour the payload projection, so a test that
      // reads a field the caller did not ask for sees it absent.
      const include =
        opts.with_payload && typeof opts.with_payload === "object"
          ? ((opts.with_payload as { include?: string[] }).include ?? null)
          : null;
      return {
        points: page.map((p) => ({
          id: p.id,
          payload:
            include === null
              ? p.payload
              : Object.fromEntries(include.map((k) => [k, p.payload[k]])),
        })),
        next_page_offset: next,
      };
    }
  },
}));

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  scrollCalls = [];
  metadataPoints = [];
  process.env = {
    ...originalEnv,
    QDRANT_MODE: "external",
    QDRANT_URL: "http://127.0.0.1:6333",
  };
  delete process.env.QDRANT_COLLECTION_PREFIX;
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.clearAllMocks();
});

/** A metadata point of the shape `saveProjectMetadata` writes. */
function metadataPoint(id: number, collectionName: string) {
  return {
    id,
    payload: {
      collectionName,
      projectPath: `/repos/p${id}`,
      // The field that makes the full-payload read expensive: one entry per
      // file in the project.
      fileHashes: Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [`src/file${i}.ts`, `hash-${id}-${i}`]),
      ),
    },
  };
}

describe("listCodebaseCollections metadata scroll", () => {
  it("returns entries beyond the first page", async () => {
    // 250 points against a page size of 100: entries 100..249 are only
    // reachable by following the cursor.
    metadataPoints = Array.from({ length: 250 }, (_, i) =>
      metadataPoint(i, i % 2 === 0 ? `codegraph_p${i}` : `context_p${i}`),
    );

    const { listCodebaseCollections } = await import("../../src/services/qdrant.js");
    const result = await listCodebaseCollections();

    expect(result).toContain("codegraph_p0");
    expect(result).toContain("context_p149"); // second page
    expect(result).toContain("context_p249"); // third page
    expect(scrollCalls.length).toBeGreaterThan(1);
    // Every metadata entry, plus the one real collection from getCollections().
    expect(result).toHaveLength(251);
  });

  it("asks only for the field it reads, not the whole payload", async () => {
    // The point of the projection: metadata payloads carry a hash map per
    // project, so a full read scales with repository size, not project count.
    metadataPoints = [metadataPoint(0, "codegraph_p0")];

    const { listCodebaseCollections } = await import("../../src/services/qdrant.js");
    await listCodebaseCollections();

    expect(scrollCalls).not.toHaveLength(0);
    for (const call of scrollCalls) {
      expect(call.with_payload).toEqual({ include: ["collectionName"] });
      expect(call.with_vector).toBe(false);
    }
  });
});
