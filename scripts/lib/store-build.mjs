// What the store builds share, iOS (build-ios.mjs) and Android (build-android.mjs): the build number,
// whether a build may reach a store, their options and the checksums of their folders.
//
// The build number (iOS's CFBundleVersion, Android's versionCode) is the number of commits up to HEAD
// (`git rev-list --count HEAD`), so every commit of main builds a higher number, the same on both phones;
// a second upload of the same commit takes `--build` with a higher number. A branch's count can pass
// main's: once squash-merged, main counts one more, and the stores refuse its next builds as not higher
// than the branch's upload. So only a clean commit of origin/main goes to a store; anything else is a
// test build (release/test/).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { root } from "./paths.mjs";

export const args = process.argv.slice(2);

/** The value after `name` in the arguments, undefined without `name`; a name with no value is an error. */
export function option(name) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

export const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/**
 * The members of a ZIP file (an APK, an AAB) that match `pattern`, a wildcard such as `lib/*` or
 * `classes*.dex`, extracted into `folder`. Windows has no unzip; its own tar (bsdtar) reads ZIP files, named
 * by path because the tar of Git Bash, first on its PATH, is GNU tar, which takes `C:` for a remote host.
 */
export function unzip(zip, pattern, folder) {
  if (process.platform === "win32") {
    execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", zip, "-C", folder, pattern]);
  } else {
    execFileSync("unzip", ["-q", "-o", zip, pattern, "-d", folder]);
  }
}

/** SHA256SUMS.txt of every other file in the folder, by name. */
export function writeChecksums(folder) {
  const files = readdirSync(folder).filter((name) => name !== "SHA256SUMS.txt").sort();
  writeFileSync(path.join(folder, "SHA256SUMS.txt"), files.map((name) => `${sha256(path.join(folder, name))}  ${name}\n`).join(""));
}

const git = (...parts) => execFileSync("git", parts, { cwd: root, encoding: "utf8" }).trim();

/** `--build <n>` of the arguments, else the commit count of HEAD; a whole number up to Play's limit. */
export function buildNumber(given) {
  let build = given;
  if (build === undefined) {
    if (git("rev-parse", "--is-shallow-repository") === "true") throw new Error("A shallow clone has no commit count: fetch the history or pass --build");
    build = git("rev-list", "--count", "HEAD");
  }
  if (!/^[1-9]\d{0,9}$/.test(build) || Number(build) > 2_100_000_000) {
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
