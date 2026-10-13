// Tags a release: v<version> on the commit of main, which starts release.yml (the Linux and macOS
// packages into a draft GitHub Release).
//   bun run release:tag                      checks, then git tag -a v<version> and git push origin v<version>
//   bun run release:tag -- --dry-run         the checks and the tag's message, nothing created
//   bun scripts/release-tag.mjs --verify v0.12.0   release.yml's «verify»: the tag fits the commit it names
// Before the tag: the branch is main, equal to origin/main, nothing uncommitted; the version is the same in
// its four places (scripts/version.mjs); changelog/<version>.md passes entry(); the tag is
// not there yet, here or on origin. The tag's message is the changelog's list (lib/release-notes.mjs).
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { tagMessage } from "./lib/release-notes.mjs";
import { root } from "./lib/paths.mjs";
import { version as currentVersion } from "./version.mjs";

const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const out = (...args) => git(...args).stdout.trim();
const problems = [];

let version;
try {
  version = await currentVersion();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const tag = `v${version}`;
let message;
try {
  message = tagMessage(version);
} catch (error) {
  problems.push(error.message);
}

const verify = process.argv.includes("--verify") ? process.argv[process.argv.indexOf("--verify") + 1] : null;
if (verify) {
  // In CI (release.yml): the checkout of the tag with full history (fetch-depth: 0), so origin/main is there.
  if (verify !== tag) problems.push(`The tag ${verify} does not name this commit's version: its four places say ${version} (${tag})`);
  const resolved = git("rev-parse", "--verify", "--quiet", `${verify}^{commit}`);
  const commit = resolved.status === 0 ? resolved.stdout.trim() : "";
  if (!commit) problems.push(`${verify}: no such tag here`);
  else if (git("merge-base", "--is-ancestor", commit, "origin/main").status !== 0) {
    problems.push(`${verify} (${commit.slice(0, 7)}) is not on origin/main: a release is made from a merged commit`);
  }
  if (problems.length) {
    console.error(problems.map((p) => `- ${p}`).join("\n"));
    process.exit(1);
  }
  console.log(`${verify}: version ${version} in its four places, its changelog, on origin/main`);
  process.exit(0);
}

const dryRun = process.argv.includes("--dry-run");
const fetched = git("fetch", "--quiet", "origin", "main", "--tags");
if (fetched.status !== 0) problems.push(`git fetch origin failed: ${fetched.stderr.trim()}`);
const branch = out("branch", "--show-current");
if (branch !== "main") problems.push(`The branch is ${branch || "a detached HEAD"}: a release is tagged on main (git switch main && git pull)`);
const head = out("rev-parse", "HEAD");
const upstream = out("rev-parse", "origin/main");
if (head !== upstream) problems.push(`HEAD ${head.slice(0, 7)} is not origin/main ${upstream.slice(0, 7)}: git pull, or push what is merged first`);
const dirty = out("status", "--porcelain", "--untracked-files=no");
if (dirty) problems.push(`Uncommitted changes:\n${dirty.replace(/^/gm, "     ")}`);
if (out("tag", "--list", tag)) problems.push(`${tag} is already a tag here: bun run release says what is left to do`);
else if (out("ls-remote", "--tags", "origin", `refs/tags/${tag}`)) problems.push(`${tag} is already on origin: git fetch --tags; bun run release`);

console.log(`Koona Pin ${version}, ${tag} on ${head.slice(0, 7)}`);
if (problems.length) {
  console.error(`\nNot tagged:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`\n${message}`);
if (dryRun) {
  console.log(`--dry-run: no tag. Without it: git tag -a ${tag} and git push origin ${tag}.`);
  process.exit(0);
}

const folder = await mkdtemp(path.join(tmpdir(), "koonapin-tag-"));
const file = path.join(folder, "message.txt");
await writeFile(file, message);
const tagged = git("tag", "-a", tag, "-F", file);
await rm(folder, { recursive: true, force: true });
if (tagged.status !== 0) {
  console.error(`git tag failed: ${tagged.stderr.trim()}`);
  process.exit(1);
}
const pushed = spawnSync("git", ["push", "origin", tag], { cwd: root, stdio: "inherit" });
if (pushed.status !== 0) {
  console.error(`git push failed; the tag is here only. Push again: git push origin ${tag} (or git tag -d ${tag})`);
  process.exit(1);
}
console.log(`
${tag} is on origin: release.yml builds the Linux and macOS packages into a draft release.
Next, on the Windows computer once the commit is there: bun run release:windows. bun run release shows where it stands.`);
