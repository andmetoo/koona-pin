// The repository secrets of the CI and of releases (docs/building.md) from .env, by gh:
//   bun scripts/ci-secrets.mjs              sets each one .env has; prints the names, never the values
//   bun scripts/ci-secrets.mjs --dry-run    only says which it would set and which are missing
// The value goes to gh on its standard input, not on the command line. TAURI_SIGNING_PRIVATE_KEY may
// name the key's file (as Tauri accepts it): the file's contents go up then, and _PATH works the same way.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { root } from "./lib/paths.mjs";

const dotenv = path.join(root, ".env");
if (!existsSync(dotenv)) {
  console.error(".env is missing: copy .env.example and fill it in");
  process.exit(1);
}
process.loadEnvFile(dotenv);
const dryRun = process.argv.includes("--dry-run");

const REQUIRED = [
  "KOONAPIN_FEEDBACK_URL",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "PADDLE_ENVIRONMENT",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
];
// macOS signing and notarization (release.yml), once there is a Developer ID.
const OPTIONAL = ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_SIGNING_IDENTITY", "APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_PRIVATE_KEY"];

const isFile = (value) => !value.includes("\n") && existsSync(value) && statSync(value).isFile();
function value(name) {
  if (name === "TAURI_SIGNING_PRIVATE_KEY") {
    const key = process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH;
    if (key && isFile(path.resolve(root, key))) return readFileSync(path.resolve(root, key), "utf8").trim();
    return key;
  }
  return process.env[name];
}

const missing = [];
for (const name of [...REQUIRED, ...OPTIONAL]) {
  const secret = value(name);
  if (!secret) {
    if (REQUIRED.includes(name)) missing.push(name);
    continue;
  }
  if (dryRun) {
    console.log(`would set ${name}`);
    continue;
  }
  const set = spawnSync("gh", ["secret", "set", name], { cwd: root, input: secret, stdio: ["pipe", "ignore", "inherit"] });
  if (set.status !== 0) {
    console.error(`gh secret set ${name} failed`);
    process.exit(1);
  }
  console.log(`set ${name}`);
}
if (missing.length) {
  console.error(`Not in .env, not set: ${missing.join(", ")}`);
  process.exit(1);
}
