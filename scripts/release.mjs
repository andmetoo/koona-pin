// A release of the app in one command, on the owner's Windows computer (doc/README.md, «Выпуск»):
//   bun run release                      builds what this version still lacks, keeps the rest
//   bun run release -- --only linux      one system; the other sees no update in this release
//   bun run release -- --rebuild linux   builds a system's packages again although they are there
// The steps, each skipped when its packages are there:
//   1. the Windows installer signed with Certum   bun run build:installer -- --sign   SimplySign Desktop signed in
//   2. the .deb, .rpm and AppImage               bun run build:linux                 Docker and act, about 20 minutes
//   3. PKGBUILD and .SRCINFO of the AUR          bun run build:aur
//   4. update signatures and latest.json          bun run build:latest                the update key in .env
// What the steps need is checked before the first one, all at once: the changelog of the version, the
// update key, SimplySign, Docker, a committed working copy. Packages that are there but older than the
// app's code stop the release: bump the version, or --rebuild. The site goes out after it, by the owner:
//   pwsh scripts/deploy-site.ps1 -Server user@host
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { entry } from "../site/src/changelog.mjs";
import { actProblems } from "./lib/linux-act.mjs";
import { publish, root } from "./lib/paths.mjs";

const dotenv = path.join(root, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const option = (name) => {
  if (!process.argv.includes(name)) return undefined;
  const value = process.argv[process.argv.indexOf(name) + 1];
  if (!["windows", "linux"].includes(value)) fail(`${name} takes windows or linux`);
  return value;
};
const only = option("--only");
const rebuild = option("--rebuild");
const systems = only ? [only] : ["windows", "linux"];

const { version } = JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const relative = (p) => path.relative(root, p).split(path.sep).join("/");

/** What each system's packages are made of: a change there after the build makes them old. */
const COMMON = ["src", "src-tauri", "index.html", "bun.lock", "vite.config.ts", "tsconfig.json", "rust-toolchain.toml"];
const sources = {
  windows: [...COMMON, ":!src-tauri/linux", "scripts/build-installer.mjs", "scripts/sign-windows.ps1"],
  linux: [...COMMON, "scripts/build-linux-packages.mjs", "scripts/lib/linux-act.mjs", "scripts/linux"],
};
const folders = { windows: publish.windows(version), linux: publish.linux(version) };
const complete = {
  windows: (files) => files.some((f) => f.endsWith("-setup.exe") && f.includes(`_${version}_`)),
  linux: (files) => [`koonapin_${version}_amd64.deb`, `koonapin-${version}-1.x86_64.rpm`, `koonapin-${version}-x86_64.AppImage`].every((f) => files.includes(f)),
};

const problems = [];
const notes = [];
const plan = {};
for (const system of systems) {
  const folder = folders[system];
  const files = existsSync(folder) ? await readdir(folder) : [];
  if (rebuild === system || !complete[system](files)) {
    plan[system] = "build";
    continue;
  }
  plan[system] = "keep";
  // The commit SHA256SUMS.txt names: a package built before the app changed is not this version's.
  const sums = files.includes("SHA256SUMS.txt") ? await readFile(path.join(folder, "SHA256SUMS.txt"), "utf8") : "";
  const commit = sums.match(/commit ([0-9a-f]{7,40})/)?.[1];
  if (!commit) {
    notes.push(`${system}: ${relative(folder)} does not say which commit it was built from`);
    continue;
  }
  const diff = git("diff", "--quiet", commit, "HEAD", "--", ...sources[system]);
  if (diff.status === 1) {
    problems.push(
      `${system}: ${relative(folder)} was built from ${commit}, and the app has changed since (git diff ${commit} HEAD): bump the version, or bun run release -- --rebuild ${system}`,
    );
  } else if (diff.status !== 0) {
    notes.push(`${system}: ${relative(folder)} was built from ${commit}, a commit this repository does not have`);
  } else {
    notes.push(`${system}: ${relative(folder)}, built from ${commit}${sums.includes("with uncommitted changes") ? " with uncommitted changes" : ""}`);
  }
}

// Everything the steps need, before the first long one.
try {
  entry(version);
} catch (error) {
  problems.push(error.message);
}
if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
  problems.push("The update key is not set: TAURI_SIGNING_PRIVATE_KEY (or _PATH) and its password in .env");
}
const building = systems.filter((s) => plan[s] === "build");
if (building.length) {
  if (!process.env.KOONAPIN_FEEDBACK_URL) problems.push("KOONAPIN_FEEDBACK_URL is not set in .env: the release build does not compile without it");
  // act copies the working copy, uncommitted files and all; the installer is built from it too.
  const changed = git("status", "--porcelain", "--untracked-files=no", "--", ...new Set(building.flatMap((s) => sources[s]))).stdout.trimEnd();
  if (changed) problems.push(`Uncommitted changes of the app: a release is built from a commit\n${changed.replace(/^/gm, "     ")}`);
}
if (plan.windows === "build") {
  if (process.platform !== "win32") {
    problems.push("The Windows installer is built on Windows: bun run release -- --only linux");
  } else {
    const check = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "sign-windows.ps1"), "-Check"], {
      encoding: "utf8",
    });
    if (check.status !== 0) {
      const why = `${check.stderr}${check.stdout}`.split("\n").find((l) => l.trim() && !l.startsWith(" ") && !l.startsWith("At ")) ?? "";
      problems.push(`Certum: ${why.trim()}. Needed: SimplySign Desktop signed in, SIGN_CERT_SHA1 in .env, signtool (doc/release-checklist.md)`);
    }
  }
}
if (plan.linux === "build" && process.platform !== "linux") problems.push(...actProblems());

const what = {
  windows: { build: "to build and sign with Certum", keep: "there" },
  linux: { build: "to build in Docker by act, about 20 minutes", keep: "there" },
};
console.log(`Koona Pin ${version}`);
for (const system of systems) console.log(`  ${system.padEnd(8)} ${relative(folders[system])}: ${what[system][plan[system]]}`);
if (systems.includes("linux")) console.log(`  ${"aur".padEnd(8)} ${relative(publish.aur(version))}`);
console.log(`  ${"updates".padEnd(8)} ${relative(path.join(publish.updates, version))}`);
for (const note of notes) console.log(`  · ${note}`);
if (problems.length) fail(`\nNot started:\n${problems.map((p) => `  - ${p}`).join("\n")}`);

const step = (title, args) => {
  console.log(`\n== ${title}: bun ${args.join(" ")}`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) fail(`\n${title} failed. What is built stays: bun run release goes on from this step.`);
};
if (plan.windows === "build") {
  step("Dependencies", ["install", "--frozen-lockfile"]);
  step("Windows", ["run", "build:installer", "--", "--sign"]);
}
if (plan.linux === "build") step("Linux", ["run", "build:linux"]);
if (systems.includes("linux")) step("AUR", ["run", "build:aur"]);
step("Updates", ["run", "build:latest", ...(only ? ["--", "--only", only] : [])]);

console.log(`\nKoona Pin ${version} is ready in ${relative(path.join(publish.updates, version))}. The site takes it when it goes out:\n  pwsh scripts/deploy-site.ps1 -Server user@host`);
