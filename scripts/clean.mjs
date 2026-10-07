// Clears what tests and scripts leave behind (README, «Сборки: что где»). Every run of a test or a
// smoke script keeps its own folder in .test-data, and Rust tests and the app keep theirs in the
// temp folder: thousands of folders and tens of gigabytes in a week. npm runs this before check,
// the native, host and extension tests and build:installer (package.json); by hand:
//
//   npm run clean                 .test-data (but libraries), test-results, playwright-report,
//                                 koonapin-* in the temp folder
//   npm run clean -- --cargo      the same, and the Cargo build folders: the next build starts over
//   npm run clean -- --list       what the generated folders take; nothing is removed
//
// Whatever changed in the last 30 minutes stays, so a test running in another terminal keeps its
// folder. release/ is never touched: it holds what goes to people and stores (scripts/lib/paths.mjs).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { release, root } from "./lib/paths.mjs";

const args = new Set(process.argv.slice(2));
const RECENT = 30 * 60 * 1000;
const from = (...p) => path.join(root, ...p);

/** Test libraries built by `cargo run --example test_libraries`: inputs, not output. */
const KEEP = new Set(["libraries"]);
const cargoProjects = ["src-tauri", "scripts/search-bench", "scripts/native-messaging-probe", "scripts/platform-probe/mobile-app/src-tauri"];

async function size(target) {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    const info = await lstat(current).catch(() => null);
    if (!info) continue;
    if (!info.isDirectory()) {
      total += info.size;
      continue;
    }
    for (const entry of await readdir(current).catch(() => [])) stack.push(path.join(current, entry));
  }
  return total;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toLocaleString("en", { maximumFractionDigits: 0 })} MB`;

/** Entries of a folder that may go: not kept, not touched in the last 30 minutes. */
async function stale(folder, pick = () => true) {
  if (!existsSync(folder)) return [];
  const now = Date.now();
  const entries = [];
  for (const name of await readdir(folder)) {
    if (KEEP.has(name) || !pick(name)) continue;
    const full = path.join(folder, name);
    const info = await lstat(full).catch(() => null);
    if (info && now - info.mtimeMs > RECENT) entries.push(full);
  }
  return entries;
}

async function scratch() {
  return [
    ...(await stale(from(".test-data"))),
    ...(await stale(root, (name) => name === "test-results" || name === "playwright-report")),
    ...(await stale(tmpdir(), (name) => name.startsWith("koonapin-"))),
  ];
}

if (args.has("--list")) {
  const rows = [
    [".test-data", from(".test-data"), "test and script runs; libraries stays"],
    ["test-results", from("test-results"), "Playwright and site check output"],
    ["temp koonapin-*", null, "Rust tests and the app"],
    ["dist", from("dist"), "the app's interface, rebuilt by every build"],
    ...cargoProjects.map((p) => [`${p}/target`, from(p, "target"), "Cargo, --cargo removes it"]),
    ["release/publish", path.join(release, "publish"), "to people and stores, kept"],
    ["release/test", path.join(release, "test"), "test machines, kept"],
    ["release/dev", path.join(release, "dev"), "unpacked extensions, rebuilt"],
    [".cache", from(".cache"), "Playwright browsers, kept"],
    ["node_modules", from("node_modules"), "npm ci, kept"],
  ];
  for (const [name, folder, what] of rows) {
    let bytes = 0;
    if (folder) {
      if (!existsSync(folder)) continue;
      bytes = await size(folder);
    } else {
      for (const entry of (await readdir(tmpdir())).filter((n) => n.startsWith("koonapin-"))) bytes += await size(path.join(tmpdir(), entry));
    }
    console.log(`${mb(bytes).padStart(10)}  ${name.padEnd(46)} ${what}`);
  }
  process.exit(0);
}

const targets = await scratch();
let freed = 0;
const busy = [];
for (const target of targets) {
  const bytes = await size(target);
  try {
    await rm(target, { recursive: true, force: true, maxRetries: 2 });
    freed += bytes;
  } catch {
    // A running app or test holds a file: the folder goes next time.
    busy.push(path.relative(root, target) || target);
  }
}
console.log(`clean: ${targets.length - busy.length} folders, ${mb(freed)} freed${busy.length ? `; in use, left: ${busy.join(", ")}` : ""}`);

if (args.has("--cargo")) {
  for (const project of cargoProjects) {
    const manifest = from(project, "Cargo.toml");
    if (!existsSync(manifest) || !existsSync(from(project, "target"))) continue;
    execFileSync("cargo", ["clean", "--manifest-path", manifest], { stdio: "inherit" });
  }
}
