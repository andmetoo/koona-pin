// docs/kpin/ is a copy of koona-project/kpin at the release pinned in docs/kpin.tag: its tag and the
// commit that tag must name (`r2026-11.1 <commit>`). The .kpin specification, schema, examples and
// conformance suite live there, under CC0, and Koona Pin's reader is tested against this copy. This
// checks that the tag still names that commit (a tag there is never moved), that every file of the
// copy is the release's, byte for byte once line ends are LF (a Windows checkout may write CRLF), and
// that neither side has a file the other lacks. The release's own tooling (TOOLING below) is not part
// of the copy; everything else is, so a file the repository adds is reported until it is copied.
//
//   node scripts/check-kpin-copy.mjs               compare with the pinned release (git, network)
//   node scripts/check-kpin-copy.mjs --from <dir>  compare with a local checkout of koona-project/kpin
//
// To move the copy: in koona-project/kpin, tag the release; here, write `<tag> <commit>` in
// docs/kpin.tag, copy the release's files over docs/kpin/ (all but TOOLING), run the reader's tests,
// and commit both.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const copy = path.join(root, "docs", "kpin");
const [tag, commit] = readFileSync(path.join(root, "docs", "kpin.tag"), "utf8").trim().split(/\s+/);
if (!tag || !/^[0-9a-f]{40}$/.test(commit ?? "")) {
  console.error("docs/kpin.tag must hold `<tag> <commit>`, the commit as 40 hex digits.");
  process.exit(1);
}
const REPOSITORY = "https://github.com/koona-project/kpin.git";
/** The repository's own files, not the format's: never copied, never compared. */
const TOOLING = new Set([".git", ".github", ".gitattributes", ".gitignore", "node_modules", "tools", "package.json", "package-lock.json", "CONTRIBUTING.md"]);

const problems = [];
const fromArg = process.argv.indexOf("--from");
let source = fromArg > 0 ? path.resolve(process.argv[fromArg + 1]) : null;
let temporary = null;
if (!source) {
  temporary = mkdtempSync(path.join(tmpdir(), "kpin-"));
  execFileSync("git", ["-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--branch", tag, REPOSITORY, temporary], { stdio: ["ignore", "inherit", "inherit"] });
  source = temporary;
  const cloned = execFileSync("git", ["-C", temporary, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (cloned !== commit) problems.push(`the tag ${tag} names ${cloned}, not ${commit} as docs/kpin.tag says: a tag of koona-project/kpin was moved`);
}

/** Every file of a release or of the copy, as paths relative to `base`, the tooling left out. */
function files(base) {
  const found = [];
  const walk = (relative) => {
    const full = path.join(base, relative);
    if (statSync(full).isDirectory()) for (const name of readdirSync(full)) walk(path.join(relative, name));
    else found.push(relative.split(path.sep).join("/"));
  };
  for (const name of readdirSync(base)) if (!TOOLING.has(name)) walk(name);
  return found.sort();
}

const lf = (file) => readFileSync(file).toString("latin1").replace(/\r\n/g, "\n");
if (existsSync(source)) {
  const ours = files(copy);
  const theirs = files(source);
  problems.push(
    ...theirs.filter((f) => !ours.includes(f)).map((f) => `missing from docs/kpin: ${f}`),
    ...ours.filter((f) => !theirs.includes(f)).map((f) => `not in ${tag}: docs/kpin/${f}`),
    ...ours.filter((f) => theirs.includes(f) && lf(path.join(copy, f)) !== lf(path.join(source, f))).map((f) => `differs from ${tag}: docs/kpin/${f}`),
  );
  if (!problems.length) console.log(`docs/kpin is koona-project/kpin at ${tag} (${commit.slice(0, 7)}): ${ours.length} files.`);
} else problems.push(`no such folder: ${source}`);
if (temporary) rmSync(temporary, { recursive: true, force: true });

if (problems.length) {
  console.error(problems.map((p) => `- ${p}`).join("\n"));
  console.error(`\ndocs/kpin is not koona-project/kpin at ${tag}. Change the format there first, tag it, then copy it here and write the tag and its commit in docs/kpin.tag.`);
  process.exit(1);
}
