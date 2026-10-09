// Signs the Firefox extension on AMO without a listing (NP-018) and prepares
// the self-hosted update files:
//
//   release/publish/firefox/koonapin-firefox-<version>.xpi   signed, for users and the site
//   release/publish/firefox/updates.json                      for gecko.update_url
//
// The AMO API key of the owner's account comes from the environment or .env
// (WEB_EXT_API_KEY, WEB_EXT_API_SECRET; .env.example); this script never prints it.
// AMO signs each version number once: bump extension/src/version.js for a new upload.
//
//   bun run extension:sign:firefox
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildExtension, firefoxDownloadBase, geckoId } from "./build-extension.mjs";
import { publish, root } from "./lib/paths.mjs";

const dotenv = path.join(root, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
  console.error(
    "Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET in .env or the environment, from addons.mozilla.org → Developer Hub → Manage API Keys, then run again.",
  );
  process.exit(1);
}

const built = await buildExtension({ log: () => {} });
const artifacts = path.resolve(".test-data", `firefox-signed-${Date.now()}`);
await mkdir(artifacts, { recursive: true });
const signed = spawnSync(
  process.execPath,
  [
    "node_modules/web-ext/bin/web-ext.js",
    "sign",
    "--channel",
    "unlisted",
    "--source-dir",
    built.unpacked.firefox,
    "--artifacts-dir",
    artifacts,
    // Automatic review of an unlisted add-on usually takes minutes.
    "--approval-timeout",
    String(30 * 60 * 1000),
  ],
  { stdio: "inherit" },
);
if (signed.status !== 0) process.exit(signed.status ?? 1);

const xpi = (await readdir(artifacts)).find((name) => name.endsWith(".xpi"));
if (!xpi) throw new Error(`AMO returned no XPI in ${artifacts}`);
const data = await readFile(path.join(artifacts, xpi));
// A signed package carries Mozilla's signature files.
if (!data.includes("META-INF/cose.sig")) throw new Error(`${xpi} has no Mozilla signature`);

const out = publish.firefox;
await mkdir(out, { recursive: true });
const name = `koonapin-firefox-${built.version}.xpi`;
await copyFile(path.join(artifacts, xpi), path.join(out, name));

// Every signed version stays in the update manifest, newest last.
const updatesPath = path.join(out, "updates.json");
const updates = JSON.parse(await readFile(updatesPath, "utf8").catch(() => '{"addons":{}}'));
const entries = (updates.addons[geckoId] ??= { updates: [] }).updates.filter((u) => u.version !== built.version);
entries.push({
  version: built.version,
  update_link: `${firefoxDownloadBase}/${name}`,
  update_hash: `sha256:${createHash("sha256").update(data).digest("hex")}`,
});
updates.addons[geckoId].updates = entries;
await writeFile(updatesPath, JSON.stringify(updates, null, 2) + "\n");
console.log(`Signed: ${path.relative(process.cwd(), path.join(out, name))}`);
console.log(`Updates: ${path.relative(process.cwd(), updatesPath)} → publish both at ${firefoxDownloadBase}/`);
