// Once: the Firefox versions signed before extension.yml existed, into the GitHub Release
// ext-v<newest>, so the workflow has a previous state to start from (docs/extension.md).
//   bun run extension:seed                 checks, signs, creates the release
//   bun run extension:seed -- --dry-run    the checks and what would be created, nothing signed or created
//   bun run extension:seed -- --dir <folder>   another folder than release/publish/firefox
//   bun run extension:seed -- --target <commit>  the commit of the tag, when version.js has moved on since
// Takes release/publish/firefox (updates.json and the XPIs it lists, hashes checked by
// build-extension-data.mjs), writes extension.json, signs updates.json and extension.json with the update
// key (`tauri signer sign`, as build-latest.mjs: TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH
// and TAURI_SIGNING_PRIVATE_KEY_PASSWORD from the environment or .env, NP-042), and creates the release with
// gh: a draft first, its files uploaded, then published, not marked latest (the app's releases keep it).
// Publishing creates the tag on origin, which starts extension.yml: it finds the release made and only
// deploys it. Refuses when any ext-v* release exists already.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { geckoId } from "./build-extension.mjs";
import { buildExtensionData, xpiName } from "./build-extension-data.mjs";
import { publish, root } from "./lib/paths.mjs";

const dotenv = path.join(root, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const dryRun = process.argv.includes("--dry-run");
const source = arg("--dir") ? path.resolve(arg("--dir")) : publish.firefox;

const run = (command, args, options = {}) => spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

// The check and extension.json in a copy: the source folder is left as it is.
const work = await mkdtemp(path.join(tmpdir(), "koonapin-firefox-seed-"));
let data, entries;
try {
  const updates = path.join(source, "updates.json");
  if (!existsSync(updates)) fail(`${updates} is not there: nothing to seed from.`);
  await copyFile(updates, path.join(work, "updates.json"));
  const listed = JSON.parse(await readFile(updates, "utf8")).addons?.[geckoId]?.updates ?? [];
  for (const { version } of listed) {
    const name = xpiName(version);
    if (existsSync(path.join(source, name))) await copyFile(path.join(source, name), path.join(work, name));
  }
  ({ data, entries } = await buildExtensionData(work));
} catch (error) {
  await rm(work, { recursive: true, force: true });
  fail(error.message);
}
const version = data.version;
const tag = `ext-v${version}`;
const title = `Koona Pin browser extension ${version}`;
const assets = ["updates.json", "updates.json.sig", "extension.json", "extension.json.sig", ...entries.map((e) => xpiName(e.version))];
console.log(`${source}: ${entries.map((e) => e.version).join(", ")}, hashes match; extension.json of ${version}`);

// The tag's commit: main's, while extension/src/version.js still says this version.
const { VERSION } = await import(pathToFileURL(path.join(root, "extension", "src", "version.js")).href);
let target = arg("--target");
if (!target) {
  if (VERSION !== version) fail(`extension/src/version.js says ${VERSION}, the newest signed is ${version}: name the commit of ${version} with --target <commit>.`);
  target = run("git", ["rev-parse", "origin/main"]).stdout.trim();
  if (!target) fail("No origin/main here: git fetch origin, or --target <commit>.");
}

// gh reads only here; it writes below, after the signatures.
const problems = [];
const listedReleases = run("gh", ["release", "list", "--limit", "200", "--json", "tagName,isDraft"]);
if (listedReleases.status !== 0) problems.push(`gh release list failed: ${listedReleases.stderr.trim()} (gh auth login)`);
else {
  const existing = JSON.parse(listedReleases.stdout).filter((r) => r.tagName.startsWith("ext-v"));
  if (existing.length) problems.push(`Releases of the extension exist already (${existing.map((r) => r.tagName + (r.isDraft ? " draft" : "")).join(", ")}): extension.yml takes it from there, nothing to seed.`);
}
if (run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]).stdout.trim()) problems.push(`${tag} is on origin already, without its release: delete the tag (git push origin :refs/tags/${tag}) or make the release by hand.`);
if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) problems.push("The update key is not set: TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH (NP-042, .env.example).");

console.log(`
Release ${tag} «${title}», not latest, tag on ${target.slice(0, 7)}; assets:
${assets.map((a) => `  ${a}`).join("\n")}`);
if (dryRun) {
  if (problems.length) console.log(`\nWithout --dry-run it would stop here:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  console.log(`
--dry-run: nothing signed or created. Without it: tauri signer sign updates.json and extension.json, then
  gh release create ${tag} --draft --target ${target.slice(0, 7)} --title "${title}" --notes "${title}" --latest=false <assets>
  gh release edit ${tag} --draft=false --latest=false`);
  await rm(work, { recursive: true, force: true });
  process.exit(0);
}
if (problems.length) {
  await rm(work, { recursive: true, force: true });
  fail(`Not seeded:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
}

const tauri = path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
for (const file of ["updates.json", "extension.json"]) {
  const signed = run(process.execPath, [tauri, "signer", "sign", path.join(work, file)], { stdio: ["inherit", "ignore", "inherit"] });
  if (signed.status !== 0 || !existsSync(path.join(work, `${file}.sig`))) {
    await rm(work, { recursive: true, force: true });
    fail(`Signing ${file} failed (the key or its password).`);
  }
  console.log(`signed ${file}`);
}

// A draft has no tag yet: publishing it creates the tag with every file in place, so the run of
// extension.yml it starts finds the release whole.
const created = run(
  "gh",
  ["release", "create", tag, "--draft", "--target", target, "--title", title, "--notes", title, "--latest=false", ...assets.map((a) => path.join(work, a))],
  { stdio: "inherit" },
);
if (created.status !== 0) {
  await rm(work, { recursive: true, force: true });
  fail(`gh release create failed. A draft may be left: gh release delete ${tag}, then again.`);
}
const published = run("gh", ["release", "edit", tag, "--draft=false", "--latest=false"], { stdio: "inherit" });
await rm(work, { recursive: true, force: true });
if (published.status !== 0) fail(`The draft ${tag} is there with its files, not published: gh release edit ${tag} --draft=false --latest=false`);
console.log(`
${tag} is published. extension.yml runs for the tag: it finds this release and deploys it (DEPLOY_HOST set).
From now on: raise VERSION in extension/src/version.js, merge, bun run extension:tag.`);
