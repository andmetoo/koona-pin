// Fills a debug build of Koona Pin on an Android emulator or phone with the sample library of the
// site's shots, for the Google Play screenshots and the preview video (src-tauri/store/play/README.md,
// src-tauri/store/play/video/scenario.md). The screens themselves are taken by hand afterwards, with
// adb (the README says how).
//
//   bun scripts/play-shots.mjs            restore the sample library, its pictures and the feeds
//   bun scripts/play-shots.mjs --demo     only the status bar's demo mode (9:41, full battery and signal)
//
// Needs a debuggable build (`bun run tauri android build --debug --apk --target x86_64` for the
// emulator) installed and started once, adb on the PATH or under ANDROID_HOME, and one device.
// What it does, since a phone build has none of the desktop's shot hooks (shots.rs, shot_previews.rs):
// - the library: `restore_library` through the WebView's DevTools, as site-screenshots.mjs does;
// - the previews: written straight into the picture cache (thumbs.rs: thumbs/<aa>/<sha256>.jpg), so
//   the made-up sites of the sample are never asked;
// - the feeds of scripts/shots/feeds.json: their subscriptions in the library and their posts in
//   feeds.db, written with the app stopped, as site-screenshots-macos.mjs writes them through SQL.
import { chromium } from "@playwright/test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { copyOf, dataUrl, html, library, previews, until } from "./lib/shots.mjs";

const root = path.resolve(import.meta.dirname, "..");
const PACKAGE = "app.koona.pin";
const PORT = 9341;
// Not fetched: the pictures are in the cache before the library names them.
const BASE = "https://koona.app/pin/shots";
const sdk = process.env.ANDROID_HOME ?? path.join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk");
const adbPath = path.join(sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
const adb = (...args) => execFileSync(adbPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const runAs = (command) => adb("shell", `run-as ${PACKAGE} sh -c '${command}'`);
const work = path.join(root, ".test-data", "play-shots");

/** The status bar of the shots: 9:41, full battery and Wi-Fi, no notifications. */
function demoMode() {
  const demo = (command, ...extra) => adb("shell", "am", "broadcast", "-a", "com.android.systemui.demo", "-e", "command", command, ...extra);
  adb("shell", "settings", "put", "global", "sysui_demo_allowed", "1");
  demo("enter");
  demo("clock", "-e", "hhmm", "0941");
  demo("battery", "-e", "level", "100", "-e", "plugged", "false");
  demo("network", "-e", "wifi", "show", "-e", "level", "4", "-e", "fully", "true");
  demo("network", "-e", "mobile", "hide");
  demo("notifications", "-e", "visible", "false");
  // The emulator's own notifications (Safety Center, tutorials) still put icons in the bar: a day's snooze.
  const keys = [...adb("shell", "dumpsys", "notification", "--noredact").matchAll(/NotificationRecord\([^)]*?key=(\S+?):/g)].map((m) => m[1]);
  for (const key of new Set(keys)) adb("shell", "cmd", "notification", "snooze", "--for", String(86400e3), `'${key}'`);
}

if (process.argv.includes("--demo")) {
  demoMode();
  process.exit(0);
}

// The site's sample feeds and the phone's own (a news site, a travel site, a blog: play-feeds.json).
const readJson = async (name) => JSON.parse(await readFile(path.join(root, "scripts", "shots", name), "utf8"));
const [siteFeeds, phoneFeeds] = await Promise.all([readJson("feeds.json"), readJson("play-feeds.json")]);
const feeds = { feeds: [...phoneFeeds.feeds, ...siteFeeds.feeds], posts: [...phoneFeeds.posts, ...siteFeeds.posts] };
const ANCHOR = Date.now();
const stamp = (ms) => new Date(ms).toISOString();

/** Where the app keeps its files on this device: the library's folder and the picture cache. */
function folders() {
  const db = runAs("find /data/data/app.koona.pin -name koonapin.db").trim().split("\n")[0];
  if (!db) throw new Error("no library on the device: start the app once first");
  return { data: path.posix.dirname(db), thumbs: `/data/data/${PACKAGE}/cache/thumbs` };
}

/** Copies a local file to `target` in the app's folders (through /data/local/tmp, which run-as reads). */
function put(local, target) {
  const temp = `/data/local/tmp/${path.basename(local)}`;
  adb("push", local, temp);
  runAs(`mkdir -p ${path.posix.dirname(target)} && cp ${temp} ${target}`);
  adb("shell", "rm", temp);
}

/** Copies a file of the app's folders here (run-as may not write to /data/local/tmp: read it raw). */
async function get(remote, local) {
  await writeFile(local, execFileSync(adbPath, ["exec-out", "run-as", PACKAGE, "cat", remote], { maxBuffer: 256 * 1024 * 1024 }));
}

/** The restore, through the DevTools of the WebView of the running app. */
async function restore() {
  adb("shell", "monkey", "-p", PACKAGE, "-c", "android.intent.category.LAUNCHER", "1");
  let pid = "";
  await until(async () => (pid = adb("shell", "pidof", PACKAGE).trim()) !== "", "the app's process");
  adb("forward", `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
  let browser;
  await until(async () => {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    return browser.contexts()[0]?.pages().length > 0;
  }, "the WebView's DevTools (a debug build?)");
  const page = browser.contexts()[0].pages()[0];
  await until(() => page.evaluate(() => !!window.__TAURI_INTERNALS__), "the app page");
  await page.evaluate(
    (content) => window.__TAURI_INTERNALS__.invoke("restore_library", { content, mode: "replace" }),
    JSON.stringify(copyOf(BASE, ANCHOR)),
  );
  // The import offer of a new library is closed: the shots show the library itself.
  await page.evaluate(() => localStorage.setItem("koonapin.importBanner", "done"));
  await browser.close();
  adb("forward", "--remove", `tcp:${PORT}`);
}

/** The sample's previews in the picture cache, under the addresses the restored library names. */
async function pictures(thumbs) {
  const out = path.join(work, "thumbs");
  for (const b of library.bookmarks) {
    const address = `${BASE}/${b.preview}`;
    const key = createHash("sha256").update(address).digest("hex");
    const local = path.join(out, `${key}.jpg`);
    await writeFile(local, await readFile(path.join(previews, b.preview)));
    put(local, `${thumbs}/${key.slice(0, 2)}/${key}.jpg`);
  }
}

/** The feeds: subscriptions in the library, posts in feeds.db, written with the app stopped. */
async function feedPosts(data) {
  adb("shell", "am", "force-stop", PACKAGE);
  const now = Date.now();
  const files = {};
  for (const name of ["koonapin.db", "feeds.db"]) {
    const local = path.join(work, name);
    await rm(local, { force: true });
    for (const suffix of ["-wal", "-shm"]) await rm(local + suffix, { force: true });
    await get(`${data}/${name}`, local);
    // A WAL left by the stop holds the newest pages: bring it along so SQLite replays it.
    if (runAs(`test -f ${data}/${name}-wal && echo yes || true`).trim() === "yes") await get(`${data}/${name}-wal`, local + "-wal");
    files[name] = local;
  }
  const lib = new Database(files["koonapin.db"]);
  const cache = new Database(files["feeds.db"]);
  // The library's triggers call the app's own SQL functions (sync's capture): they are set aside
  // while the shots' rows go in and put back as they were, in one transaction, so a row that fails
  // leaves the library as it was, triggers included. Nothing here is for sync.
  lib.transaction(() => {
    const triggers = lib.query("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('feeds', 'collections')").all();
    for (const t of triggers) lib.run(`DROP TRIGGER "${t.name}"`);
    for (const [i, f] of feeds.feeds.entries()) {
      const at = stamp(now - (40 - i) * 86400e3);
      lib.run("INSERT OR IGNORE INTO feeds (uid, url, title, destination, created_at, updated_at) VALUES (?, ?, NULL, 'feeds', ?, ?)", [f.uid, f.url, at, at]);
    }
    // One collection inside another, for the nested chips (2.19.0): Inspiration inside Design.
    lib.run("UPDATE collections SET parent_id = (SELECT id FROM collections WHERE uid = 'site-collection-0') WHERE uid = 'site-collection-2'");
    for (const t of triggers) lib.run(t.sql);
  })();
  for (const f of feeds.feeds) {
    cache.run(
      "INSERT OR REPLACE INTO feed_state (feed_uid, title, site_url, fetched_at, succeeded_at, next_fetch_at, failures) VALUES (?, ?, ?, ?, ?, ?, 0)",
      [f.uid, f.title, f.site, stamp(now), stamp(now), stamp(now + 30 * 86400e3)],
    );
  }
  for (const p of feeds.posts) {
    const site = new URL(feeds.feeds.find((f) => f.uid === p.feed).site).origin;
    const url = `${site}/${p.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")}`;
    const at = stamp(now - p.hoursAgo * 3600e3);
    // Feed pictures load over https or from data only (feedsView.ts): the sample's as data.
    const picture = p.picture ? await dataUrl(p.picture) : null;
    const body = `${picture ? `<figure><img src="${picture}" alt=""></figure>\n` : ""}${html(p.body)}`;
    cache.run(
      `INSERT OR REPLACE INTO feed_items (feed_uid, key, url, title, author, excerpt, content_html, full, thumbnail_url, published_at, fetched_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [p.feed, url, url, p.title, p.author, p.excerpt, body, picture, at, at, p.read ? stamp(now) : null],
    );
  }
  for (const db of [lib, cache]) {
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  }
  for (const [name, local] of Object.entries(files)) {
    runAs(`rm -f ${data}/${name}-wal ${data}/${name}-shm`);
    put(local, `${data}/${name}`);
  }
}

await mkdir(path.join(work, "thumbs"), { recursive: true });
demoMode();
await restore();
const { data, thumbs } = folders();
await pictures(thumbs);
await feedPosts(data);
adb("shell", "monkey", "-p", PACKAGE, "-c", "android.intent.category.LAUNCHER", "1");
console.log(`Filled: ${library.bookmarks.length} bookmarks, ${feeds.feeds.length} feeds, ${feeds.posts.length} posts (${data}, ${thumbs})`);
