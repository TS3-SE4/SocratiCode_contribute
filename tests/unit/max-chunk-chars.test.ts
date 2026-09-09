// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
//
// MAX_CHUNK_CHARS caps every chunk regardless of chunking strategy, and the cap
// is where chunks are split rather than where they are cut short: a chunk over
// the cap becomes as many chunks as it needs, on every path. A lower cap
// therefore yields more chunks, never less indexed content.
//
// It did truncate on three of the four paths, and that dropped content outright
// — no vector, no payload, no BM25 text, so no search could retrieve it. Several
// cases below exist to keep that from coming back.
//
// MAX_CHUNK_CHARS is read once at module load in src/constants.ts, so each case
// resets the module cache and re-imports to make the env-var IIFE run again.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEY = "MAX_CHUNK_CHARS";

describe("MAX_CHUNK_CHARS", () => {
  const original = process.env[ENV_KEY];

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = original;
    }
    vi.resetModules();
  });

  describe("default — backwards compatibility", () => {
    it("is 2000 when the variable is unset", async () => {
      delete process.env[ENV_KEY];
      const { MAX_CHUNK_CHARS } = await import("../../src/constants.js");
      expect(MAX_CHUNK_CHARS).toBe(2000);
    });

    it("is 2000 when the variable is empty", async () => {
      process.env[ENV_KEY] = "";
      const { MAX_CHUNK_CHARS } = await import("../../src/constants.js");
      expect(MAX_CHUNK_CHARS).toBe(2000);
    });
  });

  describe("override", () => {
    it("accepts a smaller cap for short-context models", async () => {
      process.env[ENV_KEY] = "600";
      const { MAX_CHUNK_CHARS } = await import("../../src/constants.js");
      expect(MAX_CHUNK_CHARS).toBe(600);
    });

    // Not "a cap for long-context models": 8000 is past the effective embedding
    // limit of the default provider (nomic-embed-text at CHARS_PER_TOKEN_ESTIMATE=1.0
    // and a 2048-token context), so the provider pre-truncates and the characters
    // past that point reach the payload and the BM25 text but not the vector.
    // Validation is deliberately lower-bound only — see src/constants.ts.
    it("accepts a cap above the default provider's effective embedding limit", async () => {
      process.env[ENV_KEY] = "8000";
      const { MAX_CHUNK_CHARS } = await import("../../src/constants.js");
      expect(MAX_CHUNK_CHARS).toBe(8000);
    });

    // 1 is the smallest value validation allows, not a usable one: prepareDocumentText
    // prepends the document prefix, the path and a newline, so the embedded text
    // is essentially that header alone.
    it("accepts 1, the smallest value validation allows", async () => {
      process.env[ENV_KEY] = "1";
      const { MAX_CHUNK_CHARS } = await import("../../src/constants.js");
      expect(MAX_CHUNK_CHARS).toBe(1);
    });

    it("accepts scientific notation that resolves to an integer", async () => {
      process.env[ENV_KEY] = "2e3";
      const { MAX_CHUNK_CHARS } = await import("../../src/constants.js");
      expect(MAX_CHUNK_CHARS).toBe(2000);
    });
  });

  describe("validation — a bad value fails at load, not mid-index", () => {
    for (const bad of ["0", "-100", "abc", "1.5", " ", "1_000"]) {
      it(`rejects ${JSON.stringify(bad)}`, async () => {
        process.env[ENV_KEY] = bad;
        await expect(import("../../src/constants.js")).rejects.toThrow(
          /Invalid MAX_CHUNK_CHARS/,
        );
      });
    }

    it("names the offending value and the default in the message", async () => {
      process.env[ENV_KEY] = "nope";
      const err = await import("../../src/constants.js").then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toContain('"nope"');
      expect(err?.message).toContain("2000");
    });
  });

  describe("the cap is what chunking actually applies", () => {
    it("splits an over-long chunk at the configured cap", async () => {
      process.env[ENV_KEY] = "120";
      const { chunkFileContent } = await import("../../src/services/indexer.js");
      // A single 500-char line has an average line length of exactly
      // MAX_AVG_LINE_LENGTH, so the minified heuristic (avgLineLength > 500) does
      // not fire: this takes the small-file single-chunk branch, where the cap
      // used to truncate and now splits.
      const long = "x".repeat(500);
      const chunks = chunkFileContent("/tmp/notes.txt", "notes.txt", long);
      // Every character survives, in order, across as many chunks as the cap needs.
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.map((c) => c.content).join("")).toBe(long);
      for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(120);
    });

    it("keeps the same content in total whatever the cap is", async () => {
      // The regression test for the truncation bug: the cap decides how the
      // content is divided, never how much of it is kept. 62 short lines sit
      // below CHUNK_SIZE and well below MAX_AVG_LINE_LENGTH, so this takes the
      // small-file single-chunk branch, which is where truncation used to bite.
      const body = ["function a() {", ...Array.from({ length: 60 }, (_, i) => `  const v${i} = ${i};`), "}"].join("\n");

      const totalAt = async (cap: string) => {
        process.env[ENV_KEY] = cap;
        vi.resetModules();
        const { chunkFileContent } = await import("../../src/services/indexer.js");
        return chunkFileContent("/tmp/sample.txt", "sample.txt", body)
          .reduce((n, c) => n + c.content.length, 0);
      };

      // 200 splits the body into several chunks, 4000 leaves it whole. Both hold
      // every character of it. The split adds no characters either — the pieces
      // are slices, so the totals match exactly rather than merely both being
      // "at least body.length".
      expect(await totalAt("200")).toBe(body.length);
      expect(await totalAt("4000")).toBe(body.length);
    });

    it("does not leave a short remainder at the end of a split", async () => {
      // Filling each piece to the cap leaves whatever is left over as the last
      // piece, and that remainder can be a couple of characters — a chunk with
      // its own vector that says nothing about the code around it. 2002
      // characters against a 2000 cap is the worst case for that: two pieces of
      // about 1001, not 2000 and 2.
      const { splitTextToCharCap } = await import("../../src/services/chunk-split.js");

      const content = "x".repeat(2002);
      const pieces = splitTextToCharCap(content, 2000);

      expect(pieces).toHaveLength(2);
      expect(pieces.map((p) => p.text).join("")).toBe(content);
      // The two are within one character of each other, rather than 2000 and 2.
      const lengths = pieces.map((p) => p.text.length);
      expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(1);
    });

    it("stops the boundary scan before it produces a very short piece", async () => {
      // chunkByCharacters scanned back to the start of the window, so a single
      // separator early in a window produced a piece of that length — 101
      // characters against a 600 cap in the worst case found. The scan now
      // stops at BOUNDARY_SCAN_RATIO of the target and splits at the target if
      // it finds nothing.
      const { splitTextToCharCap } = await import("../../src/services/chunk-split.js");

      // The only separator sits at index 100, far outside the last fifth of a
      // 600-character window.
      const content = `${"a".repeat(100)} ${"b".repeat(1700)}`;
      const pieces = splitTextToCharCap(content, 600);

      expect(pieces.map((p) => p.text).join("")).toBe(content);
      for (const p of pieces) {
        expect(p.text.length).toBeLessThanOrEqual(600);
        // Nothing anywhere near the 101-character piece the unbounded scan gave.
        expect(p.text.length).toBeGreaterThan(600 * 0.5);
      }
    });

    it("gives every piece of a split chunk a distinct id", async () => {
      // Continuation ids are seeded from the parent id, not from (path, startLine):
      // on a single-line minified file every chunk reports startLine 1, so ids
      // re-derived from the line number would collide and Qdrant's upsert would
      // silently keep only the last one.
      process.env[ENV_KEY] = "200";
      const { chunkFileContent } = await import("../../src/services/indexer.js");

      // One long line, no newline anywhere: avgLineLength >> 500 selects the
      // minified path, and every chunk it emits carries startLine 1.
      const oneLine = "abcdefghij".repeat(400); // 4000 chars, 1 line
      const chunks = chunkFileContent("/tmp/bundle.min.js", "bundle.min.js", oneLine);

      expect(chunks.length).toBeGreaterThan(1);
      expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
      for (const c of chunks) {
        expect(c.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      }
    });

    it("never accepts the character at the limit as a boundary", async () => {
      // The backwards scan used to start at the limit itself rather than one
      // before it, so a boundary character sitting exactly there produced a
      // piece of cap + 1. Truncation hid that; splitting would turn the
      // overflow into a one-character chunk with its own vector.
      //
      // This calls the splitter directly. Going through chunkFileContent no
      // longer reaches the case: the even division makes the first window
      // smaller than the cap, so nothing lands on the limit.
      const { splitTextToCharCap } = await import("../../src/services/chunk-split.js");

      // 200 characters exactly, with a comma at index 100 — the limit of the
      // first window when the text divides into two pieces of 100.
      const content = `${"x".repeat(100)},${"y".repeat(99)}`;
      const pieces = splitTextToCharCap(content, 100);

      for (const p of pieces) expect(p.text.length).toBeLessThanOrEqual(100);
      expect(pieces.map((p) => p.text).join("")).toBe(content);
    });

    it("does not let a minified chunk claim a line the file does not have", async () => {
      // A trailing newline was counted as opening another line, so endLine — and
      // through currentLine, every subsequent startLine — drifted one further
      // ahead per chunk that ended on a newline. This was already wrong before
      // the cap started splitting: on v1.13.1, six 600-character lines at a
      // 1300 cap produce chunks claiming lines 1-3, 4-6 and 7-9, and the file
      // has six lines.
      process.env[ENV_KEY] = "1300";
      const { chunkFileContent } = await import("../../src/services/indexer.js");

      // avgLineLength of 601 selects the minified path, where this drift shows.
      const lines = Array.from({ length: 6 }, () => "x".repeat(600));
      const content = `${lines.join("\n")}\n`;
      const chunks = chunkFileContent("/tmp/bundle.min.js", "bundle.min.js", content);

      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(c.startLine).toBeLessThanOrEqual(lines.length);
        expect(c.endLine).toBeLessThanOrEqual(lines.length);
      }
      // Each chunk holds two of the six lines, in order, with no gap.
      expect(chunks.map((c) => `${c.startLine}-${c.endLine}`)).toEqual(["1-2", "3-4", "5-6"]);
    });

    it("never splits a CRLF between the carriage return and the newline", async () => {
      // CRLF is one line ending, not two characters to divide. Cutting between
      // them leaves a stray "\r" at the end of one piece and starts the next
      // with a bare "\n", which reads as a blank line the file does not have.
      // Reachable only where no boundary was found and the split landed at the
      // target, which a small cap makes common.
      const { splitTextToCharCap } = await import("../../src/services/chunk-split.js");

      const content = `${Array(12).fill("const value = compute(a, b);").join("\r\n")}\r\n`;

      for (let cap = 1; cap <= 60; cap++) {
        const pieces = splitTextToCharCap(content, cap);

        for (let i = 0; i < pieces.length - 1; i++) {
          const dividedLineEnding =
            pieces[i].text.endsWith("\r") && pieces[i + 1].text.startsWith("\n");
          expect(dividedLineEnding).toBe(false);
        }
        expect(pieces.map((p) => p.text).join("")).toBe(content);
      }
    });

    it("never splits between the halves of a surrogate pair", async () => {
      // JavaScript strings are UTF-16 code units, so a character outside the
      // BMP takes two of them. Cutting between them leaves a lone surrogate at
      // the end of one piece and another at the start of the next, and both
      // become U+FFFD by the time they reach the embedding request.
      const { splitTextToCharCap } = await import("../../src/services/chunk-split.js");

      // The emoji straddles the split: 99 characters, then a surrogate pair,
      // then filler, with no boundary character anywhere to scan back to.
      const content = `${"x".repeat(99)}\u{1F600}${"y".repeat(299)}`;
      const pieces = splitTextToCharCap(content, 100);

      expect(pieces.map((p) => p.text).join("")).toBe(content);
      for (const p of pieces) {
        // A lone surrogate does not survive a UTF-8 round trip.
        expect(Buffer.from(p.text, "utf8").toString("utf8")).toBe(p.text);
      }
    });

    it("keeps the line numbers of a split chunk pointing at its own lines", async () => {
      // Truncation left the parent claiming lines it no longer held. Splitting
      // rebases each piece onto the parent's startLine instead.
      process.env[ENV_KEY] = "300";
      const { chunkFileContent } = await import("../../src/services/indexer.js");

      // 40 lines of 100 characters: 4000 chars over 40 lines keeps the average
      // line length at 100, below MAX_AVG_LINE_LENGTH, so this is the small-file
      // path rather than the minified one.
      const lines = Array.from({ length: 40 }, (_, i) => `${String(i + 1).padStart(3, "0")}${"z".repeat(96)}`);
      const chunks = chunkFileContent("/tmp/wide.txt", "wide.txt", lines.join("\n"));

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].startLine).toBe(1);
      expect(chunks[chunks.length - 1].endLine).toBe(lines.length);
      for (const c of chunks) {
        expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
        expect(c.endLine).toBeLessThanOrEqual(lines.length);
        // The first line of each chunk is the file line its startLine names.
        const firstLine = c.content.split("\n")[0];
        if (firstLine.length === 100) expect(firstLine).toBe(lines[c.startLine - 1]);
      }
    });

    // The minified/bundled path (chunkByCharacters) reaches the cap through its
    // own splitting rather than through splitToCharCap, so it is covered
    // separately. Four lines of 3000 characters put the average line length
    // above MAX_AVG_LINE_LENGTH (500) and so select it.
    it("splits minified content into more chunks as the cap falls", async () => {
      const minified = Array.from({ length: 4 }, () => "x".repeat(3000)).join("\n");

      process.env[ENV_KEY] = "3000";
      vi.resetModules();
      const wide = await import("../../src/services/indexer.js");
      const wideChunks = wide.chunkFileContent("/tmp/bundle.js", "bundle.js", minified);

      process.env[ENV_KEY] = "500";
      vi.resetModules();
      const narrow = await import("../../src/services/indexer.js");
      const narrowChunks = narrow.chunkFileContent("/tmp/bundle.js", "bundle.js", minified);

      expect(wideChunks.length).toBeGreaterThan(0);
      expect(narrowChunks.length).toBeGreaterThan(wideChunks.length);
      for (const c of narrowChunks) {
        expect(c.content.length).toBeLessThanOrEqual(500);
      }
    });
  });
});
