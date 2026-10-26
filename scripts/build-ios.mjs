// Builds Koona Pin for the App Store (NP-078): an iPhone build signed for distribution, for TestFlight
// and App Store Connect, with Supporter through StoreKit (the feature store-appstore). The Simulator's
// build is build-ios-sim.mjs. Folders: scripts/lib/paths.mjs.
//   bun run build:ios                    archive, export and check → release/publish/ios/<version>/
//                                        KoonaPin-<version>-<build>.ipa, its dSYMs in a ZIP, SHA256SUMS.txt
//   bun run build:ios -- --build <n>     the build number (CFBundleVersion) instead of the commit count
//   bun run build:ios -- --validate      then App Store Connect's validation of the IPA (altool)
//   bun run build:ios -- --upload        then the upload to App Store Connect (altool)
//   bun scripts/build-ios.mjs --ipa <file> --validate   the validation of an IPA built already
//   A build that is not a clean commit of origin/main goes to release/test/ios/<version>/ instead.
//
// Build numbers: CFBundleShortVersionString is the app's version; CFBundleVersion is the number of
// commits up to HEAD (`git rev-list --count HEAD`), so every commit of main builds a higher number, for
// iOS and later for Android's versionCode. A second upload of the same commit takes `--build` with a
// higher number. --upload takes only a clean commit on origin/main (a branch's count can pass a later commit
// of main), with or without --build; the script fetches origin/main first.
//
// Signing is Xcode's automatic, cloud-managed signing through the App Store Connect API key, with no
// certificate or profile in the repository: APPLE_STORE_KEY, APPLE_STORE_ISSUER and APPLE_STORE_KEY_PATH (a
// key with access to cloud-managed distribution certificates: the Admin role), and APPLE_TEAM_ID (else
// the team in APPLE_SIGNING_IDENTITY's parentheses). Settings come from the environment or from .env in
// the repository root; a variable already set in the environment wins. Needs what build-ios-sim.mjs
// needs, with the Rust target aarch64-apple-ios instead of the Simulator's.
//
// The share extension (PlugIns/KoonaPinShare.appex, koona-share) is signed and checked with the app: both
// carry the App Group group.app.koona.pin, which the app id, the extension's id app.koona.pin.share and the
// group itself need in the developer account. Those are made once in the developer portal: an App Store
// Connect API key cannot reach App Groups (Xcode's request answers 401); with them in place, cloud signing
// makes the extension's App Store profile.
//
// Tauri's CLI runs the archive (Xcode's «Build Rust Code» phase talks to it) and writes the team and the
// build number into the committed Xcode project and the Info.plist files (the app's and the share
// extension's); this script puts the files back as they
// were, whatever happens. The archive is not signed; the export signs it.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { args, buildNumber, cleanMain, option, writeChecksums } from "./lib/store-build.mjs";
import { loadEnv } from "./lib/env.mjs";
import { app, appGroup, appleProject, bundleId, extensions, requireLlvmTools, version } from "./lib/ios.mjs";
import { publish, root, shown, test } from "./lib/paths.mjs";

if (process.platform !== "darwin") throw new Error("Build this on a Mac with Xcode");
const validate = args.includes("--validate");
const upload = args.includes("--upload");
const given = option("--ipa");
// An upload always builds: the checks below on the commit and its number hold only for a fresh build.
if (given && (upload || !validate)) throw new Error("--ipa is for --validate only; --upload builds the IPA it uploads");

const git = (...parts) => execFileSync("git", parts, { cwd: root, encoding: "utf8" }).trim();
const plist = (file, key) => {
  const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, file], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

// The files Tauri's archive edits. While its edits are on disk, Git skips them (below); a build that
// was killed (SIGKILL, a closed terminal) could not put them back, and Git still skips them, hiding them
// from `git status`. That is undone first, whatever this run does next.
const touched = [
  path.join(appleProject, "koonapin.xcodeproj", "project.pbxproj"),
  path.join(appleProject, "koonapin_iOS", "Info.plist"),
  path.join(appleProject, "koonapin_Share", "Info.plist"),
];
const skipWorktree = (on) => git("update-index", on ? "--skip-worktree" : "--no-skip-worktree", ...touched);
const skipped = git("ls-files", "-v", "--", ...touched).split("\n").filter((line) => /^[Ss] /.test(line));
if (skipped.length > 0) {
  console.warn(`A build that was killed left Git skipping ${skipped.map((line) => path.basename(line.slice(2))).join(" and ")}; it no longer does.`);
}
skipWorktree(false);

const env = loadEnv();
for (const name of ["APPLE_STORE_KEY", "APPLE_STORE_ISSUER", "APPLE_STORE_KEY_PATH"]) {
  if (!env[name]) throw new Error(`${name} is not set: the App Store Connect API key signs and uploads the build (docs/building.md)`);
}
if (!existsSync(env.APPLE_STORE_KEY_PATH)) throw new Error("APPLE_STORE_KEY_PATH names no file");
const team = env.APPLE_TEAM_ID || env.APPLE_SIGNING_IDENTITY?.match(/\(([A-Z0-9]{10})\)$/)?.[1];
if (!team) throw new Error("APPLE_TEAM_ID is not set (and APPLE_SIGNING_IDENTITY names no team)");

const work = mkdtempSync(path.join(os.tmpdir(), "koonapin-ios-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));

/** The key under the name altool looks for (AuthKey_<id>.p8), in a folder of its own. */
function altool(command, ipa) {
  const keys = path.join(work, "private_keys");
  mkdirSync(keys, { recursive: true });
  const link = path.join(keys, `AuthKey_${env.APPLE_STORE_KEY}.p8`);
  if (!existsSync(link)) symlinkSync(path.resolve(env.APPLE_STORE_KEY_PATH), link);
  const result = spawnSync("xcrun", ["altool", command, ipa,
    "--api-key", env.APPLE_STORE_KEY, "--api-issuer", env.APPLE_STORE_ISSUER],
  { stdio: "inherit", env: { ...env, API_PRIVATE_KEYS_DIR: keys } });
  if (result.status !== 0) throw new Error(`altool ${command} failed with status ${result.status}`);
}

if (given) {
  const ipa = path.resolve(given);
  altool("--validate-app", ipa);
  process.exit(0);
}

// A killed build also left Tauri's lines in the files: the team (which must never reach a commit, the
// repository is public) and a build number, which the restore below would save as the original. Both
// are refused until the files are checked out.
const [project, infoPlist] = touched;
const teamLines = (text) => text.split("\n").filter((line) => line.includes("DEVELOPMENT_TEAM")).join("\n");
const headOf = (file) => git("show", `HEAD:${path.relative(root, file).split(path.sep).join("/")}`);
const headInfo = path.join(work, "Info-HEAD.plist");
writeFileSync(headInfo, headOf(infoPlist));
const leftovers = [
  teamLines(readFileSync(project, "utf8")) !== teamLines(headOf(project)) && `DEVELOPMENT_TEAM in ${path.relative(root, project)}`,
  plist(infoPlist, "CFBundleVersion") !== plist(headInfo, "CFBundleVersion") && `CFBundleVersion in ${path.relative(root, infoPlist)}`,
].filter(Boolean);
if (leftovers.length > 0) {
  throw new Error(`A build left ${leftovers.join(" and ")}, not as committed: git checkout -- src-tauri/gen/apple, then build again`);
}

// The build number and whether this commit may reach App Store Connect: scripts/lib/store-build.mjs.
// --build does not make a branch's build publishable: it is for a second upload of the same commit of main.
const build = buildNumber(option("--build"));
const { dirty, clean: publishable } = cleanMain();
if (upload && !publishable) {
  throw new Error(dirty ? "The worktree has changes or new files: an upload is built from a commit as it is"
    : "Upload builds of main only: HEAD is not on origin/main (--build is for a second upload of a commit of main)");
}
if (!publishable) console.warn(`Not a clean commit of origin/main: a test build in ${path.relative(root, test.ios(version))}.`);

requireLlvmTools();

// 1. The archive, by Tauri's CLI, with the files it edits put back afterwards. While Tauri's edits
// are on disk, Git skips the files, so a `git add` elsewhere stages nothing of them.
skipWorktree(true);
const saved = touched.map((file) => [file, readFileSync(file)]);
const restore = () => {
  for (const [file, content] of saved) writeFileSync(file, content);
  skipWorktree(false);
};
const interrupted = () => { restore(); process.exit(130); };
process.on("SIGINT", interrupted);
process.on("SIGTERM", interrupted);
const archive = path.join(appleProject, "build", "koonapin_iOS.xcarchive");
rmSync(archive, { recursive: true, force: true });
try {
  // Not the desktop's Developer ID. With an API key in its environment (Tauri reads the APPLE_API_*
  // names) Tauri archives unsigned (without it Xcode wants an account and a development profile); the
  // export signs. The store key, not notarization's, which a build Mac may not have.
  const tauriEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !/^APPLE_(SIGNING_IDENTITY|CERTIFICATE|API_)/.test(name)));
  const config = JSON.stringify({ bundle: { iOS: { bundleVersion: build } } });
  // The App Store build sells Supporter through StoreKit (feature store-appstore, commercial/koona-appstore).
  const result = spawnSync("bun", ["run", "tauri", "ios", "build", "--target", "aarch64", "--archive-only", "--ci", "--features", "store-appstore", "--config", config], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...tauriEnv, APPLE_DEVELOPMENT_TEAM: team, APPLE_API_KEY: env.APPLE_STORE_KEY,
      APPLE_API_ISSUER: env.APPLE_STORE_ISSUER, APPLE_API_KEY_PATH: path.resolve(env.APPLE_STORE_KEY_PATH),
    },
  });
  if (result.status !== 0) throw new Error(`tauri ios build failed with status ${result.status}`);
} finally {
  restore();
  process.off("SIGINT", interrupted);
  process.off("SIGTERM", interrupted);
}
if (!existsSync(archive)) throw new Error(`The build left no ${path.relative(root, archive)}`);

// The share extension's entitlements (the App Group of its queue) through the export. Tauri archives
// with code signing off when an API key is set and then signs only the app's own binary with a dummy
// certificate, so its entitlements survive `-exportArchive`; an appex left unsigned is exported with
// the profile's defaults alone and loses the App Group (tauri-apps/tauri#15663, open for Tauri 2.12).
// Signing each appex ad hoc with its own entitlements file first keeps them; the export re-signs both
// with the distribution certificate. Harmless once Tauri does it itself.
const archivedApp = path.join(archive, "Products", "Applications", app);
for (const { appex, entitlements } of extensions) {
  const archived = path.join(archivedApp, "PlugIns", appex);
  if (!existsSync(archived)) throw new Error(`The archive has no PlugIns/${appex}`);
  execFileSync("codesign", ["--force", "--sign", "-", "--timestamp=none", "--entitlements", entitlements, archived]);
}

// 2. The export for App Store Connect, signed by Xcode with the key: the team's cloud-managed Apple
// Distribution certificate and an App Store profile it makes or renews. Its own options file per build:
// ExportOptions.plist (debugging) stays as Tauri's Simulator builds want it.
const exportOptions = path.join(work, "ExportOptions.plist");
writeFileSync(exportOptions, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>${team}</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
`);
const exported = path.join(work, "export");
const exportRun = spawnSync("xcodebuild", ["-exportArchive", "-archivePath", archive, "-exportPath", exported,
  "-exportOptionsPlist", exportOptions, "-allowProvisioningUpdates",
  "-authenticationKeyPath", path.resolve(env.APPLE_STORE_KEY_PATH),
  "-authenticationKeyID", env.APPLE_STORE_KEY, "-authenticationKeyIssuerID", env.APPLE_STORE_ISSUER],
{ stdio: "inherit" });
if (exportRun.status !== 0) {
  throw new Error(`The export failed with status ${exportRun.status}. «Cloud signing permission error» means the API key `
    + "has no access to cloud-managed distribution certificates: an Admin key does. «No profiles for 'app.koona.pin.share'» "
    + "with «Authentication failed» means the developer portal lacks the App Group group.app.koona.pin or the extension's id "
    + "with it, which the API key cannot make (docs/building.md).");
}
const ipaName = readdirSync(exported).find((name) => name.endsWith(".ipa"));
if (!ipaName) throw new Error("The export left no IPA");

// 3. The checks, on the app inside the IPA.
const unpacked = path.join(work, "ipa");
execFileSync("ditto", ["-x", "-k", path.join(exported, ipaName), unpacked]);
const bundle = path.join(unpacked, "Payload", app);
const info = path.join(bundle, "Info.plist");
const failures = [];
const expect = (what, actual, wanted) => {
  if (actual !== wanted) failures.push(`${what} is ${actual ?? "missing"}, not ${wanted}`);
};
expect("CFBundleIdentifier", plist(info, "CFBundleIdentifier"), bundleId);
expect("CFBundleShortVersionString", plist(info, "CFBundleShortVersionString"), version);
expect("CFBundleVersion", plist(info, "CFBundleVersion"), build);
expect("MinimumOSVersion", plist(info, "MinimumOSVersion"), "18.0");
expect("ITSAppUsesNonExemptEncryption", plist(info, "ITSAppUsesNonExemptEncryption"), undefined);
const privacy = path.join(bundle, "PrivacyInfo.xcprivacy");
if (!existsSync(privacy)) failures.push("PrivacyInfo.xcprivacy is missing");
else if (spawnSync("plutil", ["-lint", "-s", privacy]).status !== 0) failures.push("PrivacyInfo.xcprivacy is not a valid plist");

if (spawnSync("codesign", ["--verify", "--deep", "--strict", bundle]).status !== 0) failures.push("the signature does not verify");
// codesign -dv writes to stderr; only facts are printed below, never the identity or the team.
const signature = spawnSync("codesign", ["-dv", "--verbose=4", bundle], { encoding: "utf8" }).stderr;
if (!/^Authority=Apple Distribution: /m.test(signature)) failures.push("it is not signed with an Apple Distribution certificate");
if (!signature.includes(`TeamIdentifier=${team}\n`)) failures.push("it is signed by another team");
const entitlementsFile = path.join(work, "entitlements.plist");
writeFileSync(entitlementsFile, execFileSync("codesign", ["-d", "--entitlements", ":-", bundle]));
expect("application-identifier", plist(entitlementsFile, "application-identifier"), `${team}.${bundleId}`);
if (plist(entitlementsFile, "get-task-allow") === "true") failures.push("get-task-allow is on (a development signature)");
expect("beta-reports-active", plist(entitlementsFile, "beta-reports-active"), "true");
const profileFile = path.join(work, "profile.plist");
writeFileSync(profileFile, execFileSync("security", ["cms", "-D", "-i", path.join(bundle, "embedded.mobileprovision")]));
if (plist(profileFile, "ProvisionedDevices") !== undefined) failures.push("the profile lists devices: it is not an App Store profile");
expect("the profile's team", plist(profileFile, "TeamIdentifier:0"), team);
// The App Group on the app and the extension (koona-share's queue), and the extension signed and versioned as the app.
// PlistBuddy prints the array as «Array {», one group per line, «}»: the groups, matched whole.
const groups = (file) =>
  (plist(file, "com.apple.security.application-groups") ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== "Array {" && line !== "}");
if (!groups(entitlementsFile).includes(appGroup)) failures.push(`the app's entitlements have no App Group ${appGroup}`);
for (const { appex, id } of extensions) {
  const extension = path.join(bundle, "PlugIns", appex);
  if (!existsSync(extension)) {
    failures.push(`PlugIns/${appex} is missing`);
    continue;
  }
  const extensionInfo = path.join(extension, "Info.plist");
  expect(`${appex}'s CFBundleIdentifier`, plist(extensionInfo, "CFBundleIdentifier"), id);
  expect(`${appex}'s CFBundleShortVersionString`, plist(extensionInfo, "CFBundleShortVersionString"), version);
  expect(`${appex}'s CFBundleVersion`, plist(extensionInfo, "CFBundleVersion"), build);
  if (!existsSync(path.join(extension, "PrivacyInfo.xcprivacy"))) failures.push(`${appex} has no PrivacyInfo.xcprivacy`);
  const extensionSignature = spawnSync("codesign", ["-dv", "--verbose=4", extension], { encoding: "utf8" }).stderr;
  if (!/^Authority=Apple Distribution: /m.test(extensionSignature)) failures.push(`${appex} is not signed with an Apple Distribution certificate`);
  const extensionEntitlements = path.join(work, `${appex}.entitlements.plist`);
  writeFileSync(extensionEntitlements, execFileSync("codesign", ["-d", "--entitlements", ":-", extension]));
  expect(`${appex}'s application-identifier`, plist(extensionEntitlements, "application-identifier"), `${team}.${id}`);
  if (!groups(extensionEntitlements).includes(appGroup)) failures.push(`${appex}'s entitlements have no App Group ${appGroup} (tauri#15663)`);
  if (plist(extensionEntitlements, "get-task-allow") === "true") failures.push(`${appex}'s get-task-allow is on`);
  if (!existsSync(path.join(extension, "embedded.mobileprovision"))) failures.push(`${appex} has no provisioning profile`);
}
if (failures.length > 0) throw new Error(`The IPA fails its checks:\n- ${failures.join("\n- ")}`);
console.log(`Checked: ${bundleId} ${version} (${build}), Apple Distribution, the team of APPLE_TEAM_ID, an App Store profile, `
  + `no export compliance key, the privacy manifest present; the share extension signed alike, with the App Group ${appGroup}`);

// 4. The IPA, its dSYMs and the checksums of the folder.
const target = publishable ? publish.ios(version) : test.ios(version);
mkdirSync(target, { recursive: true });
const ipa = path.join(target, `KoonaPin-${version}-${build}.ipa`);
const symbols = path.join(target, `KoonaPin-${version}-${build}-dSYMs.zip`);
rmSync(ipa, { force: true });
rmSync(symbols, { force: true });
execFileSync("cp", [path.join(exported, ipaName), ipa]);
const dsyms = path.join(archive, "dSYMs");
if (!existsSync(dsyms) || readdirSync(dsyms).length === 0) throw new Error("The archive has no dSYMs");
execFileSync("ditto", ["-c", "-k", "--keepParent", dsyms, symbols]);
writeChecksums(target);
console.log(`iOS ${version} (${build}), App Store: ${shown(ipa)}`);

if (validate) altool("--validate-app", ipa);
if (upload) altool("--upload-package", ipa);
