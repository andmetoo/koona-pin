// The changelog (NP-040, NP-115): one file per version in changelog/<version>.md, English only.
//
//   ---
//   date: 2026-10-09
//   ---
//
//   - What changed, one line per change.
//
// The same list goes to the update dialog of the app (`notes` of latest.json, build-latest.mjs, through
// entry()) and to koona.app/pin/changelog/ (the `changelog` of release.json, build-release-data.mjs,
// through entries()): the site (andmetoo/koona-site) reads it from there, not from this folder.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** The repository's changelog/; build-release-data.mjs takes another one for its tests (--changelog). */
export const folder = path.resolve(import.meta.dirname, "..", "..", "changelog");

/** Newest first by version number. */
export const byVersion = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  const i = x.findIndex((n, i) => n !== y[i]);
  return i === -1 ? 0 : y[i] - x[i];
};

/** The changes of a version's file below its header: «- » lines only, at least one. */
export function changes(version, body) {
  const lines = body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const bad = lines.find((l) => !l.startsWith("- "));
  if (bad) throw new Error(`changelog/${version}.md: «${bad}» is not a «- » line`);
  if (!lines.length) throw new Error(`changelog/${version}.md: no changes`);
  return lines.map((l) => l.slice(2).trim());
}

/** One version: its date (YYYY-MM-DD) and its changes. Throws when the file is missing or malformed. */
export function entry(version, from = folder) {
  const file = path.join(from, `${version}.md`);
  if (!existsSync(file)) throw new Error(`changelog/${version}.md is missing: write what changed in ${version} first`);
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const date = text.match(/^---\ndate: (\d{4}-\d{2}-\d{2})\n---\n/)?.[1];
  if (!date) throw new Error(`changelog/${version}.md: no «---\\ndate: YYYY-MM-DD\\n---» on top`);
  return { version, date, changes: changes(version, text.slice(text.indexOf("---", 3) + 3)) };
}

/** Every version up to `upTo` (all when omitted), newest first, each as entry() reads it. */
export function entries(upTo, from = folder) {
  return readdirSync(from)
    .filter((f) => /^\d+\.\d+\.\d+\.md$/.test(f))
    .map((f) => f.slice(0, -3))
    .filter((v) => !upTo || byVersion(v, upTo) >= 0)
    .sort(byVersion)
    .map((v) => entry(v, from));
}
