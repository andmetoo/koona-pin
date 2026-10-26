import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mainCheckoutOf, publishRootOf, shown } from "./paths.mjs";

// Where a build publishes (paths.mjs): the main checkout's release/publish for a worktree on
// origin/main, else its own. Checkouts are folders made here; `onMain` stands for git.
let base;
afterEach(() => base && rmSync(base, { recursive: true, force: true }));

/** A main checkout (.git a folder) and a worktree of it whose .git file says `gitdir`. */
function checkouts(gitdir = (main) => path.join(main, ".git", "worktrees", "wt")) {
  base = mkdtempSync(path.join(tmpdir(), "koonapin-paths-"));
  const main = path.join(base, "main");
  const worktree = path.join(main, ".claude", "worktrees", "wt");
  mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitdir(main, worktree)}\n`);
  return { main, worktree };
}

const publishOf = (at) => path.join(at, "release", "publish");

describe("publishRootOf", () => {
  it("is the checkout's own in a main checkout, without asking git", () => {
    const { main } = checkouts();
    expect(publishRootOf(main, () => { throw new Error("asked"); })).toBe(publishOf(main));
  });

  it("is the main checkout's for a worktree on origin/main", () => {
    const { main, worktree } = checkouts();
    expect(publishRootOf(worktree, () => true)).toBe(publishOf(main));
  });

  it("is the worktree's own for a branch", () => {
    const { worktree } = checkouts();
    expect(publishRootOf(worktree, () => false)).toBe(publishOf(worktree));
  });

  it("follows a relative gitdir (worktree.useRelativePaths)", () => {
    const { main, worktree } = checkouts((m, w) => path.relative(w, path.join(m, ".git", "worktrees", "wt")));
    expect(mainCheckoutOf(worktree)).toBe(main);
  });

  it("is the copy's own when its gitdir names a folder that is not here (act's container)", () => {
    const { worktree } = checkouts(() => "/home/runner/C:/Work/netamipin/.git/worktrees/wt");
    expect(mainCheckoutOf(worktree)).toBe(worktree);
    expect(publishRootOf(worktree, () => { throw new Error("asked"); })).toBe(publishOf(worktree));
  });
});

describe("shown", () => {
  it("is relative inside the checkout and in full outside it", () => {
    const at = path.resolve("/work/wt");
    expect(shown(path.join(at, "release", "publish", "x"), at)).toBe(path.join("release", "publish", "x"));
    const outside = path.resolve("/work/main/release/publish/x");
    expect(shown(outside, at)).toBe(outside);
  });
});
