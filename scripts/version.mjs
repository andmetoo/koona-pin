// The app's version number in its six places (doc/development-process.md: bumped in the PR that changes
// the app), and the changelog file that goes with it:
//   bun run version:bump               prints the number of each place; fails when they differ
//   bun run version:bump 0.12.0        writes 0.12.0 to package.json, src-tauri/Cargo.toml, the koonapin
//                                      package of src-tauri/Cargo.lock, src-tauri/tauri.conf.json and the
//                                      iOS project (Info.plist, project.yml), and
//                                      starts changelog/0.12.0.md when it is not there
//   bun run version:bump 0.12.0 --dry-run  says what it would change, writes nothing
// Each file is edited where the number stands, by text: their formatting and the rest of Cargo.lock
// stay as they are, so the diff is six lines and a new file.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { root } from "./lib/paths.mjs";

/** Where the number is: the file and the pattern whose group 2 is the version. */
const PLACES = [
  ["package.json", /^(\s*"version":\s*")([^"]+)(")/m],
  ["src-tauri/Cargo.toml", /^(\[package\][^[]*?^version\s*=\s*")([^"]+)(")/m],
  ["src-tauri/Cargo.lock", /^(\[\[package\]\]\nname = "koonapin"\nversion = ")([^"]+)(")/m],
  ["src-tauri/tauri.conf.json", /^(\s*"version":\s*")([^"]+)(")/m],
  // The iOS project (NP-151) keeps the version as text too. CFBundleVersion, the build number, is
  // not ours: `tauri ios build` writes it, and `build:ios` passes the commit count or `--build`.
  ["src-tauri/gen/apple/koonapin_iOS/Info.plist", /(<key>CFBundleShortVersionString<\/key>\s*<string>)([^<]+)(<\/string>)/],
  ["src-tauri/gen/apple/project.yml", /^(\s*CFBundleShortVersionString:\s*)([^\s]+)()$/m],
];

/** The version of each place, { file: version }; a place where none is found has null. */
export async function versions() {
  const found = {};
  for (const [file, pattern] of PLACES) {
    const text = (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");
    found[file] = text.match(pattern)?.[2] ?? null;
  }
  return found;
}

/** The one version of the six places; throws, naming each, when they differ. */
export async function version() {
  const found = await versions();
  const distinct = new Set(Object.values(found));
  if (distinct.size !== 1 || distinct.has(null)) {
    throw new Error(`The version differs between its places:\n${Object.entries(found).map(([f, v]) => `  ${f}: ${v ?? "not found"}`).join("\n")}`);
  }
  return [...distinct][0];
}

const changelog = (v) => path.join(root, "changelog", `${v}.md`);

if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");
  const [next, ...extra] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const fail = (message) => {
    console.error(message);
    process.exit(1);
  };
  if (process.argv.includes("--help") || extra.length) {
    console.log("bun run version:bump [<x.y.z>] [--dry-run]");
    process.exit(extra.length ? 1 : 0);
  }
  if (!next) {
    const found = await versions();
    for (const [file, v] of Object.entries(found)) console.log(`${file.padEnd(28)} ${v ?? "not found"}`);
    try {
      await version();
    } catch (error) {
      fail(`\n${error.message}`);
    }
    process.exit(0);
  }
  // Plain x.y.z: the changelog, the site's /downloads/<version>/ and the tag v<version> sort by it.
  if (!/^\d+\.\d+\.\d+$/.test(next)) fail(`«${next}» is not x.y.z`);

  for (const [file, pattern] of PLACES) {
    const full = path.join(root, file);
    const raw = await readFile(full, "utf8");
    // Cargo.lock and the others are LF in the repository; a CRLF checkout keeps its endings.
    const crlf = raw.includes("\r\n");
    const text = raw.replace(/\r\n/g, "\n");
    const match = text.match(pattern);
    if (!match) fail(`${file}: the version is not where it is expected`);
    if (match[2] === next) {
      console.log(`${file}: already ${next}`);
      continue;
    }
    const updated = text.replace(pattern, `$1${next}$3`);
    if (!dryRun) await writeFile(full, crlf ? updated.replace(/\n/g, "\r\n") : updated);
    console.log(`${file}: ${match[2]} → ${next}`);
  }

  // entry() takes no file without a «- » line, so the stub stops bun run release:tag until it is written.
  const notes = changelog(next);
  const relative = path.relative(root, notes).split(path.sep).join("/");
  if (existsSync(notes)) {
    console.log(`${relative}: there`);
  } else {
    // The local day (sv-SE writes YYYY-MM-DD): late in the evening UTC is already tomorrow east of it.
    const today = new Date().toLocaleDateString("sv-SE");
    if (!dryRun) await writeFile(notes, `---\ndate: ${today}\n---\n\n- \n`);
    console.log(`${relative}: started, dated ${today}`);
  }
  if (dryRun) console.log("\n--dry-run: nothing is written.");
  console.log(`
Next:
  1. Write what changed for people in ${relative}: one «- » line per change, in English, as in the earlier files.
  2. Commit the six files and the changelog in the PR of the change.
  3. After the merge: bun run release:tag on an up-to-date main.`);
}
