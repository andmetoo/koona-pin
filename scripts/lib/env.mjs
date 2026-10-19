// The settings of the release builds: .env in the repository root, under what the environment already
// sets (a variable set there wins).
import { existsSync } from "node:fs";
import path from "node:path";
import { root } from "./paths.mjs";

/**
 * Loads .env and returns process.env. An Apple variable set but empty (a workflow passes every secret,
 * configured or not) counts as unset: Tauri would take an empty signing identity or empty notarization
 * credentials for real ones.
 */
export function loadEnv() {
  const dotenv = path.join(root, ".env");
  if (existsSync(dotenv)) process.loadEnvFile(dotenv);
  for (const name of Object.keys(process.env)) if (name.startsWith("APPLE_") && !process.env[name]) delete process.env[name];
  return process.env;
}
