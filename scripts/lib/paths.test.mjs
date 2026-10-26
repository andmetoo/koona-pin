import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mainCheckoutOf, onMainOf, publishRootOf, releasesOf, shown } from "./paths.mjs";

// Where a build publishes (paths.mjs): the main checkout's release/publish for a worktree that builds
// what main releases, else its own. Checkouts are folders and repositories made here.
let base;
afterEach(() => base && rmSync(base, { recursive: true, force: true }));
const temp = () => (base = mkdtempSync(path.join(tmpdir(), "koonapin-paths-")));

/** A main checkout (.git a folder) and a worktree of it whose .git file says `gitdir`; no git involved. */
function checkouts(gitdir = (main) => path.join(main, ".git", "worktrees", "wt")) {
  const main = path.join(temp(), "main");
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
    expect(publishRootOf(main, () => { throw new Error("asked"); })).toEqual({ folder: publishOf(main), worktree: false, shared: false });
  });

  it("is the main checkout's for a worktree that builds what main releases", () => {
    const { main, worktree } = checkouts();
    expect(publishRootOf(worktree, () => true)).toEqual({ folder: publishOf(main), worktree: true, shared: true });
  });

  it("is the worktree's own otherwise", () => {
    const { worktree } = checkouts();
    expect(publishRootOf(worktree, () => false)).toEqual({ folder: publishOf(worktree), worktree: true, shared: false });
  });

  it("follows a relative gitdir (worktree.useRelativePaths)", () => {
    const { main, worktree } = checkouts((m, w) => path.relative(w, path.join(m, ".git", "worktrees", "wt")));
    expect(mainCheckoutOf(worktree)).toBe(main);
  });

  it("is the copy's own when its gitdir names a folder that is not here (act's container)", () => {
    const { worktree } = checkouts(() => "/home/runner/C:/Work/netamipin/.git/worktrees/wt");
    expect(mainCheckoutOf(worktree)).toBe(worktree);
    expect(publishRootOf(worktree, () => { throw new Error("asked"); }).folder).toBe(publishOf(worktree));
  });
});

describe("onMainOf and releasesOf, in a real repository", () => {
  /** git as on a bare machine: no global or system configuration, no hooks of the developer's. */
  const git = (cwd, ...args) => {
    const quiet = path.join(base, "no-config");
    writeFileSync(quiet, "");
    return execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", `core.hooksPath=${path.join(base, "no-hooks")}`, ...args],
      { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: quiet, GIT_CONFIG_NOSYSTEM: "1" } },
    ).trim();
  };

  /** main with two commits, origin/main at the second; `first` and `second` are their hashes. */
  function repository() {
    const main = path.join(temp(), "main");
    mkdirSync(main);
    git(main, "init", "--quiet", "--initial-branch=main");
    git(main, "commit", "--quiet", "--allow-empty", "-m", "first");
    const first = git(main, "rev-parse", "HEAD");
    git(main, "commit", "--quiet", "--allow-empty", "-m", "second");
    const second = git(main, "rev-parse", "HEAD");
    git(main, "update-ref", "refs/remotes/origin/main", second);
    /** A worktree at `commit`: detached, or on a new branch `branch`. */
    const worktree = (name, commit, branch) => {
      const at = path.join(base, name);
      git(main, "worktree", "add", "--quiet", ...(branch ? ["-b", branch] : ["--detach"]), at, commit);
      return at;
    };
    return { main, first, second, worktree };
  }

  it("take a detached worktree at the tip of origin/main", () => {
    const { second, worktree } = repository();
    const tip = worktree("tip", second);
    expect([onMainOf(tip), releasesOf(tip)]).toEqual([true, true]);
  });

  it("refuse a session's branch cut from origin/main, before its first commit", () => {
    const { second, worktree } = repository();
    const feature = worktree("feature", second, "sync/feature");
    expect([onMainOf(feature), releasesOf(feature)]).toEqual([false, false]);
  });

  it("an older commit of main is main for a store build, and a release only with a release tag", () => {
    const { main, first, worktree } = repository();
    const old = worktree("old", first);
    expect([onMainOf(old), releasesOf(old)]).toEqual([true, false]);
    git(main, "tag", "v1-try", first);
    expect(releasesOf(old)).toBe(false);
    git(main, "tag", "v1.0.0", first);
    expect(releasesOf(old)).toBe(true);
  });

  it("refuse a repository without origin/main", () => {
    const { main, worktree } = repository();
    git(main, "update-ref", "-d", "refs/remotes/origin/main");
    const lone = worktree("lone", "HEAD");
    expect([onMainOf(lone), releasesOf(lone)]).toEqual([false, false]);
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
