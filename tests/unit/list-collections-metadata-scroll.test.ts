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
/** Scroll attempts (1-based) that should throw, to exercise retry and failure. */
let failAttempts = new Set<number>();
/** When true the backend keeps handing back the cursor it was given. */
let stallCursor = false;
let attempt = 0;

vi.mock("../../src/services/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/services/qdrant-client-compat.js", () => ({
  ensureQdrantClientCompatibility: vi.fn(),
}));

/**
 * Qdrant's `next_page_offset` is an opaque point id, not an index. The fake
 * mints string cursors so nothing under test can quietly depend on arithmetic
 * that only works for numbers.
 */
function cursorFor(index: number): string {
  return `point-${index}`;
}

function indexFromCursor(offset: unknown): number {
  if (typeof offset !== "string") return 0;
  return Number.parseInt(offset.slice("point-".length), 10);
}

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: class {
    async getCollections() {
      return {
        collections: [{ name: "codebase_realone" }, { name: "socraticode_metadata" }],
      };
    }
    async scroll(_name: string, opts: ScrollOptions) {
      scrollCalls.push(opts);
      attempt++;
      if (failAttempts.has(attempt)) {
        throw new Error(`scroll attempt ${attempt} failed`);
      }
      const limit = opts.limit ?? 100;
      const start = indexFromCursor(opts.offset);
      const page = metadataPoints.slice(start, start + limit);
      const end = start + limit;
      const next = stallCursor
        ? (opts.offset ?? cursorFor(0))
        : end < metadataPoints.length
          ? cursorFor(end)
          : null;
      // Mirror Qdrant's contract: honour the payload projection, so a test that
      // reads a field the caller did not ask for sees it absent.
      const include =
        opts.with_payload && typeof opts.with_payload === "object"
          ? ((opts.with_payload as { include?: string[] }).include ?? null)
          : null;
      return {
        points: page.map((pt) => ({
          id: pt.id,
          payload:
            include === null
              ? pt.payload
              : Object.fromEntries(include.map((k) => [k, pt.payload[k]])),
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
  failAttempts = new Set();
  stallCursor = false;
  attempt = 0;
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
        Array.from({ length: 3 }, (_, i) => [`src/file${i}.ts`, `hash-${id}-${i}`]),
      ),
    },
  };
}

describe("listCodebaseCollections metadata scroll", () => {
  it("returns entries beyond the first page", async () => {
    // 2500 points against a page size of 1000: everything past the first
    // thousand is only reachable by following the cursor.
    metadataPoints = Array.from({ length: 2500 }, (_, i) =>
      metadataPoint(i, i % 2 === 0 ? `codegraph_p${i}` : `context_p${i}`),
    );

    const { listCodebaseCollections } = await import("../../src/services/qdrant.js");
    const result = await listCodebaseCollections();

    expect(result).toContain("codegraph_p0");
    expect(result).toContain("context_p1499"); // second page
    expect(result).toContain("context_p2499"); // third page
    expect(scrollCalls).toHaveLength(3);
    // Every metadata entry, plus the one real collection from getCollections().
    expect(result).toHaveLength(2501);
  });

  it("skips a point whose collectionName is not a string, instead of throwing", async () => {
    // Optional chaining guards null and undefined but not a wrong type, so a
    // payload holding a number here reached `.startsWith` and threw — taking
    // out a read-only listing over one malformed point.
    metadataPoints = [
      { id: 0, payload: { collectionName: 42 } },
      { id: 1, payload: {} },
      metadataPoint(2, "codegraph_good"),
    ];

    const { listCodebaseCollections } = await import("../../src/services/qdrant.js");
    const result = await listCodebaseCollections();

    expect(result).toContain("codegraph_good");
    expect(result).toHaveLength(2); // the real collection, plus the good entry
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
  it("retries a transient page failure instead of truncating the list", async () => {
    // Paging multiplies the requests that can fail, so one blip mid-scroll must
    // not silently shorten a list callers read as complete. Every other scroll
    // in qdrant.ts is wrapped in withRetry; this one is too.
    metadataPoints = Array.from({ length: 2500 }, (_, i) => metadataPoint(i, `codegraph_p${i}`));
    failAttempts = new Set([2]); // first attempt at the second page

    const { listCodebaseCollections } = await import("../../src/services/qdrant.js");
    const result = await listCodebaseCollections();

    expect(result).toHaveLength(2501);
    expect(result).toContain("codegraph_p2499");
    expect(scrollCalls).toHaveLength(4); // three pages, one retried
  }, 20_000);

  it("returns what it has when a page fails for good, without throwing", async () => {
    // Still non-fatal: the collections found before the metadata scroll stand.
    metadataPoints = Array.from({ length: 2500 }, (_, i) => metadataPoint(i, `codegraph_p${i}`));
    failAttempts = new Set([2, 3, 4]); // exhaust withRetry on the second page

    const { listCodebaseCollections } = await import("../../src/services/qdrant.js");
    const result = await listCodebaseCollections();

    expect(result).toContain("codebase_realone");
    expect(result).toContain("codegraph_p0"); // first page survived
    expect(result).not.toContain("codegraph_p2499");
  }, 20_000);

  it("stops when the cursor stops advancing", async () => {
    // An unbounded cursor loop cannot be caught — an infinite loop never throws
    // — and auto-resume is not awaited, so this would hang with nothing logged
    // and no project ever resumed.
    metadataPoints = Array.from({ length: 2500 }, (_, i) => metadataPoint(i, `codegraph_p${i}`));
    stallCursor = true;

    const { listCodebaseCollections } = await import("../../src/services/qdrant.js");
    const result = await listCodebaseCollections();

    expect(scrollCalls).toHaveLength(2); // first page, then the stall is caught
    expect(result).toContain("codegraph_p0");
  }, 20_000);
});
