// Launch the exact packaged executable, test real IPC in WKWebView and photograph its window.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync, readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { root, test } from "../lib/paths.mjs";

if (process.platform !== "darwin") throw new Error("Native macOS smoke tests need a macOS desktop");
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const output = path.join(root, "test-results", "macos");
const session = path.join(root, ".test-data", `macos-smoke-${Date.now()}`);
mkdirSync(output, { recursive: true });
mkdirSync(session, { recursive: true });
const binary = path.join(test.macos(version, process.arch), "Koona Pin.app", "Contents", "MacOS", "koonapin");
const capture = path.join(session, "capture");
execFileSync("swiftc", [path.join(root, "scripts", "macos", "capture.swift"), "-o", capture], { stdio: "inherit" });
const seed = JSON.parse(readFileSync(path.join(root, "site", "shots", "library.json"), "utf8"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function library(lang) {
  const date = "2026-10-03T09:30:00Z";
  const tags = new Map();
  return { format: "koona-pin", version: 1, exported_at: date, app_version: version,
    collections: seed.collections.map((c, i) => ({ uid: `macos-c-${i}`, name: c[lang], color: null, icon: null, created_at: date })),
    bookmarks: seed.bookmarks.map((b, i) => {
      b.tags[lang].forEach((name) => tags.set(name, { uid: `macos-t-${name}`, name, created_at: date }));
      return { uid: `macos-b-${i}`, url: b.url, title: b.title[lang], description: null, notes: null,
        domain: new URL(b.url).hostname.replace(/^www\./, ""), image_url: null, favicon_url: null,
        is_favorite: b.favorite, collection: `macos-c-${b.collection}`, tags: b.tags[lang], source: "import",
        created_at: date, updated_at: date, triaged_at: b.inbox ? null : date, deleted_at: null };
    }), tags: [...tags.values()] };
}
async function shoot(lang, theme, view, { verify = false, persistOnly = false, data } = {}) {
  const name = `${lang}-${theme}-${view}${persistOnly ? "-relaunch" : ""}`;
  data ??= path.join(session, name);
  mkdirSync(data, { recursive: true });
  const config = path.join(session, `${name}.json`);
  const report = path.join(output, `${name}.json`);
  if (existsSync(report)) unlinkSync(report);
  writeFileSync(config, JSON.stringify({ lang, theme, view, verify, persistOnly, library: library(lang) }));
  const env = { ...process.env, KOONAPIN_DATA_DIR: data, KOONAPIN_MACOS_SMOKE_CONFIG: config, KOONAPIN_MACOS_SMOKE_REPORT: report };
  const fd = openSync(path.join(output, `${name}.log`), "w");
  const app = spawn(binary, [], { env, stdio: ["ignore", fd, fd] });
  let spawnError;
  app.once("error", (error) => { spawnError = error; });
  try {
    const deadline = Date.now() + 90000;
    while (!existsSync(report)) {
      if (spawnError) throw spawnError;
      if (app.exitCode !== null || app.signalCode !== null) throw new Error(`${name}: app exited before report; see ${name}.log`);
      if (Date.now() > deadline) throw new Error(`${name}: no native report within 90 seconds`);
      await sleep(200);
    }
    const result = JSON.parse(readFileSync(report, "utf8"));
    if (!result.ok || !result.embedded) throw new Error(`${name}: ${JSON.stringify(result)}`);
    execFileSync(capture, [String(app.pid), path.join(output, `${name}.png`)], { stdio: "inherit" });
    if (verify) {
      // The already-open app must keep running and a second start must exit promptly.
      execFileSync(binary, [], { env, stdio: "pipe", timeout: 15000 });
      if (app.exitCode !== null) throw new Error("First app exited on second start");
      result.checks.push("second launch hands over to first instance");
      writeFileSync(report, JSON.stringify(result, null, 2));
    }
    console.log(`${name}: ${result.checks.join(", ")}`);
    return data;
  } finally {
    app.kill("SIGTERM");
    const deadline = Date.now() + 5000;
    while (app.exitCode === null && app.signalCode === null && Date.now() < deadline) await sleep(100);
    if (app.exitCode === null && app.signalCode === null) app.kill("SIGKILL");
    closeSync(fd);
  }
}
try {
  const data = await shoot("en", "light", "grid", { verify: true });
  await shoot("en", "light", "grid", { persistOnly: true, data });
  for (const lang of ["en", "ru"]) for (const theme of ["light", "dark"]) for (const view of ["grid", "list"]) {
    if (lang === "en" && theme === "light" && view === "grid") continue;
    await shoot(lang, theme, view);
  }
} catch (error) {
  writeFileSync(path.join(output, "failure.txt"), String(error));
  throw error;
}
