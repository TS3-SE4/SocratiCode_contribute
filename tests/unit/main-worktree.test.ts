// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Resolving a linked worktree to its main checkout.
 *
 * A linked worktree carries the same `.socraticode.json` as the repository it
 * belongs to, so it resolves to the same project id and the same collections.
 * Treating it as a project in its own right writes a different file tree into
 * the main checkout's index — pruning files the worktree does not have — and
 * records a project path that vanishes when the worktree is removed.
 *
 * Driven against real `git worktree` checkouts rather than stubs, because the
 * behaviour being relied on is git's, not ours.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mainWorktreePath, projectIdFromPath } from "../../src/config.js";

let root = "";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
}

/** A repository with one commit, plus a linked worktree of it. */
function repoWithWorktree(): { main: string; linked: string } {
  const main = fs.mkdtempSync(path.join(root, "repo-"));
  execFileSync("git", ["init", "-b", "main", main], { stdio: ["pipe", "pipe", "pipe"] });
  git(["config", "user.name", "test"], main);
  git(["config", "user.email", "test@test.com"], main);
  git(["commit", "--allow-empty", "-m", "init"], main);

  const linked = path.join(main, ".worktrees", "feature");
  git(["worktree", "add", "-b", "feature", linked], main);
  return { main, linked };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-worktree-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("mainWorktreePath", () => {
  it("resolves a linked worktree to the main checkout", () => {
    const { main, linked } = repoWithWorktree();
    expect(mainWorktreePath(linked)).toBe(fs.realpathSync(main));
  });

  it("returns null for the main checkout itself, so callers keep their path", () => {
    const { main } = repoWithWorktree();
    expect(mainWorktreePath(main)).toBeNull();
  });

  it("returns null outside a git repository", () => {
    const plain = fs.mkdtempSync(path.join(root, "plain-"));
    expect(mainWorktreePath(plain)).toBeNull();
  });

  it("returns null for a path that does not exist", () => {
    expect(mainWorktreePath(path.join(root, "absent"))).toBeNull();
  });

  it("makes both checkouts resolve to one project id", () => {
    // The point of the exercise: without resolution these are two ids and two
    // sets of collections for one repository, and whichever indexes last wins.
    const { main, linked } = repoWithWorktree();
    const viaMain = projectIdFromPath(fs.realpathSync(main));
    const viaLinked = projectIdFromPath(mainWorktreePath(linked) ?? linked);
    expect(viaLinked).toBe(viaMain);
    expect(projectIdFromPath(linked)).not.toBe(viaMain);
  });
});
