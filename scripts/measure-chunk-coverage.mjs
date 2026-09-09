#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Measure how much of a repository's indexable content actually reaches its
 * chunks, and check that the per-chunk character cap loses nothing.
 *
 * Chunking is a pure function of file content, so this needs no Qdrant, no
 * embedding provider and no index — it runs in seconds on a repository that
 * would take an hour to index.
 *
 * Usage:
 *   npm run build                                        # this reads dist/, not src/
 *   node scripts/measure-chunk-coverage.mjs <path to a repository> [cap]
 *
 * It reports seven things. Every figure that is a proportion comes with its
 * numerator and denominator, so the arithmetic can be checked:
 *
 *   1. Lossless check — the strongest of the seven, and exact: concatenating
 *      every chunk of a file must reproduce what an uncapped run produces, byte
 *      for byte. Splitting reorders nothing and invents nothing, so the two
 *      strings are identical when no content is dropped. A mismatch is a
 *      defect; the count of mismatching files is the headline number.
 *   2. Files losing whitespace only — the same comparison, for files whose one
 *      difference is deleted whitespace. Dropping a blank piece is deliberate,
 *      and it drops whitespace from only the capped side, so this is expected
 *      rather than a defect: 14 of this repository's files at a cap of 20.
 *      Counting it apart keeps (1) exact, which matters because a divided CRLF
 *      leaves a stray carriage return and nothing else.
 *   3. Never-indexed characters — how much of the file never reaches any chunk.
 *      Measured per line, against the file's own character count.
 *   4. Chunk counts — what the cap costs in embedding calls.
 *   5. Characters sent to embedding — summed over chunk contents, so
 *      overlapping windows count their shared lines twice. This is the total an
 *      embedding provider is handed, which the per-line coverage in (3) is
 *      deliberately not: do not read one as the other.
 *   6. Chunk size — the median, and how many chunks fall under 1000 characters.
 *      A cap decides how finely content is divided, and dividing it more finely
 *      costs embedding calls without adding content, so these say what a change
 *      to the boundary rules costs. Comparing two builds on this needs
 *      --compare, since the sizes depend on where splits land.
 *   7. Chunk id collisions — two chunks sharing an id means Qdrant's upsert
 *      keeps only one of them.
 *
 * Read (1) and (3) together. Per-line coverage cannot represent a line split
 * across several chunks, so once the cap splits rather than truncates it
 * under-reports: it charges the whole line to the longest single chunk holding
 * part of it. A run showing 0 files losing content and a small non-zero
 * never-indexed figure is that artefact, not lost content — (1) is exact,
 * (3) is a lower bound on coverage.
 *
 * Pass --compare <path to another build's indexer.js> to run both builds over
 * the same bytes: each file is read once and handed to both, so a repository
 * being edited underneath cannot make the two columns disagree. Measuring the
 * two builds in separate runs does not hold that, and the difference is not
 * academic — a repository whose own notes are indexable changes between runs.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const MAX_AVG_LINE_LENGTH = 500; // keep in sync with src/constants.ts

function parseArgs(argv) {
  const positional = [];
  let compare = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--compare") {
      // Without this check a trailing --compare leaves compare undefined and
      // the run silently measures one build, which reads as a comparison.
      if (i + 1 >= argv.length) {
        console.error("--compare needs a path to another build's indexer.js");
        process.exit(2);
      }
      compare = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }
  // rawCap is kept so an error message can name the value the user passed
  // rather than argv[3], which shifts when flags come first.
  return {
    projectPath: positional[0],
    rawCap: positional[1],
    cap: Number(positional[1] ?? 2000),
    compare,
  };
}

/**
 * Per-line character coverage for one file.
 *
 * A chunk that was truncated mid-line contributes only the part it kept, so
 * the maximum across chunks is how much of that line reached the index. Lines
 * shared by overlapping chunks are counted once, which is why this is a
 * coverage measure and not a sum over chunks.
 */
function coveredChars(lines, chunks) {
  const covered = new Array(lines.length).fill(0);
  for (const c of chunks) {
    const chunkLines = c.content.split("\n");
    for (let i = 0; i < chunkLines.length; i++) {
      const lineIndex = c.startLine - 1 + i;
      if (lineIndex < 0 || lineIndex >= covered.length) continue;
      covered[lineIndex] = Math.max(covered[lineIndex], chunkLines[i].length);
    }
  }
  return covered.reduce((n, x, i) => n + Math.min(x, lines[i].length), 0);
}

/**
 * The newest mtime under a directory, or null when it cannot be read.
 *
 * Recursive, since src/ is nested. Only the newest value matters, so nothing is
 * collected.
 */
async function newestMtime(dir) {
  let newest = null;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await newestMtime(full);
      if (nested !== null && (newest === null || nested > newest)) newest = nested;
      continue;
    }
    try {
      const { mtimeMs } = await stat(full);
      if (newest === null || mtimeMs > newest) newest = mtimeMs;
    } catch {
      // Unreadable entry: it cannot make the build stale on its own.
    }
  }
  return newest;
}

/**
 * Whether `b` is `a` with some whitespace deleted and nothing else changed.
 *
 * Walked greedily: every character of `b` must appear in `a` in order, and
 * every character of `a` that `b` skips must be whitespace. That is exactly the
 * shape a dropped blank piece leaves, and it separates "the capped run lost a
 * blank line" from "the capped run lost content".
 */
function isWhitespaceOnlyDeletion(a, b) {
  let i = 0;
  for (let j = 0; j < b.length; j++) {
    while (i < a.length && a[i] !== b[j]) {
      if (!/\s/.test(a[i])) return false;
      i++;
    }
    if (i >= a.length) return false;
    i++;
  }
  while (i < a.length) {
    if (!/\s/.test(a[i])) return false;
    i++;
  }
  return true;
}

/** An empty tally for one build. */
function emptyTally() {
  return {
    files: 0,
    minifiedFiles: 0,
    chunks: 0,
    idCollisions: 0,
    mismatchingFiles: 0,
    charsDroppedByConcat: 0,
    whitespaceOnlyFiles: 0,
    whitespaceDropped: 0,
    chunkChars: 0,
    chunkSizes: [],
    fileChars: 0,
    coveredChars: 0,
    ids: new Set(),
  };
}

const NO_CAP = 1_000_000_000;

/** Fold one file's chunks into a build's tally. */
function tallyFile(t, chunkFileContent, filePath, rel, content, cap) {
  t.files += 1;

  const capped = chunkFileContent(filePath, rel, content, { maxChunkChars: cap });
  const uncapped = chunkFileContent(filePath, rel, content, { maxChunkChars: NO_CAP });

  t.chunks += capped.length;
  for (const c of capped) {
    if (t.ids.has(c.id)) t.idCollisions += 1;
    t.ids.add(c.id);
    // Summed over chunks, so overlapping windows count their shared lines
    // twice. This is what an embedding provider is actually sent, which the
    // per-line coverage below deliberately is not.
    t.chunkChars += c.content.length;
    t.chunkSizes.push(c.content.length);
  }

  // (1) Lossless check, byte for byte. Concatenating a file's chunks must
  // reproduce what an uncapped run produces.
  //
  // Dropping a chunk with no non-whitespace content is a deliberate invariant,
  // not lost content, and excluding those chunks is not symmetric: the uncapped
  // run puts a whole file in one chunk, which trim() never empties, so its
  // whitespace stays, while the capped run loses whatever whitespace formed a
  // blank piece. Normalising whitespace away would hide that difference — and
  // with it any loss of whitespace at all, including the stray carriage return
  // a divided CRLF leaves behind, which this file exists to prevent. So the
  // comparison stays exact and the two kinds of difference are counted apart:
  // a file whose only difference is deleted whitespace is its own figure.
  const meaningful = (chunks) =>
    chunks.filter((c) => c.content.trim().length > 0).map((c) => c.content).join("");
  const a = meaningful(uncapped);
  const b = meaningful(capped);
  if (a !== b) {
    if (isWhitespaceOnlyDeletion(a, b)) {
      t.whitespaceOnlyFiles += 1;
      t.whitespaceDropped += a.length - b.length;
    } else {
      t.mismatchingFiles += 1;
      t.charsDroppedByConcat += a.length - b.length;
    }
  }

  // (2) Never-indexed characters. The minified path splits a single line across
  // chunks, which per-line coverage cannot represent, so it is left out — that
  // path uses the cap as a split boundary and does not drop whole lines.
  const lines = content.split("\n");
  const avgLineLength = lines.length > 0 ? content.length / lines.length : 0;
  if (avgLineLength > MAX_AVG_LINE_LENGTH) {
    t.minifiedFiles += 1;
    return;
  }
  t.fileChars += lines.reduce((n, l) => n + l.length, 0);
  t.coveredChars += coveredChars(lines, capped);
}

function report(label, r) {
  const lost = r.fileChars - r.coveredChars;
  const pct = (a, b) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)} %`);
  console.log(`--- ${label} ---`);
  console.log(`  files chunked                ${r.files} (minified path: ${r.minifiedFiles}, excluded from coverage)`);
  console.log(`  chunks                       ${r.chunks}`);
  console.log(`  characters sent to embedding ${r.chunkChars}   (summed over chunks; overlapping windows counted twice)`);
  const sizes = [...r.chunkSizes].sort((a, b) => a - b);
  // The mean of the two middle values when the count is even, so the figure is
  // the median rather than the upper of the pair.
  const middle = sizes.length / 2;
  const median =
    sizes.length === 0
      ? 0
      : sizes.length % 2 === 1
        ? sizes[Math.floor(middle)]
        : (sizes[middle - 1] + sizes[middle]) / 2;
  const small = sizes.filter((n) => n < 1000).length;
  console.log(`  median chunk                 ${median} characters`);
  console.log(`  chunks under 1000 characters ${small} / ${sizes.length}   ->  ${pct(small, sizes.length)}`);
  console.log(`  chunk id collisions          ${r.idCollisions}`);
  console.log(`  files losing content         ${r.mismatchingFiles} / ${r.files}`);
  console.log(`  characters dropped           ${r.charsDroppedByConcat}   (overlapping windows counted twice)`);
  console.log(`  files losing whitespace only ${r.whitespaceOnlyFiles} / ${r.files}   (${r.whitespaceDropped} characters; blank pieces are dropped deliberately)`);
  console.log(`  characters in files measured ${r.fileChars}   (denominator; newlines and the minified path excluded)`);
  console.log(`  characters reaching a chunk  ${r.coveredChars}   (numerator)`);
  console.log(`  never indexed                ${lost} = ${r.fileChars} - ${r.coveredChars}  ->  ${pct(lost, r.fileChars)}`);
}

const { projectPath, rawCap, cap, compare } = parseArgs(process.argv.slice(2));
if (!projectPath) {
  console.error("usage: node scripts/measure-chunk-coverage.mjs <repository path> [cap] [--compare <other indexer.js>]");
  process.exit(2);
}
// Number() rounds past 2^53, so isInteger accepts a value that is not the one
// asked for and the run would measure a different cap than it reports.
if (!Number.isSafeInteger(cap) || cap < 1) {
  console.error(`cap must be a positive integer, got ${rawCap}`);
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const ownIndexer = path.join(here, "..", "dist", "services", "indexer.js");

// This measures the build, not the sources. Saying so is not enough: a stale
// dist/ silently reports the previous build's numbers, and the whole point of
// this script is that its numbers can be trusted.
//
// The whole of src/ is walked rather than one file. Comparing against
// indexer.ts alone would miss an unbuilt edit to chunk-split.ts, which is where
// the boundary ranking lives — the most likely file to be editing while running
// this.
try {
  const distStat = await stat(ownIndexer);
  const newestSource = await newestMtime(path.join(here, "..", "src"));
  if (newestSource !== null && distStat.mtimeMs < newestSource) {
    console.error("warning: dist/ is older than src/ — run `npm run build` first\n");
  }
} catch {
  // No sources next to dist (an installed package): nothing to compare against.
}
// import() takes a URL, not a filesystem path: a Windows drive letter reads
// as a URL scheme and throws ERR_UNSUPPORTED_ESM_URL_SCHEME. This package
// supports Node >= 18.17 on Windows too.
const { getIndexableFiles, chunkFileContent } = await import(pathToFileURL(ownIndexer).href);

const builds = [];
if (compare) {
  const other = await import(pathToFileURL(path.resolve(compare)).href);
  builds.push({ label: "baseline (--compare)", chunkFileContent: other.chunkFileContent, tally: emptyTally() });
}
builds.push({ label: compare ? "this build" : "chunking", chunkFileContent, tally: emptyTally() });

const files = await getIndexableFiles(projectPath);

// Read each file once and hand the same bytes to every build, so a repository
// being edited underneath cannot make the columns disagree.
// A file that cannot be read is not a file that loses nothing. Skipping it
// silently would let the run report 0 files losing content while never having
// looked at it, which is the one claim this script exists to make.
const unreadable = [];
let measured = 0;
for (const rel of files) {
  const filePath = path.join(projectPath, rel);
  let content;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    unreadable.push({ rel, reason: error instanceof Error ? error.message : String(error) });
    continue;
  }
  measured += 1;
  for (const b of builds) {
    tallyFile(b.tally, b.chunkFileContent, filePath, rel, content, cap);
  }
}

console.log(`repository: ${projectPath}`);
console.log(`cap:        ${cap} characters`);
console.log(`files:      ${measured}${unreadable.length > 0 ? ` measured, ${unreadable.length} unreadable` : ""}`);
if (unreadable.length > 0) {
  // On stderr so a redirected report cannot lose it.
  console.error(`warning: ${unreadable.length} file(s) could not be read and are in no tally below:`);
  for (const { rel, reason } of unreadable) {
    console.error(`  ${rel}: ${reason}`);
  }
  console.error("");
}
for (const b of builds) {
  console.log("");
  report(b.label, b.tally);
}
