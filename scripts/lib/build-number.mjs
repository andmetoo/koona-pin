// The build number of the store builds and whether a build may reach a store, the same rule for iOS
// (build-ios.mjs) and Android (build-android.mjs).
//
// The build number (iOS's CFBundleVersion, Android's versionCode) is the number of commits up to HEAD
// (`git rev-list --count HEAD`), so every commit of main builds a higher number, the same on both phones;
// a second upload of the same commit takes `--build` with a higher number. A branch's count can pass
// main's: once squash-merged, main counts one more, and the stores refuse its next builds as not higher
// than the branch's upload. So only a clean commit of origin/main goes to a store; anything else is a
// test build (release/test/).
import { execFileSync, spawnSync } from "node:child_process";
import { root } from "./paths.mjs";

const git = (...parts) => execFileSync("git", parts, { cwd: root, encoding: "utf8" }).trim();

/** `--build <n>` of the arguments, else the commit count of HEAD; a whole number up to Play's limit. */
export function buildNumber(given) {
  let build = given;
  if (build === undefined) {
    if (git("rev-parse", "--is-shallow-repository") === "true") throw new Error("A shallow clone has no commit count: fetch the history or pass --build");
    build = git("rev-list", "--count", "HEAD");
  }
  if (!/^[1-9]\d{0,8}$/.test(build) || Number(build) > 2_100_000_000) {
    throw new Error(`The build number must be a positive whole number up to 2100000000, not «${build}»`);
  }
  return build;
}

/**
 * Whether HEAD is a clean commit of origin/main as it is now: origin/main is fetched first (else a
 * commit of main reads as a branch's), and a new file that Git does not ignore is a change too: the build
 * has it, the commit does not.
 */
export function cleanMain() {
  const fetched = spawnSync("git", ["fetch", "--quiet", "origin", "main"], {
    cwd: root, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (fetched.status !== 0) {
    console.warn(`Could not fetch origin/main (${fetched.error?.message ?? fetched.stderr.trim().split("\n")[0]}): `
      + "the check below uses the local origin/main, which may be out of date.");
  }
  const onMain = spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], { cwd: root }).status === 0;
  const dirty = Boolean(git("status", "--porcelain", "--untracked-files=normal"));
  return { onMain, dirty, clean: onMain && !dirty };
}
