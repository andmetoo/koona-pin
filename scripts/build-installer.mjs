// Builds the Windows installer (NP-037, Р-9): NSIS per user, with --features public-release
// (the native host accepts only the store extensions, feedback must have its address).
//   bun scripts/build-installer.mjs          unsigned → release/test/windows/<version>/, test machines only
//   bun scripts/build-installer.mjs --sign   signed in Certum SimplySign (scripts/sign-windows.ps1) →
//                                             release/publish/windows/<version>/
// Each folder gets the installer and SHA256SUMS.txt (folders: scripts/lib/paths.mjs).
// Settings come from the environment or from .env in the repository root (.env.example);
// a variable already set in the environment wins.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { nsisBundle as dir, publish, root, test } from "./lib/paths.mjs";

const sign = process.argv.includes("--sign");

// Cargo (option_env! in feedback.rs) and Tauri's signCommand inherit these.
const dotenv = path.join(root, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

if (!process.env.KOONAPIN_FEEDBACK_URL) {
  console.error("KOONAPIN_FEEDBACK_URL is not set: the installer build does not compile without it (supabase/README.md).");
  process.exit(1);
}
const signScript = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "sign-windows.ps1")];
// The certificate is in the store only while SimplySign Desktop is signed in: check before the
// long build rather than fail at its first signature.
if (sign && spawnSync("powershell", [...signScript, "-Check"], { stdio: "inherit" }).status !== 0) {
  console.error("--sign needs SIGN_CERT_SHA1, signtool and SimplySign Desktop signed in (.env.example).");
  process.exit(1);
}

// tauri.conf.json keeps bundling off, so `bun run tauri build` makes no installer: the only
// installer of a version in the bundle folder is one this script built with public-release.
const bundle = { active: true };
if (sign) {
  // Tauri signs the app, the host, the uninstaller and the installer with it (%1 is the file).
  bundle.windows = { signCommand: { cmd: "powershell", args: [...signScript, "%1"] } };
}
const conf = JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const ofThisVersion = async () => (existsSync(dir) ? (await readdir(dir)).filter((file) => file.endsWith(".exe") && file.includes(`_${conf.version}_`)) : []);
// An installer left from an earlier build must not pass for this one.
for (const old of await ofThisVersion()) await rm(path.join(dir, old));

const tauri = path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const args = [tauri, "build", "--bundles", "nsis", "--features", "public-release", "--config", JSON.stringify({ bundle })];
const build = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const [installer] = await ofThisVersion();
if (!installer) {
  console.error(`No installer for ${conf.version} in ${dir}`);
  process.exit(1);
}
// Out of Tauri's working folder into release/, with its hash and where it came from.
const out = sign ? publish.windows(conf.version) : test.windows(conf.version);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const file = path.join(out, installer);
await copyFile(path.join(dir, installer), file);
const sha256 = createHash("sha256").update(await readFile(file)).digest("hex");
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim();
const dirty = git("status", "--porcelain", "--untracked-files=no") ? " with uncommitted changes" : "";
await writeFile(
  path.join(out, "SHA256SUMS.txt"),
  `${sha256}  ${installer}\n\n${sign ? "signed" : "unsigned, for a test machine only"}; commit ${git("rev-parse", "--short", "HEAD")}${dirty}; built ${new Date().toISOString()}\n`,
);
console.log(`\n${path.relative(root, file)}\nSHA-256 ${sha256}\n${sign ? "signed" : "UNSIGNED: for a test machine only, not for publishing"}`);
