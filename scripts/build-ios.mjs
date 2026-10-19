// Builds Koona Pin for the App Store (NP-078): an iPhone build signed for distribution, for TestFlight
// and App Store Connect. The Simulator's build is build-ios-sim.mjs. Folders: scripts/lib/paths.mjs.
//   bun run build:ios                    archive, export and check → release/publish/ios/<version>/
//                                        KoonaPin-<version>-<build>.ipa, its dSYMs in a ZIP, SHA256SUMS.txt
//   bun run build:ios -- --build <n>     the build number (CFBundleVersion) instead of the commit count
//   bun run build:ios -- --validate      then App Store Connect's validation of the IPA (altool)
//   bun run build:ios -- --upload        then the upload to App Store Connect (altool)
//   bun scripts/build-ios.mjs --ipa <file> --validate|--upload   the same for an IPA built already
//
// Build numbers: CFBundleShortVersionString is the app's version; CFBundleVersion is the number of
// commits up to HEAD (`git rev-list --count HEAD`), so every commit of main builds a higher number, for
// iOS and later for Android's versionCode. A second upload of the same commit takes `--build` with a
// higher number. Upload only builds of main: a branch's count can pass a later commit of main.
//
// Signing is Xcode's automatic, cloud-managed signing through the App Store Connect API key, with no
// certificate or profile in the repository: APPLE_STORE_KEY, APPLE_STORE_ISSUER and APPLE_STORE_KEY_PATH (a
// key with access to cloud-managed distribution certificates: the Admin role), and APPLE_TEAM_ID (else
// the team in APPLE_SIGNING_IDENTITY's parentheses). Settings come from the environment or from .env in
// the repository root; a variable already set in the environment wins. Needs what build-ios-sim.mjs
// needs, with the Rust target aarch64-apple-ios instead of the Simulator's.
//
// Tauri's CLI runs the archive (Xcode's «Build Rust Code» phase talks to it) and writes the team and the
// build number into the committed Xcode project and Info.plist; this script puts both files back as they
// were, whatever happens. The archive is not signed; the export signs it.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, appleProject, bundleId, requireLlvmTools, version } from "./lib/ios.mjs";
import { publish, root } from "./lib/paths.mjs";

if (process.platform !== "darwin") throw new Error("Build this on a Mac with Xcode");
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
};
const validate = args.includes("--validate");
const upload = args.includes("--upload");
const given = option("--ipa");
if (given && !validate && !upload) throw new Error("--ipa is for --validate or --upload");

const dotenv = path.join(root, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);
const env = process.env;
// An Apple variable set but empty counts as unset, as in build-macos.mjs.
for (const name of Object.keys(env)) if (name.startsWith("APPLE_") && !env[name]) delete env[name];
for (const name of ["APPLE_STORE_KEY", "APPLE_STORE_ISSUER", "APPLE_STORE_KEY_PATH"]) {
  if (!env[name]) throw new Error(`${name} is not set: the App Store Connect API key signs and uploads the build (docs/building.md)`);
}
if (!existsSync(env.APPLE_STORE_KEY_PATH)) throw new Error("APPLE_STORE_KEY_PATH names no file");
const team = env.APPLE_TEAM_ID || env.APPLE_SIGNING_IDENTITY?.match(/\(([A-Z0-9]{10})\)$/)?.[1];
if (!team) throw new Error("APPLE_TEAM_ID is not set (and APPLE_SIGNING_IDENTITY names no team)");

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const git = (...parts) => execFileSync("git", parts, { cwd: root, encoding: "utf8" }).trim();
const plist = (file, key) => {
  const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, file], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
};
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
  if (validate) altool("--validate-app", ipa);
  if (upload) altool("--upload-package", ipa);
  process.exit(0);
}

// The build number: --build, else the commit count of HEAD.
let build = option("--build");
if (build === undefined) {
  if (git("rev-parse", "--is-shallow-repository") === "true") throw new Error("A shallow clone has no commit count: fetch the history or pass --build");
  build = git("rev-list", "--count", "HEAD");
}
if (!/^[1-9]\d{0,8}$/.test(build)) throw new Error(`The build number must be a positive whole number, not «${build}»`);
if (git("status", "--porcelain", "--untracked-files=no")) console.warn("The worktree has changes: this build is not the commit's.");

requireLlvmTools();

// 1. The archive, by Tauri's CLI, with the two files it edits put back afterwards.
const touched = [
  path.join(appleProject, "koonapin.xcodeproj", "project.pbxproj"),
  path.join(appleProject, "koonapin_iOS", "Info.plist"),
];
const saved = touched.map((file) => [file, readFileSync(file)]);
const restore = () => { for (const [file, content] of saved) writeFileSync(file, content); };
const interrupted = () => { restore(); process.exit(130); };
process.on("SIGINT", interrupted);
process.on("SIGTERM", interrupted);
const archive = path.join(appleProject, "build", "koonapin_iOS.xcarchive");
rmSync(archive, { recursive: true, force: true });
try {
  // Not the desktop's Developer ID. With the API key in its environment Tauri archives unsigned
  // (without it Xcode wants an account and a development profile); the export signs.
  const tauriEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !/^APPLE_(SIGNING_IDENTITY|CERTIFICATE)/.test(name)));
  const config = JSON.stringify({ bundle: { iOS: { bundleVersion: build } } });
  const result = spawnSync("bun", ["run", "tauri", "ios", "build", "--target", "aarch64", "--archive-only", "--ci", "--config", config], {
    cwd: root, stdio: "inherit", env: { ...tauriEnv, APPLE_DEVELOPMENT_TEAM: team },
  });
  if (result.status !== 0) throw new Error(`tauri ios build failed with status ${result.status}`);
} finally {
  restore();
  process.off("SIGINT", interrupted);
  process.off("SIGTERM", interrupted);
}
if (!existsSync(archive)) throw new Error(`The build left no ${path.relative(root, archive)}`);

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
    + "has no access to cloud-managed distribution certificates: an Admin key does (docs/building.md).");
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
expect("ITSAppUsesNonExemptEncryption", plist(info, "ITSAppUsesNonExemptEncryption"), "true");
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
if (failures.length > 0) throw new Error(`The IPA fails its checks:\n- ${failures.join("\n- ")}`);
console.log(`Checked: ${bundleId} ${version} (${build}), Apple Distribution, the team of APPLE_TEAM_ID, an App Store profile, `
  + "export compliance and the privacy manifest present");

// 4. The IPA, its dSYMs and the checksums of the folder.
const target = publish.ios(version);
mkdirSync(target, { recursive: true });
const ipa = path.join(target, `KoonaPin-${version}-${build}.ipa`);
const symbols = path.join(target, `KoonaPin-${version}-${build}-dSYMs.zip`);
rmSync(ipa, { force: true });
rmSync(symbols, { force: true });
execFileSync("cp", [path.join(exported, ipaName), ipa]);
const dsyms = path.join(archive, "dSYMs");
if (!existsSync(dsyms) || readdirSync(dsyms).length === 0) throw new Error("The archive has no dSYMs");
execFileSync("ditto", ["-c", "-k", "--keepParent", dsyms, symbols]);
const files = readdirSync(target).filter((name) => name !== "SHA256SUMS.txt").sort();
writeFileSync(path.join(target, "SHA256SUMS.txt"), files.map((name) => `${sha256(path.join(target, name))}  ${name}\n`).join(""));
console.log(`iOS ${version} (${build}), App Store: ${path.relative(root, ipa)}`);

if (validate) altool("--validate-app", ipa);
if (upload) altool("--upload-package", ipa);
