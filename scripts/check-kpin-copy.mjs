// docs/kpin/ is a copy of koona-project/kpin at the tag in docs/kpin.tag: the .kpin specification,
// schema, examples and conformance suite live there, under CC0, and Koona Pin's reader is tested
// against this copy. This checks that every file of the copy is that tag's file, byte for byte once
// line ends are LF (a Windows checkout may write CRLF), and that neither side has a file the other
// lacks. The repository's own tooling (tools/, package files, CONTRIBUTING.md, .github/) is not
// part of the copy.
//
//   bun scripts/check-kpin-copy.mjs            compare with the pinned tag (needs git and the network)
//   bun scripts/check-kpin-copy.mjs --from <dir>   compare with a local checkout of koona-project/kpin
//
// To move the copy to a new tag: write the tag in docs/kpin.tag, copy the tag's files over
// docs/kpin/ (the same set as below), run the reader's tests, and commit both.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const copy = path.join(root, "docs", "kpin");
const tag = readFileSync(path.join(root, "docs", "kpin.tag"), "utf8").trim();
const REPOSITORY = "https://github.com/koona-project/kpin.git";
/** What the copy holds: the format's own files, not the repository's tooling. */
const PARTS = ["README.md", "LICENSE.md", "schema-1.json", "examples", "conformance"];

const fromArg = process.argv.indexOf("--from");
let source = fromArg > 0 ? path.resolve(process.argv[fromArg + 1]) : null;
let temporary = null;
if (!source) {
  temporary = mkdtempSync(path.join(tmpdir(), "kpin-"));
  execFileSync("git", ["-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--branch", tag, REPOSITORY, temporary], { stdio: ["ignore", "inherit", "inherit"] });
  source = temporary;
}

/** Every file under the parts, as paths relative to `base`. */
function files(base) {
  const found = [];
  const walk = (relative) => {
    const full = path.join(base, relative);
    if (!existsSync(full)) return;
    if (statSync(full).isDirectory()) for (const name of readdirSync(full)) walk(path.join(relative, name));
    else found.push(relative.split(path.sep).join("/"));
  };
  PARTS.forEach(walk);
  return found.sort();
}

const lf = (file) => readFileSync(file).toString("latin1").replace(/\r\n/g, "\n");
const ours = files(copy);
const theirs = files(source);
const problems = [
  ...theirs.filter((f) => !ours.includes(f)).map((f) => `missing from docs/kpin: ${f}`),
  ...ours.filter((f) => !theirs.includes(f)).map((f) => `not in ${tag}: docs/kpin/${f}`),
  ...ours.filter((f) => theirs.includes(f) && lf(path.join(copy, f)) !== lf(path.join(source, f))).map((f) => `differs from ${tag}: docs/kpin/${f}`),
];
if (temporary) rmSync(temporary, { recursive: true, force: true });

if (problems.length) {
  console.error(problems.map((p) => `- ${p}`).join("\n"));
  console.error(`\ndocs/kpin is not koona-project/kpin at ${tag}. Change the format there first, tag it, then copy it here and write the tag in docs/kpin.tag.`);
  process.exit(1);
}
console.log(`docs/kpin is koona-project/kpin at ${tag}: ${ours.length} files.`);
