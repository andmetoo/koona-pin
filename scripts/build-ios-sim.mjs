// Builds Koona Pin for the iOS Simulator on Apple Silicon (NP-151), never published: no team, no
// profile, nothing for a device or the App Store (that is build-ios.mjs). Folders: scripts/lib/paths.mjs.
//   bun run build:ios:sim              release → release/test/ios-simulator/<version>/Koona Pin.app
//   bun run build:ios:sim -- --debug   the same, debug
//   bun run build:ios:sim -- --appstore   with Supporter through StoreKit (feature store-appstore); its
//                                        test products come from src-tauri/gen/apple/Supporter.storekit
//                                        only in a Debug Run from Xcode (the scheme), not with simctl
// Needs Xcode with the Simulator runtime of its SDK (the Tauri CLI refuses an older one), XcodeGen and
// CocoaPods, and the Rust target aarch64-apple-ios-sim. A release build also needs rustup's llvm-tools
// (scripts/lib/ios.mjs). Settings for the Rust side come from .env as for the desktop. Install it with
// `xcrun simctl install booted "<path>"`.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { app, appleProject, requireLlvmTools, version } from "./lib/ios.mjs";
import { root, test } from "./lib/paths.mjs";

if (process.platform !== "darwin") throw new Error("Build this on a Mac with Xcode");
const debug = process.argv.includes("--debug");
const appstore = process.argv.includes("--appstore");
const built = path.join(appleProject, "build", "arm64-sim", app);

if (!debug) requireLlvmTools();
rmSync(built, { recursive: true, force: true });
execFileSync("bun", ["run", "tauri", "ios", "build", "--target", "aarch64-sim", ...(debug ? ["--debug"] : []), ...(appstore ? ["--features", "store-appstore"] : [])], {
  cwd: root,
  stdio: "inherit",
});
if (!existsSync(built)) throw new Error(`The build left no ${path.relative(root, built)}`);

const target = test.iosSimulator(version);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(built, path.join(target, app), { recursive: true, verbatimSymlinks: true });
const size = execFileSync("du", ["-sk", path.join(target, app)], { encoding: "utf8" }).split("\t")[0];
console.log(`iOS Simulator ${version} (${debug ? "debug" : "release"}${appstore ? ", App Store purchases" : ""}, arm64): ${path.relative(root, target)}, ${(Number(size) / 1024).toFixed(1)} MiB`);
