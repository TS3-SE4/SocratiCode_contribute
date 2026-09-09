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
 * Where a split may land, strongest boundary first.
 *
 * Treating every candidate as equally good puts splits in the middle of
 * statements: a scan that accepts the first space it walks back onto will cut
 * `const x = compute(a, b)` after `compute(a,` when a blank line sat a hundred
 * characters earlier. So the scan tries each tier in turn and takes the first
 * one present in the window, which keeps the piece boundary on the strongest
 * structural break available — the same escalation the widely used recursive
 * character splitters make (paragraph, then line, then word).
 *
 * Each entry is matched against the text *ending* at the candidate index, so
 * multi-character boundaries work: "\n\n" means the split lands after a blank
 * line, not merely after some newline.
 */
interface Boundary {
  /** The text to look for, matched as ending at the candidate index. */
  match: string;
  /**
   * Where to cut relative to the match. `"after"` keeps the match with the
   * piece that ends there — right for anything that closes a unit, like a blank
   * line or a closing bracket. `"before"` sends it to the next piece, which is
   * what an opener needs: a heading belongs to the section it introduces, so
   * cutting after `\n#` would leave one `#` stranded at the end of the piece
   * before it.
   */
  cut: "before" | "after" | "line-end";
  /**
   * Accept the match only where a fenced code block opens.
   *
   * A code fence is the same three characters opening a block and closing one,
   * and the closing one is not an opener: cutting before it puts a bare fence
   * at the start of the next piece and ends the current one inside the block —
   * the mirror image of the stranded `#` that `cut: "before"` exists to avoid.
   *
   * An opening fence is told apart by its info string (```` ```ts ````), which a
   * closing fence never has — CommonMark lets a closing fence be followed by
   * spaces or tabs, so those do not count as one. Counting fences instead would
   * need the whole file, and this function is handed one chunk: a window that
   * begins inside a code block would have its parity inverted and read every
   * closing fence as an opener.
   */
  opensFence?: true;
}

/** Shorthand for a boundary the split lands after. */
const after = (match: string): Boundary => ({ match, cut: "after" });

/** Shorthand for a boundary the split lands before, so the match opens the next piece. */
const before = (match: string): Boundary => ({ match, cut: "before" });

/**
 * Shorthand for a boundary whose whole line stays with the piece that ends
 * there.
 *
 * `after` cuts immediately past the match, which splits the line whenever the
 * match is not the whole of it: `after("\n}")` ends a piece between the `}` and
 * the `;` of `});`, and `after("\n---")` between the third and fourth dash of
 * `-----`. These boundaries mean "this line closes a unit", so the unit is the
 * line.
 */
const lineEnd = (match: string): Boundary => ({ match, cut: "line-end" });

/** One rank of boundaries, and how far the scan may travel to find one. */
interface BoundaryTier {
  /**
   * How far back from the target a boundary in this tier may be found, as a
   * fraction of the target size.
   *
   * A single distance for every tier forces a choice between two bad outcomes:
   * a short one means a heading two thirds of the way through the window is
   * never found, and a long one lets a stray space near the window's start
   * produce a piece a fraction of the target size. So each tier carries its own
   * reach — a strong structural break is worth travelling for, a word boundary
   * is not.
   *
   * The reach belongs to the tier and not to its position in the list, so
   * inserting a rank above another one does not silently shorten what the lower
   * one can reach. A blank line reaches half the target in every language, even
   * where three ranks sit above it.
   */
  reach: number;
  /**
   * The boundaries of this rank, which must all be equally good places to
   * split: within one tier the scan takes whichever sits closest to the target,
   * and where two match at the same index, array order decides. Anything that
   * should outrank another belongs in a tier of its own — a period followed by
   * a space cannot share a tier with a bare space, because every match of the
   * former is also a match of the latter at the same index, so the pair would
   * never change a split point.
   */
  boundaries: readonly Boundary[];
}

const BOUNDARY_TIERS: readonly BoundaryTier[] = [
  // A paragraph, or a block within a function. "\n\r\n" is the same blank line
  // under CRLF: without it this tier never matches in a CRLF file and the
  // strongest break silently drops to the newline tier's shorter reach.
  { reach: 0.5, boundaries: [after("\n\n"), after("\n\r\n")] },
  // The end of a block.
  { reach: 0.5, boundaries: [lineEnd("\n}"), lineEnd("\n)"), lineEnd("\n]")] },
  // Any newline.
  { reach: 0.35, boundaries: [after("\n")] },
  // The end of a statement. `.` is deliberately absent: in code it sits inside
  // a member chain far more often than it ends anything, so ranking it here
  // would split `config.value` in two while a space was available.
  { reach: 0.2, boundaries: [after(";")] },
  // A word boundary.
  { reach: 0.2, boundaries: [after(" "), after("\t"), after(",")] },
];

/**
 * The same escalation for Markdown, where the structural breaks are different:
 * a heading or a fenced code block is a far better place to divide prose than a
 * blank line inside a paragraph.
 */
const MARKDOWN_BOUNDARY_TIERS: readonly BoundaryTier[] = [
  // A heading, which opens the section it names. A `#` inside a fenced code
  // block is matched too — telling those apart needs the whole file, which this
  // function is not handed. The cost is a seam inside a code block, not lost
  // content.
  { reach: 0.5, boundaries: [before("\n#")] },
  // The start of a fenced code block, so the fence and its body stay together.
  { reach: 0.5, boundaries: [{ match: "\n```", cut: "before", opensFence: true }] },
  // A horizontal rule.
  { reach: 0.5, boundaries: [lineEnd("\n---"), lineEnd("\n***"), lineEnd("\n___")] },
  // A paragraph, under either line ending.
  { reach: 0.5, boundaries: [after("\n\n"), after("\n\r\n")] },
  // The start of a list item or a table row.
  { reach: 0.35, boundaries: [before("\n- "), before("\n* "), before("\n| ")] },
  // Any newline.
  { reach: 0.35, boundaries: [after("\n")] },
  // The end of a sentence. Here `.` does end a unit, but only when a space
  // follows it, which keeps version numbers intact. It ranks above a bare space
  // rather than beside one: sharing a tier would make it dead weight, since the
  // space inside ". " matches at the same index.
  { reach: 0.2, boundaries: [after(". ")] },
  // A word boundary.
  { reach: 0.2, boundaries: [after(" "), after("\t")] },
];

/**
 * Languages whose structure is prose-with-markup rather than code.
 *
 * `.mdx` maps to `markdown` in getLanguageFromExtension, so it arrives here
 * under that name and needs no entry of its own.
 */
const MARKUP_LANGUAGES = new Set(["markdown"]);

/** Pick the boundary tiers that suit the text's language. */
function boundaryTiersFor(language: string | undefined): readonly BoundaryTier[] {
  return language && MARKUP_LANGUAGES.has(language)
    ? MARKDOWN_BOUNDARY_TIERS
    : BOUNDARY_TIERS;
}

/**
 * Find the split point for one piece: the strongest boundary inside the scan
 * window, or `limit` when the window holds none.
 *
 * Returns the index one past the boundary, so the boundary itself stays with
 * the piece that ends there.
 */
function findSplitPoint(
  content: string,
  offset: number,
  limit: number,
  targetSize: number,
  tiers: readonly BoundaryTier[],
): number {
  for (const { reach, boundaries } of tiers) {
    const floor = offset + Math.floor(targetSize * (1 - reach));
    // Walk back from the limit so the piece stays as close to the target size
    // as the tier allows. The floor is inclusive: a boundary ending exactly at
    // the tier's reach is within it, and excluding it loses a blank line that
    // happens to sit on the boundary — which is where paragraph breaks land
    // when the text divides evenly.
    for (let i = limit - 1; i >= floor; i--) {
      for (const { match, cut, opensFence } of boundaries) {
        const start = i - match.length + 1;
        if (start <= offset || !content.startsWith(match, start)) continue;
        // An opening fence carries an info string; a closing fence is bare.
        // CommonMark allows a closing fence to be followed by spaces or tabs,
        // so the test is whether the rest of the line holds anything else. A
        // longer run of backticks is a fence of its own, not an info string.
        if (opensFence) {
          const lineBreak = content.indexOf("\n", i + 1);
          const info = content.slice(i + 1, lineBreak === -1 ? undefined : lineBreak);
          if (info.includes("`") || info.trim().length === 0) continue;
        }
        const point = splitPointFor(content, cut, start, i, limit);
        // Below the offset the piece would be empty; above the limit it would
        // exceed the target. Either way this candidate is unusable, but a
        // weaker one further back may still serve.
        if (point > offset && point <= limit) return point;
      }
    }
  }
  return limit;
}

/**
 * Where a match turns into a split point.
 *
 * `end` is the index of the match's last character, `start` of its first.
 */
function splitPointFor(
  content: string,
  cut: Boundary["cut"],
  start: number,
  end: number,
  limit: number,
): number {
  // "before" cuts at the character after the match's leading newline, so the
  // match itself opens the next piece.
  if (cut === "before") return start + 1;
  if (cut === "after") return end + 1;
  // "line-end": take the rest of the line with this piece. A line that runs
  // past the limit yields a point the caller rejects, which is what should
  // happen — keeping the line whole matters more than using this boundary.
  const newline = content.indexOf("\n", end + 1);
  if (newline === -1) return content.length;
  return newline + 1 > limit ? limit + 1 : newline + 1;
}

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
 * concatenating `text` across the result reproduces the input.
 *
 * Splits land on the strongest structural boundary the scan window offers — a
 * blank line before a mere newline, a newline before a space — so a piece tends
 * to end where the text itself divides. `language` selects the boundary set;
 * Markdown gets headings and code fences ahead of blank lines. When the window
 * holds no boundary at all, the split happens at the target size, which is the
 * only case where an identifier can be cut in half.
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
export function splitTextToCharCap(
  content: string,
  maxChunkChars: number,
  language?: string,
): TextPiece[] {
  // A cap below 1 would leave `end` equal to `offset` and loop forever emitting
  // empty pieces. The env-var path cannot reach this (constants.ts and
  // parseEffectiveIndexProfile both reject it), but chunkFileContent and
  // chunkArtifactContent take the cap as an argument and are exported.
  if (!Number.isInteger(maxChunkChars) || maxChunkChars < 1) {
    throw new Error(`maxChunkChars must be a positive integer, got ${maxChunkChars}`);
  }

  const pieces: TextPiece[] = [];
  const tiers = boundaryTiersFor(language);
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

    const limit = Math.min(offset + targetSize, content.length);

    // Look for the strongest boundary in the window. The scan starts one before
    // the limit, since content[limit] is the first character past the window and
    // accepting it would make the piece targetSize + 1 long.
    let end =
      limit < content.length
        ? findSplitPoint(content, offset, limit, targetSize, tiers)
        : limit;

    // Two pairs of code units must not be divided, and both can only be cut
    // between when no boundary was found and the split landed at the target.
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
