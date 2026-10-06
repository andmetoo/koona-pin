// Builds the Windows installer (NP-037, Р-9): NSIS per user, with --features public-release
// (the native host accepts only the store extensions, feedback must have its address).
//   node scripts/build-installer.mjs            unsigned, for a test machine
//   node scripts/build-installer.mjs --sign     signed with eSigner (scripts/sign-windows.ps1)
// Settings come from the environment or from .env in the repository root (.env.example);
// a variable already set in the environment wins. Prints the installer's path and SHA-256.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sign = process.argv.includes("--sign");

// Cargo (option_env! in feedback.rs) and Tauri's signCommand inherit these.
const dotenv = path.join(root, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

if (!process.env.NETAMIPIN_FEEDBACK_URL) {
  console.error("NETAMIPIN_FEEDBACK_URL is not set: the installer build does not compile without it (supabase/README.md).");
  process.exit(1);
}
const signing = ["ESIGNER_USERNAME", "ESIGNER_PASSWORD", "ESIGNER_TOTP_SECRET", "CODESIGNTOOL_DIR"];
if (sign && signing.some((name) => !process.env[name])) {
  console.error(`--sign needs ${signing.join(", ")} (doc/release-checklist.md).`);
  process.exit(1);
}

// tauri.conf.json keeps bundling off, so `npm run tauri build` makes no installer: the only
// installer of a version in the bundle folder is one this script built with public-release.
const bundle = { active: true };
if (sign) {
  // Tauri signs the app, the host, the uninstaller and the installer with it (%1 is the file).
  const script = path.join(root, "scripts", "sign-windows.ps1");
  bundle.windows = { signCommand: { cmd: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "%1"] } };
}
const conf = JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const dir = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
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
const file = path.join(dir, installer);
const sha256 = createHash("sha256").update(await readFile(file)).digest("hex");
console.log(`\n${file}\nSHA-256 ${sha256}\n${sign ? "signed" : "UNSIGNED: for a test machine only, not for publishing"}`);
