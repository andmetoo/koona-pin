// Builds Koona Pin for Android: a release build for arm64 phones. Folders: scripts/lib/paths.mjs.
//   bun run build:android                   the App Bundle (.aab) and a universal APK of arm64 only, checked
//   bun run build:android -- --build <n>    the versionCode instead of the commit count
//   bun run build:android -- --sign-test    a test build signed with the upload key and checked, then nothing
//                                           is copied: it only tries the signing path
//   bun scripts/build-android.mjs --check <apk>   only the 16 KB checks below, of an APK built already (CI)
//   bun run build:android -- --play         with Supporter through Play Billing (feature store-play): its files
//                                           are named koona-pin-<version>-play-<n>.* beside the others
// Needs the Android SDK with platform 37 and an NDK of r28 or newer (16 KB pages by default):
// ANDROID_HOME and NDK_HOME, as ~/.zshrc sets them on the build Mac (doc: docs/building.md), JDK 17 or
// newer (JAVA_HOME, else java and keytool on the PATH) and the Rust target aarch64-linux-android.
// Settings come from the environment or from .env in the repository root, as for the desktop.
//
// Signing (NP-074a). Google Play's upload key is in .env (ANDROID_UPLOAD_KEYSTORE, a PKCS12 file;
// ANDROID_UPLOAD_KEYSTORE_PASSWORD; ANDROID_UPLOAD_KEY_ALIAS), and Play signs what it delivers with the
// app signing key it keeps (Play App Signing). Gradle signs with the upload key only a build of a clean
// commit of origin/main: its AAB goes to release/publish/android/<version>/ for Play Console, and its APK
// stays in Gradle's folder (phones refuse Play's updates over an APK of the upload key). Any other build
// (no key, a branch, a worktree with changes) is signed with the debug key, which Play refuses, and both
// files go to release/test/android/<version>/. --sign-test signs such a test build with the upload key to
// try the signing path and copies nothing, so no AAB of the upload key waits outside release/publish.
// For a build with the upload key Gradle runs without its configuration cache and without a daemon, so
// the password is neither stored in src-tauri/gen/android/.gradle nor kept in a process that outlives it.
// A build for Play does not overwrite one of the same number: what was uploaded stays as it was.
//
// Build numbers as for iOS (build-ios.mjs): versionName is the app's version, versionCode the number of
// commits up to HEAD (`git rev-list --count HEAD`), so a build of the same commit has the same number on
// both phones. Play refuses a versionCode it has seen, so a second upload of a commit takes `--build`
// with a higher number.
//
// Both files are checked before they are copied: the package, the version, the SDK levels, not
// debuggable, the signer (the upload key when it is set), bundletool's validation of the AAB (BUNDLETOOL,
// the path of bundletool-all-<version>.jar; required for Play), and Android's 16 KB pages (zipalign keeps
// every uncompressed native library on a 16 KB boundary, and its ELF LOAD segments are 16 KB aligned).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkBilling } from "./check-apk-billing.mjs";
import { args, buildNumber, cleanMain, option, writeChecksums } from "./lib/store-build.mjs";
import { loadEnv } from "./lib/env.mjs";
import { publish, root, test } from "./lib/paths.mjs";

const env = loadEnv();
const sdk = env.ANDROID_HOME;
const ndk = env.NDK_HOME;
if (!sdk || !ndk) throw new Error("Set ANDROID_HOME and NDK_HOME (the Android SDK and its NDK)");
const version = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
// What the APK must say, from the Gradle file that sets it (one place to change the SDK levels).
const gradleFile = readFileSync(path.join(root, "src-tauri", "gen", "android", "app", "build.gradle.kts"), "utf8");
const gradleValue = (name) => {
  const value = gradleFile.match(new RegExp(`^\\s*${name} = "?([\\w.]+)"?\\s*$`, "m"))?.[1];
  if (!value) throw new Error(`build.gradle.kts sets no ${name}`);
  return value;
};
const packageName = gradleValue("applicationId");
const minSdk = gradleValue("minSdk");
const targetSdk = gradleValue("targetSdk");
const exe = (name) => (process.platform === "win32" ? `${name}.exe` : name);
const jdk = (name) => (env.JAVA_HOME ? path.join(env.JAVA_HOME, "bin", exe(name)) : name);


const outputs = path.join(root, "src-tauri", "gen", "android", "app", "build", "outputs");
const checkOnly = args.includes("--check");
const apk = checkOnly
  ? path.resolve(option("--check"))
  : path.join(outputs, "apk", "universal", "release", "app-universal-release.apk");
const aab = path.join(outputs, "bundle", "universalRelease", "app-universal-release.aab");

/** The newest build-tools of the SDK: zipalign, aapt2 and apksigner live there. */
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
  const readelf = path.join(prebuilt, host, "bin", exe("llvm-readelf"));
  const work = path.join(root, "src-tauri", "target", "android-check");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  // Windows has no unzip; its tar (bsdtar) reads ZIP files.
  if (process.platform === "win32") execFileSync("tar", ["-xf", apk, "-C", work, "lib"]);
  else execFileSync("unzip", ["-q", "-o", apk, "lib/*", "-d", work]);
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

/**
 * The plugin's RendererWatch (src-tauri/plugins/koona-mobile) wraps wry's RustWebViewClient and forwards
 * each callback by hand: every method wry overrides must be forwarded, or the app loses it silently. The
 * wry in Cargo.lock is read through cargo metadata, so an update of wry that adds an override fails here.
 */
function checkWryClient() {
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--locked",
    "--manifest-path", path.join(root, "src-tauri", "Cargo.toml"), "--filter-platform", "aarch64-linux-android"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const wry = metadata.packages.find((p) => p.name === "wry");
  if (!wry) throw new Error("wry is not in the Android build");
  const client = readFileSync(path.join(path.dirname(wry.manifest_path), "src", "android", "kotlin", "RustWebViewClient.kt"), "utf8");
  const watch = readFileSync(path.join(root, "src-tauri", "plugins", "koona-mobile", "android", "src", "main", "java",
    "app", "koona", "pin", "mobile", "KoonaMobilePlugin.kt"), "utf8");
  const overrides = (text) => new Set([...text.matchAll(/override fun (\w+)\(/g)].map((m) => m[1]));
  const forwarded = overrides(watch.slice(watch.indexOf("class RendererWatch")));
  const missing = [...overrides(client)].filter((name) => !forwarded.has(name));
  if (missing.length) throw new Error(`wry ${wry.version}'s RustWebViewClient overrides ${missing.join(", ")}, which RendererWatch does not forward`);
  console.log(`RendererWatch forwards every override of wry ${wry.version}'s RustWebViewClient`);
}

/** Android's 16 KB pages: every uncompressed library on a 16 KB boundary, and its LOAD segments too. */
function check16k() {
  if (!existsSync(apk)) throw new Error(`No APK at ${apk}`);
  execFileSync(path.join(buildTools(), exe("zipalign")), ["-c", "-P", "16", "4", apk], { stdio: "inherit" });
  console.log(`${path.basename(apk)}: zipalign -P 16 passes`);
  checkLoadAlignment();
}

if (checkOnly) {
  checkWryClient();
  check16k();
  process.exit(0);
}

// The upload key: all three settings or none. The password reaches keytool and Gradle through the
// environment only, never on a command line.
const hasKey = Boolean(env.ANDROID_UPLOAD_KEYSTORE);
const signTest = args.includes("--sign-test");
if (signTest && !hasKey) throw new Error("--sign-test needs the upload key in .env (docs/building.md)");
if (hasKey) {
  for (const name of ["ANDROID_UPLOAD_KEYSTORE_PASSWORD", "ANDROID_UPLOAD_KEY_ALIAS"]) {
    if (!env[name]) throw new Error(`ANDROID_UPLOAD_KEYSTORE is set but ${name} is not (docs/building.md)`);
  }
  env.ANDROID_UPLOAD_KEYSTORE = path.resolve(root, env.ANDROID_UPLOAD_KEYSTORE);
  if (!existsSync(env.ANDROID_UPLOAD_KEYSTORE)) throw new Error("ANDROID_UPLOAD_KEYSTORE names no file");
}

// The versionCode and whether this commit may reach Play: scripts/lib/store-build.mjs. Without the upload
// key a build is for testing whatever the commit, so main is not fetched for it.
const build = buildNumber(option("--build"));
const { dirty, clean } = hasKey ? cleanMain() : { dirty: false, clean: false };
const publishable = hasKey && clean;
const upload = publishable || signTest;
// The Play build sells through Play Billing (NP-154); without --play the APK has no billing library and
// no BILLING permission, which is checked. Its files carry -play, so the one uploaded is never the other.
const play = process.argv.includes("--play");
const suffix = play ? "-play" : "";
const published = path.join(publish.android(version), `koona-pin-${version}${suffix}-${build}.aab`);
if (publishable && existsSync(published)) {
  throw new Error(`${path.relative(root, published)} exists: Play has seen or may have seen that number. Pass --build with a higher one, `
    + "or delete the file if it was never uploaded");
}
if (!publishable) {
  const why = !hasKey ? "no upload key in .env" : dirty ? "the worktree has changes or new files" : "HEAD is not on origin/main";
  console.warn(`Not for Play (${why}): a test build in ${path.relative(root, test.android(version))}, `
    + `signed with the ${upload ? "upload key (--sign-test)" : "debug key"}.`);
}

rmSync(apk, { force: true });
rmSync(aab, { force: true });
checkWryClient();
const work = mkdtempSync(path.join(os.tmpdir(), "koonapin-android-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
// The versionCode through a config file: JSON on the command line loses its quotes on Windows.
const config = path.join(work, "tauri.version.json");
writeFileSync(config, JSON.stringify({ bundle: { android: { versionCode: Number(build) } } }));
// Gradle signs with the upload key when the environment has it (gen/android/app/build.gradle.kts). Its
// configuration cache would store the password and a daemon would keep it for hours, so neither then.
const gradleEnv = upload
  ? { ...env, GRADLE_OPTS: `${env.GRADLE_OPTS ?? ""} -Dorg.gradle.configuration-cache=false -Dorg.gradle.daemon=false`.trim() }
  : Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("ANDROID_UPLOAD_")));
const result = spawnSync("bun", ["run", "tauri", "android", "build", "--target", "aarch64", "--apk", "--aab", "--config", config, ...(play ? ["--features", "store-play"] : [])], {
  cwd: root, stdio: "inherit", env: gradleEnv,
});
if (result.status !== 0) throw new Error(`tauri android build failed with status ${result.status}`);
for (const file of [apk, aab]) if (!existsSync(file)) throw new Error(`The build left no ${path.relative(root, file)}`);

// The checks. Certificates are compared by their SHA-256 and never printed: the repository is public.
const failures = [];
const expect = (what, actual, wanted) => {
  if (actual !== wanted) failures.push(`${what} is ${actual ?? "missing"}, not ${wanted}`);
};
const badging = execFileSync(path.join(buildTools(), exe("aapt2")), ["dump", "badging", apk], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const field = (pattern) => badging.match(pattern)?.[1];
expect("the package", field(/^package: name='([^']+)'/m), packageName);
expect("versionCode", field(/^package: .*versionCode='(\d+)'/m), build);
expect("versionName", field(/^package: .*versionName='([^']+)'/m), version);
expect("minSdkVersion", field(/^(?:minSdkVersion|sdkVersion):'(\d+)'/m), minSdk);
expect("targetSdkVersion", field(/^targetSdkVersion:'(\d+)'/m), targetSdk);
if (/^application-debuggable/m.test(badging)) failures.push("the APK is debuggable");

/** Each certificate in PEM text, as keytool -rfc prints them: its base64, without line breaks. */
const pemCertificates = (text) => [...text.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/g)]
  .map((m) => m[1].replace(/\s+/g, ""));
// keytool in English whatever the system's language, so its errors read the same everywhere.
const keytool = (...parts) => execFileSync(jdk("keytool"), ["-J-Duser.language=en", ...parts], { encoding: "utf8", env });
const aabCertificates = pemCertificates(keytool("-printcert", "-rfc", "-jarfile", aab));
// apksigner names the APK's signer by the SHA-256 of its certificate.
const aabSigners = aabCertificates.map((base64) => createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex"));
if (spawnSync(jdk("jarsigner"), ["-verify", aab], { stdio: "ignore" }).status !== 0) failures.push("the AAB's signature does not verify");
const apksigner = spawnSync(jdk("java"), ["-jar", path.join(buildTools(), "lib", "apksigner.jar"), "verify", "--print-certs", apk], { encoding: "utf8" });
if (apksigner.status !== 0) failures.push("the APK's signature does not verify");
const apkSigners = [...apksigner.stdout.matchAll(/certificate SHA-256 digest: ([0-9a-f]{64})/g)].map((m) => m[1]);
if (aabSigners.length !== 1 || apkSigners.length !== 1) failures.push("the AAB and the APK must have one signer each");
else if (aabSigners[0] !== apkSigners[0]) failures.push("the AAB and the APK are signed with different keys");
if (upload) {
  // The upload key's certificate as it is, compared with the AAB's.
  const [key] = pemCertificates(keytool("-exportcert", "-rfc", "-keystore", env.ANDROID_UPLOAD_KEYSTORE, "-storetype", "pkcs12",
    "-storepass:env", "ANDROID_UPLOAD_KEYSTORE_PASSWORD", "-alias", env.ANDROID_UPLOAD_KEY_ALIAS));
  if (!key || aabCertificates[0] !== key) failures.push("the AAB is not signed with the upload key of ANDROID_UPLOAD_KEYSTORE");
}
// bundletool's validation of the AAB, which Play Console runs on upload. BUNDLETOOL names its
// bundletool-all-<version>.jar (github.com/google/bundletool/releases); a build for Play needs it.
if (env.BUNDLETOOL) {
  const validated = spawnSync(jdk("java"), ["-jar", path.resolve(env.BUNDLETOOL), "validate", "--bundle", aab], { encoding: "utf8" });
  if (validated.status !== 0) failures.push(`bundletool validate fails: ${validated.stderr.trim().split("\n")[0]}`);
} else if (publishable) failures.push("BUNDLETOOL is not set: a build for Play is validated with bundletool");
else console.warn("BUNDLETOOL is not set: the AAB is not validated with bundletool");
if (failures.length > 0) throw new Error(`The build fails its checks:\n- ${failures.join("\n- ")}`);
console.log(`Checked: ${packageName} ${version} (${build}), SDK ${minSdk}–${targetSdk}, not debuggable, `
  + `${upload ? "signed with the upload key" : "signed with the debug key"}${env.BUNDLETOOL ? ", bundletool validate passes" : ""}`);
check16k();
checkBilling(apk, play ? "present" : "absent");
if (signTest && !publishable) {
  console.log("--sign-test: signed with the upload key and checked; nothing is copied");
  process.exit(0);
}

// The files, and the checksums of the folder. Every build number of the version side by side, as for iOS.
const target = publishable ? publish.android(version) : test.android(version);
mkdirSync(target, { recursive: true });
// An APK of the upload key is never copied: a phone with it refuses Play's updates.
const names = publishable
  ? { [aab]: `koona-pin-${version}${suffix}-${build}.aab` }
  : { [aab]: `koona-pin-${version}${suffix}-${build}.aab`, [apk]: `koona-pin-${version}${suffix}-${build}-arm64.apk` };
for (const [file, name] of Object.entries(names)) copyFileSync(file, path.join(target, name));
writeChecksums(target);
console.log(`Android ${version}${play ? " with Play Billing" : ""} (${build}), ${publishable ? "for Play" : "test"}: ${path.relative(root, target)}`);
