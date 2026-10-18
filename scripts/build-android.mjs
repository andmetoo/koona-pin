// Builds Koona Pin for Android (NP-151): a release build for arm64 phones, signed with the debug key
// until store signing exists, never published. Folders: scripts/lib/paths.mjs.
//   bun run build:android   the App Bundle (.aab) and a universal APK of arm64 only →
//                           release/test/android/<version>/ with SHA256SUMS.txt
// Needs the Android SDK with platform 37 and an NDK of r28 or newer (16 KB pages by default):
// ANDROID_HOME and NDK_HOME, as ~/.zshrc sets them on the build Mac (doc: docs/building.md), and the
// Rust target aarch64-linux-android. Settings for the Rust side come from .env as for the desktop.
// Both files are checked for Android's 16 KB pages before they are copied: zipalign keeps every
// uncompressed native library on a 16 KB boundary, and its ELF LOAD segments are 16 KB aligned.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { root, test } from "./lib/paths.mjs";

const sdk = process.env.ANDROID_HOME;
const ndk = process.env.NDK_HOME;
if (!sdk || !ndk) throw new Error("Set ANDROID_HOME and NDK_HOME (the Android SDK and its NDK)");
const version = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
const run = (program, args) => execFileSync(program, args, { cwd: root, stdio: "inherit" });
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const outputs = path.join(root, "src-tauri", "gen", "android", "app", "build", "outputs");
const apk = path.join(outputs, "apk", "universal", "release", "app-universal-release.apk");
const aab = path.join(outputs, "bundle", "universalRelease", "app-universal-release.aab");
rmSync(apk, { force: true });
rmSync(aab, { force: true });
run("bun", ["run", "tauri", "android", "build", "--target", "aarch64", "--apk", "--aab"]);
for (const file of [apk, aab]) if (!existsSync(file)) throw new Error(`The build left no ${path.relative(root, file)}`);

/** The newest build-tools of the SDK: zipalign lives there. */
function buildTools() {
  const folder = path.join(sdk, "build-tools");
  const newest = readdirSync(folder).sort((a, b) => a.localeCompare(b, "en", { numeric: true })).at(-1);
  if (!newest) throw new Error(`No build-tools in ${folder}`);
  return path.join(folder, newest);
}

/** The LOAD segments of every native library in the APK are aligned to 16 KB (0x4000) or more. */
function checkLoadAlignment() {
  const prebuilt = path.join(ndk, "toolchains", "llvm", "prebuilt");
  const host = readdirSync(prebuilt)[0];
  const readelf = path.join(prebuilt, host, "bin", "llvm-readelf");
  const work = path.join(root, "src-tauri", "target", "android-check");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync("unzip", ["-q", "-o", apk, "lib/*", "-d", work]);
  const libraries = readdirSync(path.join(work, "lib"), { recursive: true }).filter((name) => name.endsWith(".so"));
  if (libraries.length === 0) throw new Error("The APK has no native libraries");
  for (const library of libraries) {
    const headers = execFileSync(readelf, ["-lW", path.join(work, "lib", library)], { encoding: "utf8" });
    const loads = headers.split("\n").filter((line) => line.trim().startsWith("LOAD"));
    const small = loads.filter((line) => Number(line.trim().split(/\s+/).at(-1)) < 0x4000);
    if (loads.length === 0 || small.length > 0) throw new Error(`${library}: LOAD segments are not 16 KB aligned`);
    console.log(`${library}: ${loads.length} LOAD segments, 16 KB aligned`);
  }
  rmSync(work, { recursive: true, force: true });
}

run(path.join(buildTools(), "zipalign"), ["-c", "-P", "16", "-v", "4", apk]);
checkLoadAlignment();

const target = test.android(version);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
const names = { [apk]: `koona-pin-${version}-arm64.apk`, [aab]: `koona-pin-${version}.aab` };
for (const [file, name] of Object.entries(names)) copyFileSync(file, path.join(target, name));
writeFileSync(
  path.join(target, "SHA256SUMS.txt"),
  Object.values(names).map((name) => `${sha256(path.join(target, name))}  ${name}\n`).join(""),
);
console.log(`Android ${version} (debug-signed, arm64): ${path.relative(root, target)}`);
