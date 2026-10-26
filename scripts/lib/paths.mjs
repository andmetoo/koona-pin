// Where builds put what leaves the repository: one place, so no script guesses another's folder
// (docs/building.md). Everything here is under release/, which Git ignores:
//
//   release/publish/   to people and stores
//     windows/<version>/   installer, signed, and SHA256SUMS.txt     bun run build:installer -- --sign
//     linux/<version>/     .deb, .rpm and SHA256SUMS.txt             bun run build:linux (on Debian 13)
//     macos/<version>/<arch>/  Koona Pin.app in a ZIP, .dmg and SHA256SUMS.txt   bun run build:macos
//     aur/<version>/       PKGBUILD and .SRCINFO of koonapin-bin     bun run build:aur
//     ios/<version>/       App Store IPAs, their dSYMs in ZIPs, SHA256SUMS.txt   bun run build:ios
//     android/<version>/   App Bundles for Google Play (upload key), SHA256SUMS.txt   bun run build:android
//       site/              the site's APK (its own key), SHA256SUMS.txt; the GitHub Release   bun run build:android -- --site
//       store/             the Play listing's upload set for that version: screenshots, icon, feature graphic, preview video
//     updates/<version>/   packages with .sig, SHA256SUMS.txt, latest.json and release.json; deployed to koona.app   bun run build:latest, build:release-data
//   release/shots/     screenshots of the app for the site (andmetoo/koona-site)   bun run site:shots
//     chrome/<version>/    koonapin-chrome.zip, Chrome Web Store    bun run extension:build
//     edge/<version>/      koonapin-edge.zip, Edge Add-ons          bun run extension:build
//     firefox/             signed XPIs and updates.json; koona.app serves them (extension.yml)   bun run extension:sign:firefox
//   release/test/      a test machine; never published
//     macos/<version>/<arch>/  test .app, its ZIP, SHA256SUMS.txt, build.json   bun run build:macos:test
//     windows/<version>/   installer, unsigned                       bun run build:installer
//     chrome-edge/<version>/  extension with the store id            bun run extension:build (CHROME_STORE_PUBLIC_KEY)
//     android/<version>/   .aab and arm64 .apk not for Play (debug key, branch, changes), SHA256SUMS.txt   bun run build:android
//     ios-simulator/<version>/  Koona Pin.app for the iOS Simulator (arm64)    bun run build:ios:sim
//     ios/<version>/       App Store IPAs not built from a clean commit of main, never uploaded   bun run build:ios
//   release/dev/       this machine
//     chrome/, edge/, firefox/  unpacked, development id («Load unpacked», tests)   bun run extension:build
//     safari/              the web part of the Safari app extension (NP-119)          bun run extension:build
//
// Tools keep their own working folders and nothing is taken from them by hand: src-tauri/target
// (Cargo and Tauri: debug and release EXEs, NSIS intermediates) and dist/ (Vite, the app's interface).
//
// release/publish/ is the main checkout's for a build of a git worktree (.claude/worktrees/<name>,
// where releases are built) that builds what main releases: HEAD is not on a branch of its own
// (detached, or main) and is the tip of origin/main or a release tag of it (v*, ext-v*), so there is
// one place to look for what was released. Any other worktree publishes into its own release/publish/,
// as before: a session's branch (sync/…, feat/…, even before its first commit) or an older commit of
// main never replaces the released packages. The choice depends on HEAD, its tags and the local
// origin/main only (no fetch, not the state of the tree, which a build changes as it runs), so a build
// and the script that reads its output later look in the same place. Android and iOS builds use the
// same rule and also refuse a tree with changes (store-build.mjs, cleanMain). release/test/,
// release/dev/ and release/shots/ are always the checkout's own: its tests and builds read them by
// relative paths (the Safari project copies <checkout>/release/dev/safari), and sessions in other
// worktrees must not overwrite them. Use `publish.*` for what leaves the repository and `release` only
// for test/, dev/ and shots/.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "..", "..");

/**
 * The main checkout of the checkout at `at`: a worktree's .git file names <main>/.git/worktrees/<name>
 * (absolute, or relative to the worktree with worktree.useRelativePaths). Only a main checkout that is
 * there counts: a copy of a worktree (act's container) names a folder of another machine, and is its
 * own place. `at` itself when it is not a worktree.
 */
export function mainCheckoutOf(at) {
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(path.join(at, ".git"), "utf8"))?.[1].trim();
    if (!gitdir) return at;
    const absolute = path.resolve(at, gitdir).replaceAll("\\", "/");
    const cut = absolute.lastIndexOf("/.git/worktrees/");
    const main = cut > 0 ? absolute.slice(0, cut) : null;
    if (main && statSync(path.join(main, ".git")).isDirectory()) return path.resolve(main);
  } catch {
    // .git is a folder (the main checkout, CI) or names nothing here: this checkout is the place.
  }
  return at;
}

/** A release tag of the app or of the browser extension. */
const RELEASE_TAG = /^(ext-)?v\d/;

/**
 * Whether the checkout at `at` builds what main releases (the rule above): HEAD detached or on main,
 * and the tip of its local origin/main or a release tag on it. Local refs only: no fetch.
 */
export function onMainOf(at) {
  const git = (...args) => spawnSync("git", args, { cwd: at, encoding: "utf8" });
  const branch = git("symbolic-ref", "--quiet", "--short", "HEAD");
  if (branch.status === 0 && branch.stdout.trim() !== "main") return false;
  const head = git("rev-parse", "--verify", "--quiet", "HEAD").stdout?.trim();
  if (!head) return false;
  if (git("rev-parse", "--verify", "--quiet", "origin/main").stdout?.trim() === head) return true;
  const tagged = git("tag", "--points-at", "HEAD").stdout?.split(/\r?\n/).some((tag) => RELEASE_TAG.test(tag));
  return Boolean(tagged) && git("merge-base", "--is-ancestor", "HEAD", "origin/main").status === 0;
}

/**
 * release/publish/ for the checkout at `at`, and why: its main checkout's when `at` is a worktree that
 * builds what main releases (`onMain`, asked only for a worktree), else its own.
 */
export function publishRootOf(at, onMain = onMainOf) {
  const main = mainCheckoutOf(at);
  const shared = main !== at && onMain(at);
  return { folder: path.join(shared ? main : at, "release", "publish"), worktree: main !== at, shared };
}

/** This checkout's release/: its test/, dev/ and shots/. What is published goes through `publish`. */
export const release = path.join(root, "release");

let publishFolder;
/** release/publish/ for what this run publishes (publishRootOf this checkout), decided once. */
export function publishRoot() {
  if (publishFolder) return publishFolder;
  const { folder, worktree, shared } = publishRootOf(root);
  if (worktree && !shared)
    console.warn(`Not the tip of origin/main or a release tag, or on a branch: published into this worktree's own ${shown(folder)}, not the main checkout's.`);
  publishFolder = folder;
  return publishFolder;
}

/** A path for a message: relative to `at` (this checkout) when inside it, else in full (the main checkout's release/publish). */
export function shown(file, at = root) {
  const relative = path.relative(at, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
}

export const publish = {
  windows: (version) => path.join(publishRoot(), "windows", version),
  linux: (version) => path.join(publishRoot(), "linux", version),
  /** arch is process.arch of the building Mac: arm64 or x64. */
  macos: (version, arch) => path.join(publishRoot(), "macos", version, arch),
  aur: (version) => path.join(publishRoot(), "aur", version),
  /** Every build number of the version side by side: KoonaPin-<version>-<build>.ipa (build-ios.mjs). */
  ios: (version) => path.join(publishRoot(), "ios", version),
  /** Every build number of the version side by side: koona-pin-<version>-<build>.aab (build-android.mjs). */
  android: (version) => path.join(publishRoot(), "android", version),
  /** The Play listing's upload set for that version, beside its App Bundles. */
  play: (version) => path.join(publishRoot(), "android", version, "store"),
  /** One folder per version (build-latest.mjs, build-release-data.mjs). */
  get updates() {
    return path.join(publishRoot(), "updates");
  },
  chrome: (version) => path.join(publishRoot(), "chrome", version),
  edge: (version) => path.join(publishRoot(), "edge", version),
  /** The address of these files is inside every signed XPI (gecko.update_url): only the local folder moves. */
  get firefox() {
    return path.join(publishRoot(), "firefox");
  },
};

export const test = {
  macos: (version, arch) => path.join(release, "test", "macos", version, arch),
  windows: (version) => path.join(release, "test", "windows", version),
  chromeEdge: (version) => path.join(release, "test", "chrome-edge", version),
  android: (version) => path.join(release, "test", "android", version),
  iosSimulator: (version) => path.join(release, "test", "ios-simulator", version),
  /** App Store builds that are not a clean commit of main: never uploaded (build-ios.mjs). */
  ios: (version) => path.join(release, "test", "ios", version),
};

export const dev = {
  extension: (browser) => path.join(release, "dev", browser),
};

/** Tauri's NSIS output, copied from here into publish/ or test/ by build-installer.mjs. */
export const nsisBundle = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
