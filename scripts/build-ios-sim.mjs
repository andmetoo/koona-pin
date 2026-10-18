// Builds Koona Pin for the iOS Simulator on Apple Silicon (NP-151), never published: no team, no
// profile, nothing for a device or the App Store. Folders: scripts/lib/paths.mjs.
//   bun run build:ios:sim              release → release/test/ios-simulator/<version>/Koona Pin.app
//   bun run build:ios:sim -- --debug   the same, debug
// Needs Xcode with the Simulator runtime of its SDK (the Tauri CLI refuses an older one), XcodeGen and
// CocoaPods, and the Rust target aarch64-apple-ios-sim. A release build also needs rustup's llvm-tools:
// swift-rs uses its llvm-objcopy to keep the plugins' Swift entry points exported, which Xcode 27 would
// otherwise hide, and the link fails («Undefined symbols … _init_plugin_…»). Settings for the Rust side
// come from .env as for the desktop. Install it with `xcrun simctl install booted "<path>"`.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { root, test } from "./lib/paths.mjs";

if (process.platform !== "darwin") throw new Error("Build this on a Mac with Xcode");
const debug = process.argv.includes("--debug");
const version = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
const app = "Koona Pin.app";
const built = path.join(root, "src-tauri", "gen", "apple", "build", "arm64-sim", app);

if (!debug) {
  const sysroot = execFileSync("rustc", ["--print", "sysroot"], { cwd: root, encoding: "utf8" }).trim();
  const host = execFileSync("rustc", ["-vV"], { cwd: root, encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];
  if (!existsSync(path.join(sysroot, "lib", "rustlib", host ?? "", "bin", "llvm-objcopy")))
    throw new Error("A release build needs llvm-objcopy: rustup component add llvm-tools");
}
rmSync(built, { recursive: true, force: true });
execFileSync("bun", ["run", "tauri", "ios", "build", "--target", "aarch64-sim", ...(debug ? ["--debug"] : [])], {
  cwd: root,
  stdio: "inherit",
});
if (!existsSync(built)) throw new Error(`The build left no ${path.relative(root, built)}`);

const target = test.iosSimulator(version);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(built, path.join(target, app), { recursive: true, verbatimSymlinks: true });
const size = execFileSync("du", ["-sk", path.join(target, app)], { encoding: "utf8" }).split("\t")[0];
console.log(`iOS Simulator ${version} (${debug ? "debug" : "release"}, arm64): ${path.relative(root, target)}, ${(Number(size) / 1024).toFixed(1)} MiB`);
