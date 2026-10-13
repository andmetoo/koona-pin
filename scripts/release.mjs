// Where the release of a version stands, and the next step (nothing is built or changed here):
//   bun run release              this checkout's version
//   bun run release -- 0.12.0    another version
// A release goes (docs/building.md):
//   1. bun run version:bump <x.y.z>, the changelog written, the PR merged
//   2. bun run release:tag       on main: the tag v<version>; release.yml builds Linux and macOS into a draft
//   3. bun run release:windows   on the Windows computer: the signed installer into the draft, then finalize
//   4. release.yml finalize      latest.json, release.json and the AUR files, the release published
//   5. release.yml deploy        the release data to koona.app (Р-60); the site reads it at request time
// Read through git and gh only: the tag here and on origin, release.yml's runs of the tag, the release's assets.
import { spawnSync } from "node:child_process";
import { entry } from "./lib/changelog.mjs";
import { root } from "./lib/paths.mjs";
import { version as currentVersion, versions } from "./version.mjs";

const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
const out = (cmd, ...args) => {
  const result = run(cmd, args);
  return result.status === 0 ? result.stdout.trim() : null;
};
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

let version = process.argv.slice(2).find((a) => /^\d+\.\d+\.\d+$/.test(a));
if (!version) {
  try {
    version = await currentVersion();
  } catch (error) {
    fail(error.message);
  }
}
const tag = `v${version}`;
const line = (what, state) => console.log(`  ${what.padEnd(10)} ${state}`);
const next = (...steps) => {
  console.log(`\nNext:\n${steps.filter(Boolean).map((s) => `  ${s}`).join("\n")}`);
  process.exit(0);
};
if (run("gh", ["--version"]).error) fail("gh is not installed: this status reads GitHub through it (https://cli.github.com).");

console.log(`Koona Pin ${version}`);
const here = await versions();
if (Object.values(here).some((v) => v !== version)) line("checkout", `${Object.values(here)[0]}: the release of ${version} is read from GitHub only`);

let changelog = true;
try {
  entry(version);
  line("changelog", `changelog/${version}.md`);
} catch (error) {
  changelog = false;
  line("changelog", error.message);
}

const local = out("git", "rev-parse", "--verify", "--quiet", `${tag}^{commit}`);
const remote = out("git", "ls-remote", "--tags", "origin", `refs/tags/${tag}^{}`) || out("git", "ls-remote", "--tags", "origin", `refs/tags/${tag}`);
const remoteCommit = remote?.split(/\s/)[0] ?? "";
line("tag", remoteCommit ? `${tag} on origin, ${remoteCommit.slice(0, 7)}${local && local !== remoteCommit ? ` (here ${local.slice(0, 7)}: git fetch --tags --force)` : ""}` : local ? `${tag} here only` : "none");
if (!remoteCommit) {
  if (!changelog) next(`Write changelog/${version}.md (bun run version:bump ${version} starts it), merge it, then bun run release:tag.`);
  if (local) next(`git push origin ${tag}`);
  next("On main, after the version's PR is merged: bun run release:tag");
}

// release.yml names its runs «Release v…» (the tag) and «Finalize v…» (workflow_dispatch).
const runs = JSON.parse(
  out("gh", "run", "list", "--workflow", "release.yml", "--limit", "50", "--json", "displayTitle,status,conclusion,url,createdAt,event") ?? "[]",
);
const latestRun = (kind) => runs.find((r) => r.displayTitle === `${kind} ${tag}`);
const state = (r) => (r ? `${r.status === "completed" ? r.conclusion : r.status}, ${r.createdAt.slice(0, 16).replace("T", " ")} ${r.url}` : "none");
const build = latestRun("Release");
const finalize = latestRun("Finalize");
// The deploy job of the finalize run (release.yml): whether koona.app serves the release.
const deployJob = finalize
  ? JSON.parse(out("gh", "run", "view", finalize.url.split("/").pop(), "--json", "jobs") ?? '{"jobs":[]}').jobs.find((j) => j.name === "Deploy to koona.app")
  : null;
const deploy = deployJob ? { ...deployJob, url: finalize.url } : null;
line("build", state(build));
if (finalize) line("finalize", state(finalize));
if (deploy) line("deploy", deploy.status === "completed" ? deploy.conclusion : deploy.status);

const view = run("gh", ["release", "view", tag, "--json", "isDraft,assets,url"]);
const release = view.status === 0 ? JSON.parse(view.stdout) : null;
const names = release?.assets.map((a) => a.name) ?? [];
const has = (...files) => files.every((f) => names.includes(f));
const linuxFiles = [`koonapin_${version}_amd64.deb`, `koonapin-${version}-1.x86_64.rpm`, `koonapin-${version}-x86_64.AppImage`];
const groups = {
  linux: has(...linuxFiles, ...linuxFiles.map((f) => `${f}.sig`), "SHA256SUMS-linux.txt"),
  macos: names.some((n) => n.endsWith(".dmg")) && has("SHA256SUMS-macos.txt"),
  windows: has(`koonapin_${version}_x64-setup.exe`, "SHA256SUMS-windows.txt"),
  updates: has("latest.json"),
  data: has("release.json", "release.json.sig"),
  aur: has("koonapin-bin.PKGBUILD", "koonapin-bin.SRCINFO"),
};
line("release", release ? `${release.isDraft ? "draft" : "published"} ${release.url}` : "none");
if (release) line("assets", Object.entries(groups).map(([k, v]) => `${k} ${v ? "yes" : "no"}`).join(", "));

const active = (r) => r && r.status !== "completed";
const failed = (r) => r && r.status === "completed" && r.conclusion !== "success";
if (release && !release.isDraft) {
  next(
    "The release is published. The release data deploys itself (finalize); the site picks it up at request time.",
    deploy && deploy.status === "completed" && deploy.conclusion !== "success"
      ? `Its deploy to koona.app failed: ${deploy.url}. Again, alone: gh run rerun ${deploy.url.split("/").pop()} --failed`
      : "",
    groups.aur ? `The AUR: koonapin-bin.PKGBUILD and .SRCINFO of the release, pushed by hand to aur.archlinux.org/koonapin-bin.git` : "",
  );
}
if (active(finalize)) next(`Finalize is running: ${finalize.url}`);
if (active(build)) next(`release.yml is building ${tag}: ${build.url}`, "Meanwhile, on the Windows computer: bun run release:windows -- --no-finalize");
if (!build) next(`No release.yml run of ${tag}: was the tag pushed before release.yml was on main? Re-push the tag, or look at Actions.`);
if (failed(build) && !(groups.linux && groups.macos)) next(`release.yml failed for ${tag}: ${build.url}`, `Fix and rerun: gh run rerun ${build.url.split("/").pop()} --failed`);
if (!groups.windows) next("On the Windows computer, at the tag's commit (git switch --detach " + tag + "): bun run release:windows");
if (failed(finalize)) next(`Finalize failed: ${finalize.url}`, `Again: gh workflow run release.yml --ref ${tag} -f tag=${tag}`);
next(`Finalize (latest.json, release.json, the AUR files, publish, deploy): gh workflow run release.yml --ref ${tag} -f tag=${tag}`);
