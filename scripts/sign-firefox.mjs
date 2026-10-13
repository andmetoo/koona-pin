// Signs the Firefox extension on AMO without a listing (NP-018) and prepares
// the self-hosted update files:
//
//   <folder>/koonapin-firefox-<version>.xpi   signed, for users and the site
//   <folder>/updates.json                      for gecko.update_url: every signed version, oldest first
//
//   bun run extension:sign:firefox                       <folder> is release/publish/firefox
//   bun run extension:sign:firefox -- --dir <folder>     another folder: extension.yml's copy of the last
//                                                        ext-v* release (docs/extension.md)
//   bun run extension:sign:firefox -- --first            an empty folder is a first start (no version yet)
//
// The folder must hold the previous updates.json and every XPI it lists, with their hashes
// (build-extension-data.mjs checks it before AMO is asked): a version dropped from updates.json
// strands every Firefox that has it. Without updates.json the script stops unless --first.
// The AMO API key of the owner's account comes from the environment or .env
// (WEB_EXT_API_KEY, WEB_EXT_API_SECRET; .env.example); this script never prints it.
// AMO signs each version number once: bump extension/src/version.js for a new upload.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildExtension, firefoxDownloadBase, geckoId } from "./build-extension.mjs";
import { compareVersions, readFirefoxFolder, xpiName } from "./build-extension-data.mjs";
import { publish, root } from "./lib/paths.mjs";

const dotenv = path.join(root, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
  console.error(
    "Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET in .env or the environment, from addons.mozilla.org → Developer Hub → Manage API Keys, then run again.",
  );
  process.exit(1);
}

const out = process.argv.includes("--dir") ? path.resolve(process.argv[process.argv.indexOf("--dir") + 1]) : publish.firefox;
const first = process.argv.includes("--first");
const { VERSION } = await import(pathToFileURL(path.join(root, "extension", "src", "version.js")).href);

// Before AMO: what is there must be whole, and this version new and the newest.
let previous;
try {
  previous = await readFirefoxFolder(out, { allowEmpty: first });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const versions = previous.entries.map((entry) => entry.version);
if (versions.includes(VERSION)) {
  console.error(`${VERSION} is signed already (${path.join(out, "updates.json")}): AMO signs each version once; raise VERSION in extension/src/version.js.`);
  process.exit(1);
}
const newest = versions.toSorted(compareVersions).at(-1);
if (newest && compareVersions(VERSION, newest) < 0) {
  console.error(`${VERSION} is older than ${newest} in updates.json: Firefox would not update to it.`);
  process.exit(1);
}

const built = await buildExtension({ log: () => {} });
const artifacts = path.join(root, ".test-data", `firefox-signed-${Date.now()}`);
await mkdir(artifacts, { recursive: true });
const signed = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules", "web-ext", "bin", "web-ext.js"),
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

await mkdir(out, { recursive: true });
const name = xpiName(built.version);
await copyFile(path.join(artifacts, xpi), path.join(out, name));

// Every signed version stays in the update manifest, newest last.
const updatesPath = path.join(out, "updates.json");
const updates = JSON.parse(await readFile(updatesPath, "utf8").catch(() => '{"addons":{}}'));
const entries = (updates.addons[geckoId] ??= { updates: [] }).updates;
entries.push({
  version: built.version,
  update_link: `${firefoxDownloadBase}/${name}`,
  update_hash: `sha256:${createHash("sha256").update(data).digest("hex")}`,
});
updates.addons[geckoId].updates = entries;
await writeFile(updatesPath, JSON.stringify(updates, null, 2) + "\n");
console.log(`Signed: ${path.relative(process.cwd(), path.join(out, name))}`);
console.log(`Updates: ${path.relative(process.cwd(), updatesPath)} lists ${entries.map((e) => e.version).join(", ")}`);
// The site serves this folder from a release only: extension.yml signs it and deploys it (docs/extension.md).
