// The changelog (NP-040): one file per version in site/changelog/<version>.md, English only.
//
//   ---
//   date: 2026-10-09
//   ---
//
//   - What changed, one line per change.
//
// The same list goes to the update dialog of the app (`notes` of latest.json, build-latest.mjs)
// and to /pin/changelog/ (build-site.mjs).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const folder = fileURLToPath(new URL("../changelog/", import.meta.url));

/** Newest first by version number. */
const byVersion = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  const i = x.findIndex((n, i) => n !== y[i]);
  return i === -1 ? 0 : y[i] - x[i];
};

/** One version: its date (YYYY-MM-DD) and its changes. Throws when the file is missing or malformed. */
export function entry(version) {
  const file = `${folder}${version}.md`;
  if (!existsSync(file)) throw new Error(`site/changelog/${version}.md is missing: write what changed in ${version} first`);
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const date = text.match(/^---\ndate: (\d{4}-\d{2}-\d{2})\n---\n/)?.[1];
  if (!date) throw new Error(`site/changelog/${version}.md: no «---\\ndate: YYYY-MM-DD\\n---» on top`);
  const changes = text
    .slice(text.indexOf("---", 3) + 3)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const bad = changes.find((l) => !l.startsWith("- "));
  if (bad) throw new Error(`site/changelog/${version}.md: «${bad}» is not a «- » line`);
  if (!changes.length) throw new Error(`site/changelog/${version}.md: no changes`);
  return { version, date, changes: changes.map((l) => l.slice(2).trim()) };
}

/** Every version with a file, newest first. */
export function changelog() {
  return readdirSync(folder)
    .filter((f) => /^\d+\.\d+\.\d+\.md$/.test(f))
    .map((f) => f.slice(0, -3))
    .sort(byVersion)
    .map(entry);
}
