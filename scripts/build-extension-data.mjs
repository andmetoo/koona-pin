// The Firefox folder as the server takes it (unit «firefox» of koona-deploy, NP-018), checked, and its
// extension.json for the site's pages:
//
//   updates.json                      gecko.update_url of every signed XPI: each version Firefox may update from
//   koonapin-firefox-<version>.xpi    every one updates.json lists, nothing else
//   extension.json                    { schema: 1, version, firefox: { name, size, sha256 } } of the newest
//
//   bun scripts/build-extension-data.mjs                  release/publish/firefox (scripts/lib/paths.mjs)
//   bun scripts/build-extension-data.mjs --dir <folder>   another folder (extension.yml's working copy)
//
// The checks are the server's own, made here first so a release never carries a folder it would refuse:
// each update_link is https://koona.app/pin/firefox/<name>, each update_hash the file's sha256, no XPI
// lies there unlisted. sign-firefox.mjs runs the same check before it asks AMO to sign: the old versions
// stay in updates.json, or a Firefox that has one of them would never hear of an update.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firefoxDownloadBase, geckoId } from "./build-extension.mjs";
import { publish } from "./lib/paths.mjs";

/** The XPI's published name: the site and every updates.json entry use it. */
export const xpiName = (version) => `koonapin-firefox-${version}.xpi`;

/** Compares two x.y.z versions numerically: negative, zero or positive. */
export function compareVersions(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * Reads and checks a Firefox folder. Returns { entries, files } (entries in updates.json's order,
 * files by name: { version, size, sha256 }), or throws with every problem found. `allowEmpty`: a
 * folder without updates.json and without XPIs is an empty start (the first signed version).
 */
export async function readFirefoxFolder(dir, { allowEmpty = false } = {}) {
  const updatesPath = path.join(dir, "updates.json");
  const xpis = existsSync(dir) ? (await readdir(dir)).filter((name) => name.endsWith(".xpi")) : [];
  if (!existsSync(updatesPath)) {
    if (allowEmpty && !xpis.length) return { entries: [], files: {} };
    throw new Error(
      `${updatesPath} is not there${xpis.length ? `, but ${xpis.length} XPI are` : ""}: the previous versions would be lost. ` +
        "Put the last release's updates.json and XPIs there (extension.yml downloads them from the latest ext-v* release).",
    );
  }
  const problems = [];
  const updates = JSON.parse(await readFile(updatesPath, "utf8"));
  const addons = Object.keys(updates.addons ?? {});
  if (addons.length !== 1 || addons[0] !== geckoId) problems.push(`updates.json must list only ${geckoId}, not ${addons.join(", ") || "nothing"}`);
  const entries = updates.addons?.[geckoId]?.updates ?? [];
  if (!entries.length && !allowEmpty) problems.push("updates.json lists no version");
  const files = {};
  const listed = new Set(entries.map((entry) => xpiName(entry.version)));
  let last = null;
  for (const entry of entries) {
    const name = xpiName(entry.version);
    if (!/^\d+\.\d+\.\d+$/.test(entry.version ?? "")) {
      problems.push(`an entry's version ${JSON.stringify(entry.version)} is not x.y.z`);
      continue;
    }
    if (last && compareVersions(entry.version, last) <= 0) problems.push(`${entry.version} comes after ${last}: updates.json lists versions oldest first, each once`);
    last = entry.version;
    if (entry.update_link !== `${firefoxDownloadBase}/${name}`) problems.push(`${entry.version}: update_link is ${entry.update_link}, not ${firefoxDownloadBase}/${name}`);
    const file = path.join(dir, name);
    if (!existsSync(file)) {
      problems.push(`${name} is listed but not in ${dir}`);
      continue;
    }
    const data = await readFile(file);
    const hash = sha256(data);
    if (entry.update_hash !== `sha256:${hash}`) problems.push(`${name}: update_hash ${entry.update_hash} is not the file's sha256:${hash}`);
    // A signed package carries Mozilla's signature files.
    if (!data.includes("META-INF/cose.sig")) problems.push(`${name} has no Mozilla signature`);
    files[name] = { version: entry.version, size: data.length, sha256: hash };
  }
  for (const name of xpis) if (!listed.has(name)) problems.push(`${name} lies in ${dir} but updates.json does not list it`);
  if (problems.length) throw new Error(`${dir}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  return { entries, files };
}

/** extension.json of a checked folder: the newest version's XPI. */
export async function buildExtensionData(dir) {
  const { entries, files } = await readFirefoxFolder(dir);
  const newest = entries.map((e) => e.version).sort(compareVersions).at(-1);
  const name = xpiName(newest);
  const data = { schema: 1, version: newest, firefox: { name, size: files[name].size, sha256: files[name].sha256 } };
  await writeFile(path.join(dir, "extension.json"), JSON.stringify(data, null, 2) + "\n");
  return { data, entries, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv.includes("--dir") ? path.resolve(process.argv[process.argv.indexOf("--dir") + 1]) : publish.firefox;
  try {
    const { data, entries } = await buildExtensionData(dir);
    console.log(`extension.json: ${data.version}, ${data.firefox.name} (${data.firefox.size} bytes); updates.json lists ${entries.map((e) => e.version).join(", ")}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
