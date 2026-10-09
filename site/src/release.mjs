// What the site offers for download (NP-040): the newest release of build-latest.mjs
// (release/publish/updates/<version>/) and the newest signed Firefox add-on (release/publish/firefox).
// Without a release the landing keeps its «coming soon» block and /downloads/ is not built.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { publish } from "../../scripts/lib/paths.mjs";
import { SITE } from "./content.mjs";

const byVersion = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  const i = x.findIndex((n, i) => n !== y[i]);
  return i === -1 ? 0 : x[i] - y[i];
};

/** The newest version folder with a latest.json, or null. */
export function newestRelease() {
  if (!existsSync(publish.updates)) return null;
  const versions = readdirSync(publish.updates)
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v) && existsSync(path.join(publish.updates, v, "latest.json")))
    .sort(byVersion);
  return versions.at(-1) ?? null;
}

/**
 * The files of the newest release for the pages: each with its address on the site and its size.
 * `date` is the day of latest.json (YYYY-MM-DD).
 */
export function release() {
  const version = newestRelease();
  if (!version) return null;
  const folder = path.join(publish.updates, version);
  const latest = JSON.parse(readFileSync(path.join(folder, "latest.json"), "utf8"));
  const file = (test) => {
    const name = readdirSync(folder).find(test);
    if (!name) return null;
    return { name, url: `${SITE}/downloads/${version}/${encodeURIComponent(name)}`, size: statSync(path.join(folder, name)).size };
  };
  return {
    version,
    date: latest.pub_date.slice(0, 10),
    windows: file((f) => f.endsWith("-setup.exe")),
    deb: file((f) => f.endsWith(".deb")),
    rpm: file((f) => f.endsWith(".rpm")),
    sums: file((f) => f === "SHA256SUMS.txt"),
  };
}

/** The newest signed Firefox add-on on the site, or null (NP-018). */
export function firefoxAddon() {
  const manifest = path.join(publish.firefox, "updates.json");
  if (!existsSync(manifest)) return null;
  const updates = Object.values(JSON.parse(readFileSync(manifest, "utf8")).addons).flatMap((a) => a.updates);
  return updates.sort((a, b) => byVersion(a.version, b.version)).at(-1)?.update_link ?? null;
}

/** «7.9 MB». */
export const megabytes = (bytes) => `${(bytes / 1_000_000).toFixed(1)} MB`;
