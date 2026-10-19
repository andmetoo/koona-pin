// What the iOS builds share (build-ios-sim.mjs, build-ios.mjs): the app's version and name, and the
// tools a release build of the Rust side needs.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { root } from "./paths.mjs";

/** The version of the bundle is the one in tauri.conf.json, as for the other platforms' builds. */
export const version = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
export const app = "Koona Pin.app";
export const bundleId = "app.koona.pin";
export const appleProject = path.join(root, "src-tauri", "gen", "apple");

/**
 * A release build needs rustup's llvm-tools: swift-rs uses its llvm-objcopy to keep the plugins' Swift
 * entry points exported, which Xcode 27 would otherwise hide, and the link fails
 * («Undefined symbols … _init_plugin_…»).
 */
export function requireLlvmTools() {
  const sysroot = execFileSync("rustc", ["--print", "sysroot"], { cwd: root, encoding: "utf8" }).trim();
  const host = execFileSync("rustc", ["-vV"], { cwd: root, encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];
  if (!existsSync(path.join(sysroot, "lib", "rustlib", host ?? "", "bin", "llvm-objcopy"))) {
    const toolchain = path.basename(sysroot);
    throw new Error(`A release build needs llvm-objcopy. Install it with: rustup component add llvm-tools --toolchain ${toolchain}`);
  }
}
