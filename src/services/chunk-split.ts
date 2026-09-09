// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { createHash } from "node:crypto";

/**
 * Splitting text at the per-chunk character cap, and the chunk ids that split
 * produces.
 *
 * Shared by the two chunkers — `chunkFileContent` for source files and
 * `chunkArtifactContent` for context artifacts — which both cut by line count
 * and then have to honour a cap counted in characters. It lives in its own
 * module because indexer.ts already imports context-artifacts.ts, so the shared
 * helper cannot live in either of them.
 */

/**
 * How far back from the hard limit the scan may look for a safe split boundary,
 * as a fraction of the window. Past this point the split happens at the limit:
 * a boundary found much earlier would leave a chunk short enough that its
 * embedding says little about the code around it.
 */
const BOUNDARY_SCAN_RATIO = 0.2;

/** Characters a split may land on without cutting an identifier in half. */
const SAFE_BOUNDARIES = new Set(["\n", " ", "\t", ";", ","]);

/** Format a sha256 digest as a valid UUID (required by Qdrant): 8-4-4-4-12 */
export function uuidFromSeed(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Derive the id of a continuation piece from the id of the chunk it was split
 * out of.
 *
 * Seeded from the parent id rather than from the position it starts at, because
 * position does not identify a chunk on every path: `chunkByCharacters` gives
 * every chunk of a single-line minified file the same startLine, and an
 * artifact chunk is identified by the line its parent began on. Re-deriving
 * from position would collide across the continuations of one parent, and
 * Qdrant's upsert would silently keep only the last. Seeding from the parent id
 * is unique wherever the parent is.
 */
export function continuationId(parentId: string, part: number): string {
  // NUL separates the two fields: it cannot occur in a UUID, so no two
  // (parentId, part) pairs can produce the same seed.
  return uuidFromSeed(`${parentId}\u0000${part}`);
}

/** One piece of a split. Line numbers are 1-based within the text given. */
export interface TextPiece {
  text: string;
  startLine: number;
  endLine: number;
}

/**
 * Split text into pieces of at most `maxChunkChars` characters — one more only
 * where a surrogate pair or a CRLF would otherwise be divided.
 *
 * Every character of the input appears in exactly one piece, in order:
 * concatenating `text` across the result reproduces the input. Splits land on
 * whitespace or a separator when one falls within the scan window, so
 * identifiers are usually not cut in half; when none does, the split happens at
 * the target.
 *
 * Pieces come out roughly equal in size rather than "cap-sized until the
 * remainder". Filling each piece to the cap leaves whatever is left over as the
 * last piece, and that remainder can be a couple of characters — a real chunk
 * with its own vector, saying nothing about the code around it. So the number
 * of pieces is decided first (`ceil(length / cap)`) and the target size is the
 * length divided by that, which is never above the cap.
 *
 * Text at or below the cap comes back as a single piece, so callers can use
 * this unconditionally.
 */
export function splitTextToCharCap(content: string, maxChunkChars: number): TextPiece[] {
  // A cap below 1 would leave `end` equal to `offset` and loop forever emitting
  // empty pieces. The env-var path cannot reach this (constants.ts and
  // parseEffectiveIndexProfile both reject it), but chunkFileContent and
  // chunkArtifactContent take the cap as an argument and are exported.
  if (!Number.isInteger(maxChunkChars) || maxChunkChars < 1) {
    throw new Error(`maxChunkChars must be a positive integer, got ${maxChunkChars}`);
  }

  const pieces: TextPiece[] = [];
  let offset = 0;
  let currentLine = 1;

  while (offset < content.length) {
    // Re-divide what is left on every pass: ceil(remaining / cap) pieces of
    // ceil(remaining / pieces) characters. Computing the target once up front
    // is not enough — a boundary scan that moves a split earlier shortens that
    // piece and lengthens the rest, and those shifts accumulate into a short
    // final piece. Dividing the remainder each time absorbs them.
    //
    // targetSize never exceeds the cap: remaining <= pieces * cap by the
    // definition of pieces, so remaining / pieces <= cap.
    const remaining = content.length - offset;
    const remainingPieces = Math.max(1, Math.ceil(remaining / maxChunkChars));
    const targetSize = Math.max(1, Math.ceil(remaining / remainingPieces));

    let end = Math.min(offset + targetSize, content.length);

    // Scan backwards from the target for a safe boundary; if none is found
    // within the window, fall through and split at the target.
    //
    // Start at `end - 1`, not `end`: content[end] is the first character past
    // the window, so accepting it would make the piece targetSize + 1 long.
    if (end < content.length) {
      const scanFloor = offset + Math.floor(targetSize * (1 - BOUNDARY_SCAN_RATIO));
      for (let i = end - 1; i > scanFloor; i--) {
        if (SAFE_BOUNDARIES.has(content[i])) {
          end = i + 1;
          break;
        }
      }
    }

    // Two pairs of code units must not be divided.
    //
    // A surrogate pair: JavaScript strings are UTF-16 code units, so a
    // character outside the BMP — an emoji, some CJK extensions — occupies two
    // of them, and cutting between them leaves a lone surrogate at the end of
    // one piece and another at the start of the next. Both become U+FFFD by the
    // time the text reaches the embedding request and the stored payload.
    // Truncation had the same flaw but broke only the kept side; splitting
    // would break both, at every split point.
    //
    // A CRLF: it is one line ending, not two characters to divide. Cutting
    // between them leaves a stray carriage return at the end of one piece and
    // starts the next with a bare newline, which reads as a blank line that is
    // not in the file.
    if (end < content.length) {
      const before = content.charCodeAt(end - 1);
      const after = content.charCodeAt(end);
      const surrogatePair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
      const lineEnding = before === 0x0d && after === 0x0a;
      if (surrogatePair || lineEnding) {
        // Leave the whole pair to the next piece. If that would empty this one,
        // take the pair instead — a piece of targetSize + 1 is better than a
        // loop that never advances.
        end = end - 1 > offset ? end - 1 : end + 1;
      }
    }

    const text = content.slice(offset, end);
    const startLine = currentLine;
    const newlineCount = (text.match(/\n/g) ?? []).length;
    // A trailing newline closes the last line the piece holds; it does not open
    // another one.
    const endsWithNewline = text.endsWith("\n");
    const endLine = endsWithNewline
      ? Math.max(startLine, startLine + newlineCount - 1)
      : startLine + newlineCount;

    pieces.push({ text, startLine, endLine });

    currentLine = endsWithNewline ? endLine + 1 : endLine;
    offset = end;
  }

  return pieces;
}
