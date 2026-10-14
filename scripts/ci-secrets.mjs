// The repository secrets of the CI and of releases (docs/building.md) from .env, by gh:
//   bun scripts/ci-secrets.mjs              sets each one .env has; prints the names, never the values
//   bun scripts/ci-secrets.mjs --dry-run    only says which it would set and which are missing
//   bun scripts/ci-secrets.mjs APPLE_       only the secrets whose names start with one of the arguments
// The value goes to gh on its standard input, not on the command line. TAURI_SIGNING_PRIVATE_KEY may
// name the key's file (as Tauri accepts it): the file's contents go up then, and _PATH works the same way.
// APPLE_CERTIFICATE comes from the .p12 at APPLE_CERTIFICATE_PATH (as base64) and APPLE_API_PRIVATE_KEY from
// the .p8 at APPLE_API_KEY_PATH (its text), so neither is ever copied into .env, a terminal or a log.
// The update key, the AMO keys and the deploy key go to the environment «release» (open to tags v* and
// ext-v* only), not to the repository: no pull request, branch or run on main can read them.
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
const only = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const wanted = (name) => !only.length || only.some((prefix) => name.startsWith(prefix));

const REQUIRED = [
  "KOONAPIN_FEEDBACK_URL",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "PADDLE_ENVIRONMENT",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
];
// macOS signing and notarization (release.yml), once there is a Developer ID; the Firefox add-on's AMO
// keys (extension.yml); the deploy to koona.app (andmetoo/koona-site server/README.md): the private key of
// this repository's deploy user key, the host and its known_hosts line.
const OPTIONAL = [
  "APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_SIGNING_IDENTITY", "APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_PRIVATE_KEY",
  "WEB_EXT_API_KEY", "WEB_EXT_API_SECRET",
  "DEPLOY_SSH_KEY", "DEPLOY_HOST", "DEPLOY_KNOWN_HOSTS",
  "AUR_SSH_KEY", "AUR_KNOWN_HOSTS",
];

/** Secrets of an environment instead of the repository's. */
const ENVIRONMENT = Object.fromEntries(
  ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_SIGNING_IDENTITY", "APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_PRIVATE_KEY",
    "WEB_EXT_API_KEY", "WEB_EXT_API_SECRET", "DEPLOY_SSH_KEY", "DEPLOY_HOST", "DEPLOY_KNOWN_HOSTS", "AUR_SSH_KEY", "AUR_KNOWN_HOSTS"].map((name) => [name, "release"]),
);

const isFile = (value) => !value.includes("\n") && existsSync(value) && statSync(value).isFile();
function value(name) {
  if (name === "TAURI_SIGNING_PRIVATE_KEY") {
    const key = process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH;
    if (key && isFile(path.resolve(root, key))) return readFileSync(path.resolve(root, key), "utf8").trim();
    return key;
  }
  const file = { APPLE_CERTIFICATE: "APPLE_CERTIFICATE_PATH", APPLE_API_PRIVATE_KEY: "APPLE_API_KEY_PATH" }[name];
  if (!process.env[name] && file && process.env[file]) {
    const at = path.resolve(root, process.env[file]);
    if (!isFile(at)) throw new Error(`${file} names no file`);
    return name === "APPLE_CERTIFICATE" ? readFileSync(at).toString("base64") : readFileSync(at, "utf8").trim();
  }
  return process.env[name];
}

const missing = [];
for (const name of [...REQUIRED, ...OPTIONAL].filter(wanted)) {
  const secret = value(name);
  if (!secret) {
    if (REQUIRED.includes(name)) missing.push(name);
    continue;
  }
  const where = ENVIRONMENT[name] ? ["--env", ENVIRONMENT[name]] : [];
  const label = `${name}${ENVIRONMENT[name] ? ` (environment ${ENVIRONMENT[name]})` : ""}`;
  if (dryRun) {
    console.log(`would set ${label}`);
    continue;
  }
  const set = spawnSync("gh", ["secret", "set", name, ...where], { cwd: root, input: secret, stdio: ["pipe", "ignore", "inherit"] });
  if (set.status !== 0) {
    console.error(`gh secret set ${label} failed`);
    process.exit(1);
  }
  console.log(`set ${label}`);
}
if (missing.length) {
  console.error(`Not in .env, not set: ${missing.join(", ")}`);
  process.exit(1);
}
