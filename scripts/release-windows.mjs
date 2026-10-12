// The Windows part of a release, on the owner's Windows computer (Certum signs only there, through
// SimplySign Desktop; Tauri signs the exes inside the installer while it builds, so the installer cannot be
// built unsigned in CI and signed later):
//   bun run release:windows                  builds and signs the installer of the tagged commit, uploads it to
//                                            the draft release, then starts release.yml's finalize stage
//   bun run release:windows -- --no-build    uploads the installer already in release/publish/windows/<version>/
//                                            (when it was built from the tag's commit)
//   bun run release:windows -- --no-finalize uploads, and leaves finalize to: gh workflow run release.yml -f tag=v<version>
// HEAD must be the commit of the tag v<version> (bun run release:tag made it): git switch --detach v<version>.
// The installer goes up as koonapin_<version>_x64-setup.exe (GitHub would turn Tauri's «Koona Pin_» into
// «Koona.Pin_»; build-latest.mjs and the site use the same name) with SHA256SUMS-windows.txt. When the
// draft is not there yet (release.yml still building), it is created with the changelog's notes.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { releaseNotes } from "./lib/release-notes.mjs";
import { publish, root } from "./lib/paths.mjs";
import { version as currentVersion } from "./version.mjs";

const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const run = (cmd, args, options = {}) => spawnSync(cmd, args, { cwd: root, encoding: "utf8", ...options });
const out = (cmd, ...args) => run(cmd, args).stdout?.trim() ?? "";

if (process.platform !== "win32") fail("The release installer is built and signed on Windows (Certum SimplySign): run this there.");
const noBuild = process.argv.includes("--no-build");
const noFinalize = process.argv.includes("--no-finalize");

let version;
try {
  version = await currentVersion();
} catch (error) {
  fail(error.message);
}
const tag = `v${version}`;

// The installer must be the tagged commit's: the draft's Linux and macOS packages are.
run("git", ["fetch", "--quiet", "origin", "--tags"]);
const tagged = run("git", ["rev-parse", "--verify", "--quiet", `${tag}^{commit}`]);
if (tagged.status !== 0) fail(`${tag} is not a tag yet: bun run release:tag on main first (bun run release says where the release stands).`);
const commit = tagged.stdout.trim();
const head = out("git", "rev-parse", "HEAD");
if (head !== commit) fail(`HEAD ${head.slice(0, 7)} is not ${tag} (${commit.slice(0, 7)}): git switch --detach ${tag}`);
const dirty = out("git", "status", "--porcelain", "--untracked-files=no");
if (dirty) fail(`Uncommitted changes: the installer is built from the tag's commit as it is\n${dirty}`);
const gh = run("gh", ["auth", "status"]);
if (gh.error || gh.status !== 0) fail("gh is not signed in (gh auth login): the installer goes to the GitHub release through it.");

const step = (title, args) => {
  console.log(`\n== ${title}: bun ${args.join(" ")}`);
  if (run(process.execPath, args, { stdio: "inherit" }).status !== 0) fail(`\n${title} failed.`);
};
if (!noBuild) {
  step("Dependencies", ["install", "--frozen-lockfile"]);
  step("Installer, signed", ["run", "build:installer", "--", "--sign"]);
}

const folder = publish.windows(version);
const files = existsSync(folder) ? await readdir(folder) : [];
const installer = files.find((f) => f.endsWith("-setup.exe") && f.includes(`_${version}_`));
if (!installer || !files.includes("SHA256SUMS.txt")) fail(`No signed installer of ${version} in ${path.relative(root, folder)}: bun run build:windows`);
const sums = await readFile(path.join(folder, "SHA256SUMS.txt"), "utf8");
const builtFrom = sums.match(/commit ([0-9a-f]{7,40})/)?.[1];
if (!builtFrom || !commit.startsWith(builtFrom) || sums.includes("with uncommitted changes") || !sums.includes("\n\nsigned;")) {
  fail(`${path.relative(root, folder)} is not the signed build of ${tag} (${commit.slice(0, 7)}): run without --no-build`);
}

// The names GitHub keeps as they are: no space in the installer, one SHA256SUMS per system.
const name = installer.replace(/^Koona Pin_/, "koonapin_");
if (/\s/.test(name)) fail(`${installer}: a name with spaces would change on GitHub`);
const staging = await mkdtemp(path.join(tmpdir(), "koonapin-release-"));
await copyFile(path.join(folder, installer), path.join(staging, name));
await writeFile(path.join(staging, "SHA256SUMS-windows.txt"), sums.replaceAll(installer, name));
await writeFile(path.join(staging, "notes.md"), releaseNotes(version));

const view = run("gh", ["release", "view", tag, "--json", "isDraft"]);
if (view.status === 0) {
  if (!JSON.parse(view.stdout).isDraft) fail(`The release ${tag} is published already: a new installer needs a new version.`);
} else {
  console.log(`\nNo release ${tag} yet: a draft with the changelog's notes.`);
  const created = run("gh", ["release", "create", tag, "--draft", "--verify-tag", "--title", `Koona Pin ${version}`, "--notes-file", path.join(staging, "notes.md")], {
    stdio: "inherit",
  });
  // release.yml may have made it in the meantime; the upload below tells.
  if (created.status !== 0) console.warn("gh release create failed; uploading to the release as it is.");
}
console.log(`\n== Upload to the draft ${tag}: ${name}, SHA256SUMS-windows.txt`);
const uploaded = run("gh", ["release", "upload", tag, path.join(staging, name), path.join(staging, "SHA256SUMS-windows.txt"), "--clobber"], { stdio: "inherit" });
await rm(staging, { recursive: true, force: true });
if (uploaded.status !== 0) fail(`The upload failed: bun run release:windows -- --no-build tries again.`);

if (noFinalize) {
  console.log(`\nUploaded. Finalize when the draft has the Linux packages: gh workflow run release.yml -f tag=${tag}`);
  process.exit(0);
}
// Finalize needs the Linux packages of the draft: release.yml's tag run must be done.
const assets = JSON.parse(out("gh", "release", "view", tag, "--json", "assets") || '{"assets":[]}').assets.map((a) => a.name);
const linux = [`koonapin_${version}_amd64.deb`, `koonapin-${version}-1.x86_64.rpm`, `koonapin-${version}-x86_64.AppImage`];
const missing = linux.flatMap((f) => [f, `${f}.sig`]).filter((f) => !assets.includes(f));
if (missing.length) {
  console.log(`\nUploaded. The draft has no ${missing.join(", ")} yet: release.yml's run of ${tag} is not done (bun run release).`);
  console.log(`When it is: gh workflow run release.yml -f tag=${tag}`);
  process.exit(0);
}
console.log(`\n== Finalize: gh workflow run release.yml -f tag=${tag}`);
const started = run("gh", ["workflow", "run", "release.yml", "--ref", "main", "-f", `tag=${tag}`], { stdio: "inherit" });
if (started.status !== 0) fail(`Not started. Later: gh workflow run release.yml -f tag=${tag}`);
console.log(`\nFinalize is running (gh run list --workflow release.yml). When the release is published: bun run release:site -- -Server user@host`);
