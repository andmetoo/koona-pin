// The notes of a release, from site/content/changelog/<version>.md through entry(): one source for the
// tag's message (release-tag.mjs), the GitHub Release (release.yml, release-windows.mjs) and the update
// dialog (`notes` of latest.json, build-latest.mjs), so the three never say different things.
//   bun scripts/lib/release-notes.mjs <version>          markdown, for gh release --notes-file
//   bun scripts/lib/release-notes.mjs <version> --text   plain text, for git tag -F
import { entry } from "../../site/src/changelog.mjs";
import { SITE } from "../../site/src/content.mjs";

/** The changes as «- » lines: markdown, and what latest.json carries as `notes`. */
export const changeList = (version) =>
  entry(version)
    .changes.map((c) => `- ${c}`)
    .join("\n");

/** The body of the GitHub Release. Throws as entry() does: no changelog, no release. */
export function releaseNotes(version) {
  const { date } = entry(version);
  return `${changeList(version)}\n\nReleased ${date}. The changes of every version: ${SITE}/changelog/\n`;
}

/** The annotated tag's message: a title line, then the changes. */
export function tagMessage(version) {
  return `Koona Pin ${version}\n\n${changeList(version)}\n`;
}

if (import.meta.main) {
  const [version] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!version) {
    console.error("bun scripts/lib/release-notes.mjs <version> [--text]");
    process.exit(1);
  }
  try {
    process.stdout.write(process.argv.includes("--text") ? tagMessage(version) : releaseNotes(version));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
