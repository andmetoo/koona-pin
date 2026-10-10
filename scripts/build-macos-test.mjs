// Experimental unsigned .app, with explicit test-only WKWebView automation; never published.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { root, test } from "./lib/paths.mjs";

if (process.platform !== "darwin") throw new Error("Build this on a Mac or the macOS Actions runner");
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const output = test.macos(version, process.arch);
const run = (program, args, options = {}) => execFileSync(program, args, { cwd: root, stdio: "inherit", ...options });
run("bun", ["run", "tauri", "build", "--config", "src-tauri/tauri.macos-test.conf.json", "--features", "macos-smoke", "--bundles", "app"]);
mkdirSync(output, { recursive: true });
const app = "Koona Pin.app";
cpSync(path.join(root, "src-tauri", "target", "release", "bundle", "macos", app), path.join(output, app), { recursive: true });
const archive = `koonapin-${version}-macos-${process.arch}-test.zip`;
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive], { cwd: output });
const sha = createHash("sha256").update(readFileSync(path.join(output, archive))).digest("hex");
writeFileSync(path.join(output, "SHA256SUMS.txt"), `${sha}  ${archive}\n`);
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
writeFileSync(path.join(output, "build.json"), JSON.stringify({ version, commit, arch: process.arch, platform: process.platform,
  os: execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(), features: ["custom-protocol", "macos-smoke"],
  signedRelease: false, notarized: false }, null, 2));
writeFileSync(path.join(output, "README.txt"), `Koona Pin ${version}, macOS ${process.arch}, test build from ${commit}\n\nExtract the ZIP preserving the .app directory and open Koona Pin.app.\nThis is an experimental test bundle, without Developer ID signing or notarization.\nIt is not a public release; Gatekeeper may require the Mac owner's explicit approval.\nBrowser capture and in-app updates are not implemented on macOS yet.\nThe macos-smoke feature stays inactive without explicit test environment variables.\nSupported macOS versions, native window/menu/shortcuts and release signing remain #56.\n\nAutomated checks and real WKWebView screenshots are in the macos-evidence artifact.\n`);
console.log(output);
