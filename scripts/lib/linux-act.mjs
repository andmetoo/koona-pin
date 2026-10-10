// The Linux packages away from Linux (bun run build:linux on Windows or macOS): the «build» job of
// .github/workflows/linux.yml run by act in Docker — the same Debian 13 and scripts as on GitHub — and
// its artifact unpacked into release/publish/linux/<version>/, where build:aur and build:latest take it.
// With unpack only, the artifact of the last act run is taken as it is (act started by hand).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { publish, root } from "./paths.mjs";

/** Where act keeps artifacts (.actrc): <run id>/<name>/<name>.zip. clean.mjs leaves it. */
export const actArtifacts = path.join(root, ".test-data", "act-artifacts");
const ARTIFACT = "koonapin-linux-x86_64";

const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const succeeds = (command, args) => spawnSync(command, args, { cwd: root, stdio: "ignore" }).status === 0;

/** What a build in act lacks, one message each; empty when it can run. */
export function actProblems() {
  if (!succeeds("act", ["--version"])) return ["act is not installed (scoop install act): it runs the «build» job of linux.yml in Docker"];
  if (!succeeds("docker", ["info"])) return ["Docker is not running: start Docker Desktop"];
  return [];
}

async function artifacts() {
  if (!existsSync(actArtifacts)) return [];
  const found = [];
  for (const run of await readdir(actArtifacts)) {
    const zip = path.join(actArtifacts, run, ARTIFACT, `${ARTIFACT}.zip`);
    if (existsSync(zip)) found.push({ zip, time: (await stat(zip)).mtimeMs });
  }
  return found.sort((a, b) => b.time - a.time).map((a) => a.zip);
}

export async function linuxInAct({ version, unpackOnly }) {
  if (!unpackOnly) {
    const problems = actProblems();
    // act hands .env to the job as secrets (.actrc): without the address the job fails after its setup.
    if (!process.env.KOONAPIN_FEEDBACK_URL) problems.push("KOONAPIN_FEEDBACK_URL is not set in .env: the release build does not compile without it (supabase/README.md)");
    if (problems.length) fail(problems.join("\n"));
    // act's own pull fails on a stale Docker Hub login, a plain docker pull does not.
    if (!succeeds("docker", ["image", "inspect", "debian:13"]) && spawnSync("docker", ["pull", "debian:13"], { stdio: "inherit" }).status !== 0) {
      fail("docker pull debian:13 failed");
    }
    // A package of an earlier run must not pass for this one.
    for (const old of await artifacts()) await rm(path.dirname(old), { recursive: true, force: true });
    const act = spawnSync("act", ["workflow_dispatch", "-W", ".github/workflows/linux.yml", "-j", "build"], { cwd: root, stdio: "inherit" });
    if (act.status !== 0) fail(`act: the «build» job of linux.yml failed (exit ${act.status ?? act.signal}), its log is above`);
  }

  const [zip] = await artifacts();
  if (!zip) fail(`No ${ARTIFACT} artifact in ${path.relative(root, actArtifacts)}: bun run build:linux runs act and unpacks it`);
  const unpacked = await mkdtemp(path.join(tmpdir(), "koonapin-linux-"));
  // bsdtar reads zip: tar.exe of Windows, tar of macOS.
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  if (spawnSync(tar, ["-xf", zip, "-C", unpacked], { stdio: "inherit" }).status !== 0) fail(`Could not unpack ${zip}`);

  const sums = existsSync(path.join(unpacked, "SHA256SUMS.txt")) ? await readFile(path.join(unpacked, "SHA256SUMS.txt"), "utf8") : "";
  const files = [`koonapin_${version}_amd64.deb`, `koonapin-${version}-1.x86_64.rpm`, `koonapin-${version}-x86_64.AppImage`];
  for (const file of files) {
    const line = sums.split("\n").find((l) => l.trimEnd().endsWith(`  ${file}`));
    if (!line) {
      const built = sums.match(/koonapin_(\S+)_amd64\.deb/)?.[1] ?? "unknown";
      fail(`The artifact in ${path.relative(root, zip)} is of ${built}, tauri.conf.json says ${version}: bun run build:linux builds it anew`);
    }
    const hash = createHash("sha256").update(await readFile(path.join(unpacked, file))).digest("hex");
    if (line.split(/\s+/)[0] !== hash) fail(`${file} of the artifact does not match its SHA256SUMS.txt`);
  }

  const out = publish.linux(version);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const file of [...files, "SHA256SUMS.txt"]) await copyFile(path.join(unpacked, file), path.join(out, file));
  await rm(unpacked, { recursive: true, force: true });
  for (const file of files) console.log(`${path.relative(root, path.join(out, file))}: ${((await stat(path.join(out, file))).size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`\n${sums.trim()}`);
}
