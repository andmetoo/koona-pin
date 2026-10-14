// Builds Koona Pin for macOS (#56) on a Mac or the macOS Actions runner; <arch> is this machine's
// (arm64 on Apple Silicon, x64 on Intel). Folders: scripts/lib/paths.mjs.
//   bun scripts/build-macos.mjs          release: --features public-release, `Koona Pin.app` in a ZIP and a .dmg
//                                        (dmgbuild, src-tauri/macos/dmg), with the Safari extension when it is
//                                        signed with a Developer ID →
//                                        release/publish/macos/<version>/<arch>/ with SHA256SUMS.txt
//   bun scripts/build-macos.mjs --test   experimental test .app without public-release, never published →
//                                        release/test/macos/<version>/<arch>/
//   bun scripts/build-macos.mjs --test --safari   the same with the Safari extension in Contents/PlugIns
//                                        (NP-119): Xcode, signed to run locally, no Apple Developer account
// Settings come from the environment or from .env in the repository root (.env.example); a variable
// already set in the environment wins. The release build needs KOONAPIN_FEEDBACK_URL (feedback.rs).
// Apple signing is optional: with APPLE_SIGNING_IDENTITY (a Developer ID Application identity in the
// keychain) Tauri signs the app, this script adds the Safari extension and signs it and the app again,
// and with APPLE_API_ISSUER/APPLE_API_KEY/APPLE_API_KEY_PATH or APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID it
// notarizes and staples the app and the DMG. Without them the bundle is signed ad hoc, has no Safari
// extension (Safari loads an ad hoc one only with «Allow unsigned extensions»), and Gatekeeper needs the
// Mac owner's approval (NP-051).
// The DMG needs Python 3.10 or later for dmgbuild (see dmgbuild() below).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { publish, root, test } from "./lib/paths.mjs";

if (process.platform !== "darwin") throw new Error("Build this on a Mac or the macOS Actions runner");
const testBuild = process.argv.includes("--test");
// A test build has Safari with --safari; a release build whenever it has a Developer ID (NP-119).
const safari = process.argv.includes("--safari");
if (safari && !testBuild) throw new Error("--safari is for a test build: a release build has Safari whenever APPLE_SIGNING_IDENTITY is set");
// The version of the bundle is the one in tauri.conf.json, as for the other platforms' builds.
const version = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
const arch = process.arch;
const run = (program, args, options = {}) => execFileSync(program, args, { cwd: root, stdio: "inherit", ...options });
const bundleDir = path.join(root, "src-tauri", "target", "release", "bundle");
const app = "Koona Pin.app";
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim();
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/**
 * The Safari app extension (src-tauri/macos/safari, NP-119) into Contents/PlugIns of the app at `bundle`.
 * Xcode signs to run locally (no team, no profile); the .appex is signed again with its own entitlements,
 * the sandbox only, then the app around it, without --deep, keeping what Tauri gave the app. `identity`
 * is a Developer ID (with a secure timestamp, as notarization requires) or "-", ad hoc. No provisioning
 * profile either way: the sandbox is the extension's only entitlement.
 */
function embedSafari(bundle, identity = "-") {
  const sign = ["--force", "--sign", identity, ...(identity === "-" ? [] : ["--timestamp"])];
  const project = path.join(root, "src-tauri", "macos", "safari");
  const work = path.join(root, "src-tauri", "target", "safari");
  // The handler's envelope and socket exchange, without Safari (Tests/RelayCheck.swift).
  const check = path.join(work, "relay-check");
  mkdirSync(work, { recursive: true });
  run("xcrun", ["swiftc", "-swift-version", "5", "-parse-as-library", "-o", check,
    path.join(project, "Extension", "Relay.swift"), path.join(project, "Tests", "RelayCheck.swift")]);
  run(check);
  // The web part comes from release/dev/safari (bun run extension:build) through the project's copy phase;
  // the .appex carries the app's version, as Apple requires of an app extension.
  run("xcodebuild", ["-quiet", "-project", path.join(project, "KoonaPinSafari.xcodeproj"), "-target", "KoonaPinSafari",
    "-configuration", "Release", `SYMROOT=${path.join(work, "Build", "Products")}`, `OBJROOT=${path.join(work, "Build", "Intermediates")}`,
    `MARKETING_VERSION=${version}`, `CURRENT_PROJECT_VERSION=${version}`, "CODE_SIGN_IDENTITY=-", "DEVELOPMENT_TEAM=", "build"]);
  const built = path.join(work, "Build", "Products", "Release", "Koona Pin Safari.appex");
  // The app opens the Safari socket only when this path exists in its bundle.
  const appex = path.join(bundle, "Contents", "PlugIns", "Koona Pin Safari.appex");
  rmSync(appex, { recursive: true, force: true });
  mkdirSync(path.dirname(appex), { recursive: true });
  run("ditto", [built, appex]);
  run("codesign", [...sign, "--options", "runtime",
    "--entitlements", path.join(project, "Extension", "KoonaPinSafari.entitlements"), appex]);
  // Inside out, never --deep, which would sign the .appex again without its entitlements. The app keeps the
  // entitlements and flags it had (none today, the hardened runtime in a release; a Tauri setting may add some).
  const entitlements = () => execFileSync("codesign", ["-d", "--entitlements", "-", "--xml", bundle],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const before = entitlements();
  run("codesign", [...sign, "--preserve-metadata=entitlements,flags,runtime", bundle]);
  if (entitlements() !== before) throw new Error(`Signing ${app} again changed its entitlements`);
  run("codesign", ["--verify", "--strict", "--deep", "--verbose=2", bundle]);
}

// Steps for the person testing Safari (NP-119, docs/macos-test.md «Safari»).
const safariReadme = `
Safari (NP-119): Koona Pin.app/Contents/PlugIns/Koona Pin Safari.appex, signed to run locally.
Try it with a test library, never the everyday one. Safari starts a closed app without your Terminal's
variables, so set the library for every app started from the Dock, Finder or Safari, and unset it after:
  launchctl setenv KOONAPIN_DATA_DIR ~/KoonaPinTest      (afterwards: launchctl unsetenv KOONAPIN_DATA_DIR)
While it is set, every Koona Pin opens that library; an installed older Koona Pin refuses it once this
build has updated it.
1. Safari > Settings > Advanced: turn on "Show features for web developers".
2. Develop > "Allow unsigned extensions".
3. Then start Koona Pin (quit it first if it runs): Safari lists an unsigned extension only when macOS
   registers it while unsigned extensions are allowed, and Safari turns that setting off every time it
   starts. So after every Safari start: step 2, then step 3 again.
4. Safari > Settings > Extensions: turn on Koona Pin, then allow it on websites.
If Safari does not list Koona Pin, see what macOS registered:
  pluginkit -mAvvv -p com.apple.Safari.web-extension
Quick search (Option+Shift+D or the button's menu) opens in a small window: Safari opens no popover for it.
`;

if (testBuild) {
  const output = test.macos(version, arch);
  if (safari) run("bun", ["run", "extension:build"]);
  run("bun", ["run", "tauri", "build", "--config", "src-tauri/tauri.macos-test.conf.json", "--bundles", "app"]);
  mkdirSync(output, { recursive: true });
  // An .appex of an earlier Safari build must not stay in a plain one.
  rmSync(path.join(output, app), { recursive: true, force: true });
  cpSync(path.join(bundleDir, "macos", app), path.join(output, app), { recursive: true });
  if (safari) embedSafari(path.join(output, app));
  const archive = `koonapin-${version}-macos-${arch}-test.zip`;
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive], { cwd: output });
  writeFileSync(path.join(output, "SHA256SUMS.txt"), `${sha256(path.join(output, archive))}  ${archive}\n`);
  const commit = git("rev-parse", "HEAD");
  writeFileSync(path.join(output, "build.json"), JSON.stringify({ version, commit, arch, platform: process.platform,
    os: execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(), features: ["custom-protocol"],
    signedRelease: false, notarized: false, safari }, null, 2));
  writeFileSync(path.join(output, "README.txt"), `Koona Pin ${version}, macOS ${arch}, test build from ${commit}\n\nExtract the ZIP preserving the .app directory and open Koona Pin.app.\nThis is an experimental test bundle, without Developer ID signing or notarization.\nIt is not a public release; Gatekeeper may require the Mac owner's explicit approval.\nBrowser capture is new on macOS and not yet tested with real browsers; in-app updates are not implemented.\nSupported macOS versions, native window/menu/shortcuts and release signing remain #56.\n${safari ? safariReadme : ""}`);
  console.log(output);
  process.exit(0);
}

// Cargo (option_env! in feedback.rs) and Tauri's signing inherit these.
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
if (!identity) console.warn("APPLE_SIGNING_IDENTITY is not set: an unsigned (ad hoc) build without Safari; Gatekeeper needs the Mac owner's approval.");
else if (!notarize) console.warn("No notarization credentials (APPLE_API_* or APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID): signed, not notarized.");

// A bundle left from an earlier build must not pass for this one.
rmSync(path.join(bundleDir, "macos", app), { recursive: true, force: true });

// Bundle settings live in tauri.macos-release.conf.json, not tauri.macos.conf.json, which Tauri
// merges into every macOS build including `cargo test` and dev. Without an identity "-" seals the
// bundle ad hoc (the linker alone signs only the executable); Tauri never notarizes an ad hoc one.
// Tauri makes the app only: its DMG gets a styled window only from Finder by AppleScript, which a
// CI runner (and a Terminal without Automation access) skips, so dmgbuild makes the image below.
const args = ["run", "tauri", "build", "--features", "public-release", "--bundles", "app",
  "--config", "src-tauri/tauri.macos-release.conf.json"];
if (!identity) args.push("--config", JSON.stringify({ bundle: { macOS: { signingIdentity: "-" } } }));
// Tauri signs but does not notarize: the Safari extension goes in after it, and that seals the app again,
// so this script notarizes the finished app itself. Without these variables Tauri skips notarization.
const notaryVars = new Set(["APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_PATH", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"]);
if (identity) run("bun", ["run", "extension:build"]);
run("bun", args, { env: Object.fromEntries(Object.entries(env).filter(([name]) => !notaryVars.has(name))) });

/**
 * dmgbuild (src-tauri/macos/dmg/requirements.txt, pinned by hash) in a virtual environment under
 * src-tauri/target, made again when the requirements change. It needs Python 3.10 or later; macOS's
 * own python3 is 3.9, so a newer one comes from PYTHON, mise, Homebrew or python.org.
 */
function dmgbuild() {
  const requirements = path.join(root, "src-tauri", "macos", "dmg", "requirements.txt");
  const venv = path.join(root, "src-tauri", "target", "dmgbuild");
  const stamp = path.join(venv, "requirements.sha256");
  const bin = path.join(venv, "bin", "dmgbuild");
  if (existsSync(bin) && existsSync(stamp) && readFileSync(stamp, "utf8") === sha256(requirements)) return bin;
  const candidates = [env.PYTHON, ...["3.14", "3.13", "3.12", "3.11", "3.10"].map((v) => `python${v}`), "python3"].filter(Boolean);
  const python = candidates.find((candidate) =>
    spawnSync(candidate, ["-c", "import sys; sys.exit(sys.version_info < (3, 10))"], { stdio: "ignore" }).status === 0);
  if (!python) throw new Error("dmgbuild needs Python 3.10 or later: `mise use -g python@3.13` (or Homebrew), or PYTHON=<path>");
  rmSync(venv, { recursive: true, force: true });
  run(python, ["-m", "venv", venv]);
  run(path.join(venv, "bin", "pip"), ["install", "--quiet", "--disable-pip-version-check", "--require-hashes",
    "--only-binary", ":all:", "-r", requirements]);
  writeFileSync(stamp, sha256(requirements));
  return bin;
}

/** notarytool's credentials: the App Store Connect API key, else the Apple ID (as Tauri picks them). */
const notaryCredentials = () => env.APPLE_API_KEY_PATH
  ? ["--key", env.APPLE_API_KEY_PATH, "--key-id", env.APPLE_API_KEY, "--issuer", env.APPLE_API_ISSUER]
  : ["--apple-id", env.APPLE_ID, "--password", env.APPLE_PASSWORD, "--team-id", env.APPLE_TEAM_ID];
/**
 * notarytool with the credentials. A failure names the subcommand and its exit status only: Node's own
 * error would print the whole command line, credentials included, into the terminal or the CI log.
 */
function notarytool(args, options = {}) {
  const result = spawnSync("xcrun", ["notarytool", ...args, ...notaryCredentials()], { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`notarytool ${args[0]} failed with status ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  return result.stdout;
}
/** Notarizes `file` (a DMG, or a ZIP of an app) and staples the ticket to `target`; Apple's log when it is not accepted. */
function notarizeAndStaple(file, target = file) {
  const result = JSON.parse(notarytool(["submit", file, "--wait", "--output-format", "json"]));
  if (result.status !== "Accepted") {
    try { notarytool(["log", result.id], { stdio: ["ignore", "inherit", "pipe"] }); } catch (error) { console.error(error.message); }
    throw new Error(`Notarization of ${path.basename(file)}: ${result.status} (${result.id})`);
  }
  console.log(`Notarized ${path.basename(file)} (${result.id})`);
  run("xcrun", ["stapler", "staple", target]);
}

const output = publish.macos(version, arch);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const base = `koonapin-${version}-macos-${arch}`;
const built = path.join(bundleDir, "macos", app);
const dmg = path.join(output, `${base}.dmg`);
// Safari, signed with the app's Developer ID; then the app is notarized as a ZIP and the ticket stapled to it.
if (identity) embedSafari(built, identity);
if (notarize) {
  const submission = path.join(root, "src-tauri", "target", "notarize", `${base}.zip`);
  rmSync(path.dirname(submission), { recursive: true, force: true });
  mkdirSync(path.dirname(submission), { recursive: true });
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", built, submission]);
  notarizeAndStaple(submission, built);
}
// The ZIP: Koona Pin.app at its top. ditto keeps the bundle's metadata, signature and stapled ticket.
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", built, path.join(output, `${base}.zip`)]);
// The DMG: the app, a link to Applications, the window and volume icon of src-tauri/macos/dmg.
const dmgSettings = path.join(root, "src-tauri", "macos", "dmg");
run(dmgbuild(), ["-s", path.join(dmgSettings, "settings.py"), "-D", `app=${built}`, "-D", `here=${dmgSettings}`, "Koona Pin", dmg]);
// The image is signed, then notarized and stapled itself: Gatekeeper checks a downloaded DMG before the app inside.
if (identity) run("codesign", ["--force", "--sign", identity, "--timestamp", dmg]);
if (notarize) notarizeAndStaple(dmg);
const files = [`${base}.zip`, `${base}.dmg`];
const sums = files.map((file) => `${sha256(path.join(output, file))}  ${file}`);
const dirty = git("status", "--porcelain", "--untracked-files=no") ? " with uncommitted changes" : "";
const signature = identity ? `signed with Developer ID, ${notarize ? "notarized" : "not notarized"}, with Safari` : "unsigned (ad hoc), not notarized, without Safari";
writeFileSync(path.join(output, "SHA256SUMS.txt"),
  `${sums.join("\n")}\n\n${signature}; commit ${git("rev-parse", "--short", "HEAD")}${dirty}; built ${new Date().toISOString()}\n`);
console.log(`\n${sums.map((line) => line.replace(/^\S+ {2}/, `${path.relative(root, output)}/`)).join("\n")}\n${identity ? signature : "UNSIGNED (ad hoc): Gatekeeper needs the Mac owner's approval"}`);
