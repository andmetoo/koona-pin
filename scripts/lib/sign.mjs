// Signs a file with the update key (NP-042): `tauri signer sign` writes <file>.sig, the base64 of a
// minisign signature whose trusted comment names the file («file:<name>», and «version:<v>» when bound
// to a version). The app's updater checks the packages' signatures; the server (koona-deploy of
// andmetoo/koona-site) checks every file of a deploy the same way, against the same public key.
// The key and its password come from the environment: TAURI_SIGNING_PRIVATE_KEY (or
// TAURI_SIGNING_PRIVATE_KEY_PATH) and TAURI_SIGNING_PRIVATE_KEY_PASSWORD.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { root } from "./paths.mjs";

const tauri = path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");

/** Whether the update key is in the environment. */
export const hasUpdateKey = () => Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH);

/** <file>.sig next to the file; `version` binds it to that version (the updater's requireSignedVersion). */
export function signFile(file, { version } = {}) {
  const args = [tauri, "signer", "sign", ...(version ? ["--app-version", version] : []), file];
  const signed = spawnSync(process.execPath, args, { cwd: root, stdio: ["inherit", "ignore", "inherit"] });
  return signed.status === 0;
}
