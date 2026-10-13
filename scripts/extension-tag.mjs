// Tags a release of the browser extension: ext-v<version> on the commit of main, which starts
// extension.yml (Firefox signed on AMO, the GitHub Release ext-v<version>, the deploy to koona.app/pin/firefox).
//   bun run extension:tag                          checks, then git tag -a ext-v<version> and git push origin ext-v<version>
//   bun run extension:tag -- --dry-run             the checks only, nothing created
//   bun scripts/extension-tag.mjs --verify ext-v0.9.3   extension.yml's first step: the tag fits the commit it names
// The version is VERSION of extension/src/version.js, its only place. Before the tag: the branch is main, equal
// to origin/main, nothing uncommitted; the tag is not there yet, here or on origin; the version is above every
// ext-v* tag (AMO signs each version once, and Firefox updates only upwards). Same checks as release-tag.mjs.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compareVersions } from "./build-extension-data.mjs";
import { root } from "./lib/paths.mjs";

const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const out = (...args) => git(...args).stdout.trim();
const problems = [];

const { VERSION: version } = await import(pathToFileURL(path.join(root, "extension", "src", "version.js")).href);
const tag = `ext-v${version}`;
const message = `Koona Pin browser extension ${version}`;

const verify = process.argv.includes("--verify") ? process.argv[process.argv.indexOf("--verify") + 1] : null;
if (verify) {
  // In CI (extension.yml): the checkout of the tag with full history (fetch-depth: 0), so origin/main is there.
  if (verify !== tag) problems.push(`The tag ${verify} does not name this commit's version: extension/src/version.js says ${version} (${tag})`);
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
  console.log(`${verify}: extension version ${version}, on origin/main`);
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
if (out("tag", "--list", tag)) problems.push(`${tag} is already a tag here: raise VERSION in extension/src/version.js for a new release`);
else if (out("ls-remote", "--tags", "origin", `refs/tags/${tag}`)) problems.push(`${tag} is already on origin: git fetch --tags`);
const newer = out("tag", "--list", "ext-v*")
  .split("\n")
  .filter(Boolean)
  .map((t) => t.slice("ext-v".length))
  .filter((v) => /^\d+\.\d+\.\d+$/.test(v) && compareVersions(v, version) >= 0);
if (newer.length && !out("tag", "--list", tag)) problems.push(`ext-v${newer.join(", ext-v")} is not below ${version}: raise VERSION in extension/src/version.js`);

console.log(`${message}, ${tag} on ${head.slice(0, 7)}`);
if (problems.length) {
  console.error(`\nNot tagged:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
if (dryRun) {
  console.log(`--dry-run: no tag. Without it: git tag -a ${tag} and git push origin ${tag}.`);
  process.exit(0);
}

const tagged = git("tag", "-a", tag, "-m", message);
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
${tag} is on origin: extension.yml signs the Firefox package on AMO, creates the release ${tag} and deploys it.
The Chrome and Edge ZIPs are on that release too: upload them to the stores by hand (docs/extension.md).`);
