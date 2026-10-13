// Builds Koona Pin for macOS (#56) on a Mac or the macOS Actions runner; <arch> is this machine's
// (arm64 on Apple Silicon, x64 on Intel). Folders: scripts/lib/paths.mjs.
//   bun scripts/build-macos.mjs          release: --features public-release, `Koona Pin.app` in a ZIP and a .dmg,
//                                        both with README.txt (src-tauri/macos/README.txt) next to the app →
//                                        release/publish/macos/<version>/<arch>/ with SHA256SUMS.txt
//   bun scripts/build-macos.mjs --test   experimental test .app without public-release, never published →
//                                        release/test/macos/<version>/<arch>/
// Settings come from the environment or from .env in the repository root (.env.example); a variable
// already set in the environment wins. The release build needs KOONAPIN_FEEDBACK_URL (feedback.rs).
// Apple signing is optional: with APPLE_SIGNING_IDENTITY (a Developer ID Application identity in the
// keychain) Tauri signs, and with APPLE_API_ISSUER/APPLE_API_KEY/APPLE_API_KEY_PATH or
// APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID it also notarizes and staples the app. Without them the
// bundle is signed ad hoc and Gatekeeper needs the Mac owner's approval (NP-051).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { publish, root, test } from "./lib/paths.mjs";

if (process.platform !== "darwin") throw new Error("Build this on a Mac or the macOS Actions runner");
const testBuild = process.argv.includes("--test");
// The version of the bundle is the one in tauri.conf.json, as for the other platforms' builds.
const version = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
const arch = process.arch;
const run = (program, args, options = {}) => execFileSync(program, args, { cwd: root, stdio: "inherit", ...options });
const bundleDir = path.join(root, "src-tauri", "target", "release", "bundle");
const app = "Koona Pin.app";
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim();
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
/** Unmounts a disk image; a Finder or Spotlight still holding it gets a moment, then a forced detach. */
function detach(mount) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (spawnSync("hdiutil", ["detach", mount], { stdio: "inherit" }).status === 0) return;
    spawnSync("sleep", ["2"]);
  }
  run("hdiutil", ["detach", "-force", mount]);
}

if (testBuild) {
  const output = test.macos(version, arch);
  run("bun", ["run", "tauri", "build", "--config", "src-tauri/tauri.macos-test.conf.json", "--bundles", "app"]);
  mkdirSync(output, { recursive: true });
  cpSync(path.join(bundleDir, "macos", app), path.join(output, app), { recursive: true });
  const archive = `koonapin-${version}-macos-${arch}-test.zip`;
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive], { cwd: output });
  writeFileSync(path.join(output, "SHA256SUMS.txt"), `${sha256(path.join(output, archive))}  ${archive}\n`);
  const commit = git("rev-parse", "HEAD");
  writeFileSync(path.join(output, "build.json"), JSON.stringify({ version, commit, arch, platform: process.platform,
    os: execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(), features: ["custom-protocol"],
    signedRelease: false, notarized: false }, null, 2));
  writeFileSync(path.join(output, "README.txt"), `Koona Pin ${version}, macOS ${arch}, test build from ${commit}\n\nExtract the ZIP preserving the .app directory and open Koona Pin.app.\nThis is an experimental test bundle, without Developer ID signing or notarization.\nIt is not a public release; Gatekeeper may require the Mac owner's explicit approval.\nBrowser capture is new on macOS and not yet tested with real browsers; in-app updates are not implemented.\nSupported macOS versions, native window/menu/shortcuts and release signing remain #56.\n`);
  console.log(output);
  process.exit(0);
}

// Cargo (option_env! in feedback.rs) and Tauri's signing and notarization inherit these.
const dotenv = path.join(root, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);
const env = process.env;
if (!env.KOONAPIN_FEEDBACK_URL) {
  console.error("KOONAPIN_FEEDBACK_URL is not set: the release build does not compile without it (supabase/README.md).");
  process.exit(1);
}
// An Apple variable set but empty (a workflow passes every secret, configured or not) counts as unset:
// Tauri would take an empty signing identity or empty notarization credentials for real ones.
for (const name of Object.keys(env)) if (name.startsWith("APPLE_") && !env[name]) delete env[name];
const identity = env.APPLE_SIGNING_IDENTITY;
const notarize = Boolean(identity) && Boolean(
  (env.APPLE_API_ISSUER && env.APPLE_API_KEY && env.APPLE_API_KEY_PATH) || (env.APPLE_ID && env.APPLE_PASSWORD && env.APPLE_TEAM_ID));
if (!identity) console.warn("APPLE_SIGNING_IDENTITY is not set: an unsigned (ad hoc) build; Gatekeeper needs the Mac owner's approval.");
else if (!notarize) console.warn("No notarization credentials (APPLE_API_* or APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID): signed, not notarized.");

// A bundle left from an earlier build must not pass for this one.
const dmgDir = path.join(bundleDir, "dmg");
const dmgsOfThisVersion = () => (existsSync(dmgDir) ? readdirSync(dmgDir).filter((file) => file.endsWith(".dmg") && file.includes(`_${version}_`)) : []);
for (const old of dmgsOfThisVersion()) rmSync(path.join(dmgDir, old));
rmSync(path.join(bundleDir, "macos", app), { recursive: true, force: true });

// Bundle settings live in tauri.macos-release.conf.json, not tauri.macos.conf.json, which Tauri
// merges into every macOS build including `cargo test` and dev. Without an identity "-" seals the
// bundle ad hoc (the linker alone signs only the executable); Tauri never notarizes an ad hoc one.
const args = ["run", "tauri", "build", "--features", "public-release", "--bundles", "app,dmg",
  "--config", "src-tauri/tauri.macos-release.conf.json"];
if (!identity) args.push("--config", JSON.stringify({ bundle: { macOS: { signingIdentity: "-" } } }));
run("bun", args);

const [dmg] = dmgsOfThisVersion();
if (!dmg) throw new Error(`No .dmg for ${version} in ${dmgDir}`);
const output = publish.macos(version, arch);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const base = `koonapin-${version}-macos-${arch}`;
// README.txt for people (src-tauri/macos/README.txt): what the app is, how to open a build without a
// Developer ID past Gatekeeper, where updates come from. It goes next to Koona Pin.app in both.
const readme = path.join(root, "src-tauri", "macos", "README.txt");
const work = mkdtempSync(path.join(tmpdir(), "koonapin-macos-"));
try {
  // The ZIP: Koona Pin.app and README.txt at its top. ditto keeps the bundle's metadata and signature,
  // both when copying the app and when archiving the folder's contents (no --keepParent: no folder level).
  const zipRoot = path.join(work, "zip");
  mkdirSync(zipRoot);
  run("ditto", [path.join(bundleDir, "macos", app), path.join(zipRoot, app)]);
  cpSync(readme, path.join(zipRoot, "README.txt"));
  run("ditto", ["-c", "-k", "--sequesterRsrc", zipRoot, path.join(output, `${base}.zip`)]);

  // The DMG: Tauri's, read-write, README.txt added, compressed again. Tauri's .DS_Store (window size,
  // background, the positions of the app and the Applications link) stays as it is, since only a file
  // is added; README.txt has no position of its own there, so Finder places it in the window by itself.
  const rw = path.join(work, "rw.dmg");
  const mount = path.join(work, "mount");
  mkdirSync(mount);
  run("hdiutil", ["convert", path.join(dmgDir, dmg), "-format", "UDRW", "-o", rw]);
  // A few spare megabytes: Tauri sizes its image to the app, the README needs room of its own.
  run("hdiutil", ["resize", "-size", `${Math.ceil(statSync(rw).size / 1048576) + 4}m`, rw]);
  run("hdiutil", ["attach", rw, "-nobrowse", "-noverify", "-noautoopen", "-mountpoint", mount]);
  try {
    cpSync(readme, path.join(mount, "README.txt"));
  } finally {
    detach(mount);
  }
  run("hdiutil", ["convert", rw, "-format", "UDZO", "-imagekey", "zlib-level=9", "-o", path.join(output, `${base}.dmg`)]);
} finally {
  rmSync(work, { recursive: true, force: true });
}
// The content changed, so a signature Tauri gave the image is gone: sign it again with the same identity.
// The app inside keeps its own signature (and notarization ticket, when notarized). Notarizing the DMG
// itself (notarytool submit, stapler staple) is a separate step, not done here yet (NP-051).
if (identity) run("codesign", ["--force", "--sign", identity, "--timestamp", path.join(output, `${base}.dmg`)]);
const files = [`${base}.zip`, `${base}.dmg`];
const sums = files.map((file) => `${sha256(path.join(output, file))}  ${file}`);
const dirty = git("status", "--porcelain", "--untracked-files=no") ? " with uncommitted changes" : "";
const signature = identity ? `signed with Developer ID, ${notarize ? "notarized" : "not notarized"}` : "unsigned (ad hoc), not notarized";
writeFileSync(path.join(output, "SHA256SUMS.txt"),
  `${sums.join("\n")}\n\n${signature}; commit ${git("rev-parse", "--short", "HEAD")}${dirty}; built ${new Date().toISOString()}\n`);
console.log(`\n${sums.map((line) => line.replace(/^\S+ {2}/, `${path.relative(root, output)}/`)).join("\n")}\n${identity ? signature : "UNSIGNED (ad hoc): Gatekeeper needs the Mac owner's approval"}`);
