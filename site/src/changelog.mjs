// The changelog (NP-040, NP-115): one file per version in site/content/changelog/<version>.md, English only.
//
//   ---
//   date: 2026-10-09
//   ---
//
//   - What changed, one line per change.
//
// The same list goes to the update dialog of the app (`notes` of latest.json, build-latest.mjs, through
// entry()) and to /pin/changelog/ (the `changelog` collection of the site, through changes()).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const folder = fileURLToPath(new URL("../content/changelog/", import.meta.url));

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
  if (bad) throw new Error(`site/content/changelog/${version}.md: «${bad}» is not a «- » line`);
  if (!lines.length) throw new Error(`site/content/changelog/${version}.md: no changes`);
  return lines.map((l) => l.slice(2).trim());
}

/** One version: its date (YYYY-MM-DD) and its changes. Throws when the file is missing or malformed. */
export function entry(version) {
  const file = `${folder}${version}.md`;
  if (!existsSync(file)) throw new Error(`site/content/changelog/${version}.md is missing: write what changed in ${version} first`);
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const date = text.match(/^---\ndate: (\d{4}-\d{2}-\d{2})\n---\n/)?.[1];
  if (!date) throw new Error(`site/content/changelog/${version}.md: no «---\\ndate: YYYY-MM-DD\\n---» on top`);
  return { version, date, changes: changes(version, text.slice(text.indexOf("---", 3) + 3)) };
}
