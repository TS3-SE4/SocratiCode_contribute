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
 * It reports four things, each with the raw numerator and denominator so the
 * arithmetic can be checked:
 *
 *   1. Lossless check — the strongest of the four. Concatenating every chunk of
 *      a file must reproduce what an uncapped run produces. Splitting reorders
 *      nothing and invents nothing, so the two strings are identical when no
 *      content is dropped. A mismatch is a defect; the count of mismatching
 *      files is the headline number.
 *   2. Never-indexed characters — how much of the file never reaches any chunk.
 *      Measured per line, against the file's own character count.
 *   3. Chunk counts — what the cap costs in embedding calls.
 *   4. Chunk id collisions — two chunks sharing an id means Qdrant's upsert
 *      keeps only one of them.
 *
 * Read (1) and (2) together. Per-line coverage cannot represent a line split
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

import { readFile, stat } from "node:fs/promises";
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

/** An empty tally for one build. */
function emptyTally() {
  return {
    files: 0,
    minifiedFiles: 0,
    chunks: 0,
    idCollisions: 0,
    mismatchingFiles: 0,
    charsDroppedByConcat: 0,
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
  }

  // (1) Lossless check. Both sides drop chunks with no non-whitespace content —
  // that is a deliberate invariant, not lost content — so those are excluded
  // from the comparison. Without this, a file padded with indented blank lines
  // reads as though the split threw content away.
  const meaningful = (chunks) =>
    chunks.filter((c) => c.content.trim().length > 0).map((c) => c.content).join("");
  const a = meaningful(uncapped);
  const b = meaningful(capped);
  if (a !== b) {
    t.mismatchingFiles += 1;
    t.charsDroppedByConcat += a.length - b.length;
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
  console.log(`  chunk id collisions          ${r.idCollisions}`);
  console.log(`  files losing content         ${r.mismatchingFiles} / ${r.files}`);
  console.log(`  characters dropped           ${r.charsDroppedByConcat}`);
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
try {
  const [distStat, srcStat] = await Promise.all([
    stat(ownIndexer),
    stat(path.join(here, "..", "src", "services", "indexer.ts")),
  ]);
  if (distStat.mtimeMs < srcStat.mtimeMs) {
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
