// Screenshots of the real app on a Mac for koona.app/pin: the debug build (its interface embedded)
// with a data folder of its own, the sample library of scripts/shots/library.json restored into it,
// previews from scripts/shots/previews (Unsplash licence, CREDITS.md there), Chrome connected through
// the real host, feeds and an article of scripts/shots/feeds.json and library.json written as the app
// would have them. WKWebView has no DevTools port to attach to, as WebView2 has for
// site-screenshots.mjs: the app of a test build listens on KOONAPIN_SHOTS_SOCKET (src-tauri/src/shots.rs)
// and this script drives the page through it. The shot is the window itself, `screencapture -l`,
// with its traffic lights and transparent rounded corners. The sync dialog is the browser preview's
// (the built dist/ served outside Tauri, in Chromium): the real one needs a plan and a second computer.
//
//   bun run site:shots:mac   (builds the debug app with its interface embedded first)
//   bun scripts/site-screenshots-macos.mjs --theme dark --view feeds   (only those; each takes a list: light,dark)
//   … --keep   (a failure leaves the test app open for a look, its socket named)
//
// Writes release/shots/app-en-<theme>-<view>.webp (1920 px wide) and -1280.webp, and the 2× PNGs
// for a look in release/shots/png/. Views: grid, list, reading, feeds, triage, sync, and those of the
// help, shared with site-screenshots.mjs (HELP_VIEWS in scripts/lib/shots.mjs): bundle (three
// bookmarks in the bundle, its capsule), bundle-open (its panel), new-link (New link with a page of
// the sample pasted, its preview, Follow on; the answers from KOONAPIN_SHOTS_PREVIEWS) and settings
// (the first section). Quit your own
// Koona Pin first: only one instance runs per user. Needs Screen Recording for the terminal
// (System Settings → Privacy & Security), and moves the test window to the front while it runs.
import { chromium } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import { appBinary, assertNoOtherApp, hello, hostMessage, pipeReady, testPipe } from "./lib/native-host.mjs";
import { root } from "./lib/paths.mjs";
import {
  click, copyOf, HELP_VIEWS, label, library, lit, previews, previewSeed, saved, servePreviews, SETTLED, shotsDir, shotsOut as out, until, webpEncoder,
} from "./lib/shots.mjs";

if (process.platform !== "darwin") throw new Error("site-screenshots-macos.mjs shoots a Mac window: run it on a Mac");

const VIEWS = ["grid", "list", "reading", "feeds", "triage", "sync", ...Object.keys(HELP_VIEWS)];
const { values: args } = parseArgs({
  strict: false,
  options: {
    theme: { type: "string", default: "light,dark" },
    view: { type: "string", default: VIEWS.join(",") },
    // After a failure the test app stays open, its socket named, for a look (kill it by its path after).
    keep: { type: "boolean", default: false },
  },
});
const pick = (value, all) => value.split(",").filter((v) => all.includes(v));
const themes = pick(args.theme, ["light", "dark"]);
const views = pick(args.view, VIEWS);

/** The window's inner size in points; the shot is twice that on a Retina screen. */
const SIZE = { width: 1280, height: 800 };
/** The bookmark grid of the shots: the app's default, the compact grid (`dense`). */
const GRID = "dense";
/**
 * The sample's clock: the newest bookmark and post are from 11:30 today, the rest days and hours
 * before, so every clock time a shot shows is daytime. Before 11:45 that is still to come, and
 * the shots are a day earlier: the newest then reads Yesterday, with the same times.
 */
const ANCHOR = (() => {
  const at = new Date();
  at.setHours(11, 30, 0, 0);
  if (Date.now() < at.getTime() + 15 * 60e3) at.setDate(at.getDate() - 1);
  return at.getTime();
})();
const feeds = JSON.parse(await readFile(path.join(shotsDir, "feeds.json"), "utf8"));
const png = path.join(out, "png");

/** One line to the app's shots socket and its answer, in order. */
class Driver {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.waiting = [];
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        this.waiting.shift()?.resolve(JSON.parse(line));
      }
    });
    socket.on("error", (error) => this.waiting.splice(0).forEach((w) => w.reject(error)));
  }

  static connect(path) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(path);
      socket.once("connect", () => resolve(new Driver(socket)));
      socket.once("error", reject);
    });
  }

  send(line) {
    if (line.includes("\n")) throw new Error("One line per command");
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.socket.write(`${line}\n`);
    });
  }

  async #ok(line) {
    const reply = await this.send(line);
    if ("error" in reply) throw new Error(`${line.slice(0, 120)}: ${reply.error}`);
    return reply.ok;
  }

  /** A JavaScript expression in the window; its value as JSON. */
  js = (expression) => this.#ok(oneLine(expression));
  /** A promise in the window, polled: the socket answers promises as `{}`. */
  async await(expression, what = expression.slice(0, 60), ms = 30000) {
    await this.js(`(window.__shot = null, Promise.resolve(${expression}).then((v) => (window.__shot = { v: v ?? null }), (e) => (window.__shot = { e: String(e) })), 0)`);
    let result;
    await until(async () => (result = await this.js("window.__shot")) !== null, what, ms);
    if ("e" in result) throw new Error(`${what}: ${result.e}`);
    return result.v;
  }
  /** Waits until the expression is truthy in the window. */
  until = (expression, what = expression.slice(0, 60), ms = 30000) => until(() => this.js(expression), what, ms);
  sql = (statements) => this.#ok(`!sql ${oneLine(statements)}`);
  rows = (select) => this.#ok(`!rows ${oneLine(select)}`);
  feedsSql = (statements) => this.#ok(`!feeds ${oneLine(statements)}`);
  size = (w, h) => this.#ok(`!size ${w} ${h}`);
  focus = () => this.#ok("!focus");
  close = () => this.socket.end();
}

const oneLine = (text) => text.replace(/\s*\n\s*/g, " ");
/** A string as an SQL literal. */
const q = (value) => (value === null || value === undefined ? "NULL" : `'${String(value).replaceAll("'", "''")}'`);
const escapeHtml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Paragraphs as HTML; one that starts with «## » is a heading. */
const html = (paragraphs) =>
  paragraphs.map((p) => (p.startsWith("## ") ? `<h2>${escapeHtml(p.slice(3))}</h2>` : `<p>${escapeHtml(p)}</p>`)).join("\n");

/** A preview photo as a `data:` address: feed pictures load over https or from data only (feedsView.ts). */
const dataUrl = async (file) => `data:image/jpeg;base64,${(await readFile(path.join(previews, file))).toString("base64")}`;

/** The on-screen window of a process: `[id, x, y, w, h]` (scripts/shots/window.swift). */
function windowOf(pid) {
  const lines = execFileSync("swift", [path.join(shotsDir, "window.swift"), String(pid)], { encoding: "utf8" }).trim().split("\n");
  const windows = lines.filter(Boolean).map((l) => l.split(" ").map(Number));
  // The main window is the largest; a menu or a tooltip is a window too.
  return windows.sort((a, b) => b[3] * b[4] - a[3] * a[4])[0];
}

/** Starts the test app with a fresh data folder and connects to its socket; `base` serves the previews. */
async function startApp(base) {
  const data = path.join(root, ".test-data", `mac-shots-${Date.now()}`);
  await mkdir(data, { recursive: true });
  // The answers New link gets for the sample's page and its feed (HELP_VIEWS["new-link"]).
  const seed = path.join(data, "previews.json");
  await writeFile(seed, JSON.stringify(previewSeed(base)));
  // A Unix socket's path holds about 100 bytes: a short one beside the data folders.
  const socket = path.join(root, ".test-data", `shots-${process.pid}.sock`);
  await rm(socket, { force: true });
  const pipe = testPipe("mac");
  const env = { ...process.env, KOONAPIN_DATA_DIR: data, KOONAPIN_PIPE: pipe, KOONAPIN_SHOTS_SOCKET: socket, KOONAPIN_SHOTS_PREVIEWS: seed };
  const app = spawn(appBinary(), [], { env, stdio: "ignore" });
  const exited = new Promise((resolve) => app.once("exit", resolve));
  let driver;
  await until(async () => {
    if (app.exitCode !== null) throw new Error("the app exited");
    driver = await Driver.connect(socket);
    return true;
  }, "the shots socket (a test build? bun run site:shots:mac builds one)");
  await driver.until(`document.readyState === "complete" && !!window.__TAURI_INTERNALS__`, "the page");
  await until(() => pipeReady(pipe, env), "the capture pipe");
  return {
    app, driver, data, env, socket,
    async stop() {
      driver.close();
      app.kill();
      await Promise.race([exited, sleep(5000)]);
      await rm(socket, { force: true });
    },
  };
}

/** The ids the app gave the sample's collections, by their place in library.json. */
const collectionIds = [];

/** The sample library, its previews, the feeds and the article to read, as the app keeps them. */
async function fill({ driver, data, env }, base) {
  await driver.await(
    `window.__TAURI_INTERNALS__.invoke("restore_library", { content: ${lit(JSON.stringify(copyOf("https://previews.invalid", ANCHOR)))}, mode: "replace" })`,
    "the restore",
  );
  // The collections' ids pick their colours (collectionColor): the sync shot's preview uses the same.
  for (const [uid, id] of await driver.rows("SELECT uid, id FROM collections WHERE uid LIKE 'site-collection-%'"))
    collectionIds[Number(uid.slice("site-collection-".length))] = id;
  // The restore drops pictures on local addresses (net_guard): the previews are set after it.
  await driver.sql(
    library.bookmarks.map((b, i) => `UPDATE bookmarks SET image_url = ${q(`${base}/${b.preview}`)} WHERE uid = 'site-bookmark-${i}';`).join(" "),
  );
  // The sidebar shows Chrome as connected after a hello through the host.
  await hostMessage(hello("chrome"), { env });

  // Feeds: the subscriptions in the library, their posts in the cache as a fetch leaves them,
  // fetched a moment ago and not due again for a month, so the app fetches nothing.
  const now = Date.now();
  const stamp = (ms) => new Date(ms).toISOString();
  const { feeds: list, posts } = feeds;
  let cache = "";
  for (const f of list)
    cache += `INSERT INTO feed_state (feed_uid, title, site_url, fetched_at, succeeded_at, next_fetch_at, failures)
      VALUES (${q(f.uid)}, ${q(f.title)}, ${q(f.site)}, ${q(stamp(now))}, ${q(stamp(now))}, ${q(stamp(now + 30 * 86400e3))}, 0);`;
  for (const p of posts) {
    const url = `${new URL(list.find((f) => f.uid === p.feed).site).origin}/${p.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")}`;
    const at = stamp(ANCHOR - p.hoursAgo * 3600e3);
    cache += `INSERT INTO feed_items (feed_uid, key, url, title, author, excerpt, content_html, full, thumbnail_url, published_at, fetched_at, read_at)
      VALUES (${q(p.feed)}, ${q(url)}, ${q(url)}, ${q(p.title)}, ${q(p.author)}, ${q(p.excerpt)}, ${q(html(p.body))}, 1,
      ${q(p.picture ? await dataUrl(p.picture) : null)}, ${q(at)}, ${q(at)}, ${p.read ? q(stamp(now)) : "NULL"});`;
  }
  await driver.feedsSql(cache);
  await driver.sql(
    list
      .map((f, i) => `INSERT INTO feeds (uid, url, title, destination, created_at, updated_at) VALUES (${q(f.uid)}, ${q(f.url)}, NULL, 'feeds', ${q(stamp(now - (40 - i) * 86400e3))}, ${q(stamp(now - (40 - i) * 86400e3))});`)
      .join(" "),
  );

  // The article to read: an offline copy (offline.rs), so the reader shows it without the web.
  for (const [i, b] of library.bookmarks.entries()) {
    const a = b.article;
    if (!a) continue;
    const [[id]] = await driver.rows(`SELECT id FROM bookmarks WHERE uid = 'site-bookmark-${i}'`);
    const folder = path.join(data, "offline", String(id));
    await mkdir(path.join(folder, "images"), { recursive: true });
    const picture = await readFile(path.join(previews, b.preview));
    await writeFile(path.join(folder, "images", "01.jpg"), picture);
    const body = `<figure><img src="koona-offline:01.jpg" alt=""></figure>\n${html(a.paragraphs)}`;
    await writeFile(path.join(folder, "article.html"), body);
    const words = a.paragraphs.join(" ").split(/\s+/).length;
    const meta = { url: b.url, title: b.title, author: a.author, site: a.site, published: a.published, description: a.description, language: "en", words };
    await writeFile(path.join(folder, "article.json"), JSON.stringify(meta, null, 2));
    await driver.sql(
      `INSERT OR REPLACE INTO offline_copies (bookmark_id, saved_at, url, bytes, images, words) VALUES (${id}, ${q(stamp(now - 2 * 86400e3))}, ${q(b.url)}, ${picture.length + body.length}, 1, ${words});
       UPDATE bookmarks SET reading_at = ${q(stamp(now - 3600e3))}, reading_progress = 0 WHERE id = ${id};`,
    );
  }
  // The test build's WebKit storage outlives a run (~/Library/WebKit/koonapin): nothing of an
  // earlier one (a sort, a dismissed notice) reaches the shots.
  await driver.js("(localStorage.clear(), true)");
}

/**
 * Each view: the section to open after the reload, and what shows it is there. The reading mode and
 * the feed open on their article, the triage on the first card of the inbox; the help's views
 * (HELP_VIEWS, scripts/lib/shots.mjs) start from the grid.
 */
const VIEW_STEPS = {
  grid: { mode: GRID, open: [], ready: "document.querySelectorAll('[data-bookmark-id] img').length >= 6" },
  list: { mode: "list", open: [], ready: "document.querySelectorAll('[data-bookmark-id]').length >= 10" },
  reading: {
    open: [click(label("nav.reading")), click(label("readingMode.read"), true)],
    ready: `[...document.querySelectorAll("h1")].some((h) => h.textContent === ${lit(library.bookmarks.find((b) => b.article).title)}) && [...document.querySelectorAll("article img, img")].some((i) => i.src.startsWith("data:") && i.complete)`,
  },
  feeds: {
    open: [click(label("feeds.all"))],
    ready: `[...document.querySelectorAll("h1, h2")].some((h) => h.textContent === ${lit(feeds.posts[feeds.open].title)})`,
  },
  triage: {
    open: [click(label("nav.inbox")), `(document.querySelector(".inbox-pill-sort")?.click(), true)`],
    ready: `!!document.querySelector("[data-triage-card] img")`,
  },
  ...HELP_VIEWS,
};

/** What keeps the page from settling, for the error when it never does. */
const UNSETTLED = `JSON.stringify({
  fonts: document.fonts.status,
  images: [...document.images].filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 0 && !(i.complete && i.naturalWidth > 0); }).map((i) => i.src.slice(0, 80)),
  animations: document.getAnimations().filter((a) => a.playState === "running").map((a) => (a.animationName ?? a.transitionProperty ?? "?") + " " + (a.effect?.target?.className ?? "")),
})`;

/** Waits until the page settles; says what it waits for when it never does. */
async function settled(driver, what) {
  try {
    await driver.until(SETTLED, what, 15000);
  } catch (error) {
    throw new Error(`${error.message}: ${await driver.js(UNSETTLED)}`);
  }
}

/** Opens a view of the app in a theme, from a reload, and leaves it ready for the shot. */
async function show(driver, theme, view) {
  const steps = VIEW_STEPS[view];
  // In front from the start: WebKit holds a covered window's animations, and the page would never settle.
  await driver.focus();
  await driver.until(`document.visibilityState === "visible"`, "the window uncovered (another window over it?)");
  const storage = {
    language: "en",
    theme,
    view: steps.mode ?? GRID,
    // The import offer of a new library (NP-117) is closed: the shots show the library itself.
    importBanner: "done",
    // A sidebar of 800 points fits the feeds or the collections: the feeds open on the Feeds page.
    "sidebar.feeds": view === "feeds" ? "open" : "folded",
    "sidebar.collections": view === "feeds" ? "folded" : "open",
    "sidebar.tags": "folded",
    // The cache is new: its posts' ids follow feeds.json's order from 1.
    "feeds.last": JSON.stringify({ feed: null, item: feeds.open + 1 }),
  };
  await driver.js(`(Object.entries(${lit(storage)}).forEach(([k, v]) => localStorage.setItem("koonapin." + k, v)), location.reload(), true)`);
  await sleep(300);
  await driver.until(`document.readyState === "complete" && document.querySelectorAll("[data-bookmark-id]").length > 0`, "the library after a reload");
  // Opened once, the notifications are read: the bell has no badge.
  await driver.until(`(() => { const bell = document.querySelector("[data-notification-bell]"); if (!/\\d/.test(bell.textContent)) return true; bell.click(); setTimeout(() => bell.click(), 200); return false; })()`, "the bell read");
  for (const step of steps.open) {
    await driver.until(step, step.slice(0, 80));
    await sleep(250);
  }
  await driver.until(steps.ready, `the ${view} view`);
  await settled(driver, `the ${view} view settled`);
  // The window is a real one: the system's pointer resting over it would leave a card in its hover
  // state. Nothing reacts to the pointer while the shot is taken, and nothing keeps the focus.
  await driver.js(`(document.documentElement.style.setProperty("pointer-events", "none", "important"), document.activeElement instanceof HTMLElement && document.activeElement.blur(), true)`);
  await driver.focus();
  await sleep(400);
  await settled(driver, `the ${view} view settled`);
}

/**
 * The window as the system draws it: `screencapture` of its window id, 2× on a Retina screen. The
 * system may keep another app in front, and an inactive window has grey traffic lights: it is brought
 * forward and shot again until they are lit.
 */
async function capture({ app, driver }, file, page) {
  for (let attempt = 1; ; attempt++) {
    await driver.focus();
    await driver.until("document.hasFocus()", "the window in front", 5000).catch(() => {});
    await sleep(300);
    const [id] = windowOf(app.pid);
    execFileSync("screencapture", ["-x", "-o", "-l", String(id), file]);
    const shot = await readFile(file);
    if ((await litLights(page, shot)) === 3) return shot;
    if (attempt === 5) throw new Error("The test window never came to the front: its traffic lights stay grey. Click it, or leave the Mac alone while the script runs.");
    await sleep(1000);
  }
}

async function save(name, shot, encode) {
  await writeFile(path.join(png, `${name}.png`), shot);
  await writeFile(path.join(out, `${name}.webp`), await encode(shot, { width: 1920 }));
  await writeFile(path.join(out, `${name}-1280.webp`), await encode(shot, { width: 1280 }));
  console.log(`${name}.webp`);
}

/** The app's views in each theme; the first PNG of each theme is kept as the sync shot's frame. */
async function shootApp(base, encode, frames, page) {
  const app = await startApp(base);
  let failed = true;
  try {
    await fill(app, base);
    await app.driver.size(SIZE.width, SIZE.height);
    await app.driver.until(`innerWidth === ${SIZE.width} && innerHeight === ${SIZE.height}`, "the window's size");
    for (const theme of themes) {
      const list = views.filter((v) => v !== "sync");
      if (views.includes("sync") && !list.length) list.push("grid");
      for (const view of list) {
        await show(app.driver, theme, view);
        const name = `app-en-${theme}-${view}`;
        const shot = await capture(app, path.join(png, `${name}.png`), page);
        frames[theme] ??= shot;
        if (views.includes(view)) await save(name, shot, encode);
      }
    }
    failed = false;
  } finally {
    if (failed && args.keep) console.error(`--keep: the app runs, pid ${app.app.pid}, socket ${app.socket}`);
    else await app.stop();
  }
}

/** The built interface (dist/) on a port of its own: outside Tauri it is the browser preview, with its demo data. */
function serveDist() {
  const dist = path.join(root, "dist");
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon" };
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
      const file = path.join(dist, path.normalize(pathname === "/" ? "/index.html" : pathname));
      try {
        if (!file.startsWith(dist)) throw new Error("outside");
        res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" }).end(await readFile(file));
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

/** The sample library and feeds in the browser preview's own storage (src/services/demo.ts). */
async function demoStorage(base) {
  const day = (i) => saved(i, ANCHOR);
  const bookmarks = library.bookmarks.map((b, i) => ({
    id: i + 1, url: b.url, title: b.title, description: null, image_url: `${base}/${b.preview}`, favicon_url: null,
    site_name: null, domain: new URL(b.url).hostname.replace(/^www\./, ""), notes: null, is_favorite: b.favorite,
    collection_id: collectionIds[b.collection] ?? b.collection + 1, created_at: day(i), updated_at: day(i), tags: b.tags, revision: 1,
    triaged_at: b.inbox ? null : day(i), deleted_at: null, source: b.inbox ? "chrome" : "import",
    reading_at: b.reading === undefined ? null : day(b.article ? -1 : i), reading_progress: b.article ? 0 : (b.reading ?? 0), read_at: null, offline_at: null,
  }));
  const collections = library.collections.map((c, i) => ({ id: collectionIds[i] ?? i + 1, name: c, color: null, icon: null, count: null, created_at: day(20) }));
  const now = Date.now();
  const { feeds: list, posts } = feeds;
  const items = [];
  for (const [i, p] of posts.entries()) {
    const at = new Date(ANCHOR - p.hoursAgo * 3600e3).toISOString();
    items.push({
      id: i + 1, feed_uid: p.feed, url: `${list.find((f) => f.uid === p.feed).site}${i}`, title: p.title, author: p.author, excerpt: p.excerpt,
      thumbnail_url: p.picture ? await dataUrl(p.picture) : null, published_at: at, fetched_at: at, read_at: p.read ? at : null,
      bookmark_id: null, html: html(p.body), full: true,
    });
  }
  return {
    "koonapin.demo.v4": JSON.stringify({ bookmarks, collections }),
    "koonapin.demo.feeds.v1": JSON.stringify({ feeds: list.map((f) => ({ uid: f.uid, url: f.url, title: f.title, destination: "feeds" })), items, fetched_at: new Date(now).toISOString() }),
  };
}

/**
 * The sync dialog, from the browser preview: the real one needs a plan and a second computer. The
 * preview lays the window out as on a Mac (`native_frame`), in WebKit at the window's size; the
 * real window's frame of the same theme gives it the traffic lights and the rounded corners.
 */
async function shootSync(base, encode, frames, encoderPage) {
  const { server, url } = await serveDist();
  const browser = await chromium.launch();
  try {
    const storage = await demoStorage(base);
    for (const theme of themes) {
      const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 2, colorScheme: theme, locale: "en-US" });
      await page.addInitScript((entries) => {
        if (sessionStorage.getItem("shots")) return;
        sessionStorage.setItem("shots", "1");
        localStorage.clear();
        for (const [k, v] of entries) localStorage.setItem(k, v);
      }, Object.entries({
        ...storage,
        "koonapin.language": "en",
        "koonapin.theme": theme,
        "koonapin.view": GRID,
        "koonapin.importBanner": "done",
        "koonapin.sidebar.feeds": "folded",
        "koonapin.sidebar.collections": "open",
        "koonapin.sidebar.tags": "folded",
        "koonapin.notifications.seen": "[]",
        // This computer is Home iMac, the main one of three; a Supporter plan.
        "koonapin.demo.sync": "on",
        "koonapin.demo.supporter": "supporter",
        "koonapin.demo.capture": "connected",
        "koonapin.demo.desktop": JSON.stringify({ native_frame: true, linux: false, left: [], right: [], tray: true, appimage: false }),
      }));
      await page.goto(url);
      await page.locator("[data-bookmark-id] img").first().waitFor();
      // The room the app keeps for the traffic lights in a Mac window (WindowBar.tsx: Tauri only).
      await page.evaluate(() => (document.documentElement.dataset.macFrame = ""));
      // Read once, the notifications leave no badge.
      const bell = page.locator("[data-notification-bell]");
      if (/\d/.test(await bell.textContent())) {
        await bell.click();
        await page.keyboard.press("Escape");
      }
      // The Supporter row of the sidebar → the plan → its perk «Sync»: the dialog opens over the library.
      await page.locator("[data-plan-row]").click();
      await page.locator("li", { hasText: label("supporter.perk.sync") }).getByRole("button").click();
      await page.locator("[data-sync-hub]").waitFor();
      await page.waitForFunction(SETTLED);
      await page.mouse.move(SIZE.width / 2, 2);
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      const shot = await page.screenshot({ scale: "device" });
      const frame = frames[theme];
      const name = `app-en-${theme}-sync`;
      await save(name, await framed(shot, frame, encoderPage), encode);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}

/**
 * Defines `trafficLights(image)` in the encoder's page: the boxes of the coloured clusters in the top
 * left corner of a window's shot. An active window has three; an inactive one's are grey: none.
 */
async function defineLights(page) {
  await page.evaluate(() => {
    window.trafficLights = (image) => {
      const corner = Object.assign(document.createElement("canvas"), { width: 240, height: 120 }).getContext("2d");
      corner.drawImage(image, 0, 0);
      const { data } = corner.getImageData(0, 0, 240, 120);
      const lights = [];
      for (let x = 0; x < 240; x++)
        for (let y = 0; y < 120; y++) {
          const [r, g, b, alpha] = data.slice((y * 240 + x) * 4, (y * 240 + x) * 4 + 4);
          if (alpha < 200 || Math.max(r, g, b) - Math.min(r, g, b) < 80) continue;
          const light = lights.find((l) => x - l.x1 < 6);
          if (light) Object.assign(light, { x1: x, y0: Math.min(light.y0, y), y1: Math.max(light.y1, y) });
          else lights.push({ x0: x, x1: x, y0: y, y1: y });
        }
      return lights;
    };
  });
}

/** How many traffic lights of a shot are lit: 3 when the window was the active one. */
const litLights = (page, png) =>
  page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    return window.trafficLights(img).length;
  }, `data:image/png;base64,${png.toString("base64")}`);

/**
 * The preview's shot inside the real window's frame: the traffic lights' corner of the real window
 * of the same theme over it, and the real window's alpha, so its corners are rounded the same way.
 */
async function framed(shot, frame, page) {
  const b64 = await page.evaluate(
    async ([shot, frame]) => {
      const load = async (src) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        return img;
      };
      const [a, b] = await Promise.all([load(shot), load(frame)]);
      const canvas = Object.assign(document.createElement("canvas"), { width: b.width, height: b.height });
      const context = canvas.getContext("2d");
      // The real window's corners: its pixels as a mask.
      context.drawImage(b, 0, 0);
      context.globalCompositeOperation = "source-in";
      context.drawImage(a, 0, 0, b.width, b.height);
      // The traffic lights, from the real window (the preview leaves their place empty): each the
      // circle around a cluster of coloured pixels in its top left corner, over the dialog's veil too.
      const lights = window.trafficLights(b);
      context.globalCompositeOperation = "source-over";
      context.save();
      context.beginPath();
      for (const l of lights) {
        const r = Math.max(l.x1 - l.x0, l.y1 - l.y0) / 2 + 1;
        context.moveTo((l.x0 + l.x1) / 2 + r, (l.y0 + l.y1) / 2);
        context.arc((l.x0 + l.x1) / 2, (l.y0 + l.y1) / 2, r, 0, Math.PI * 2);
      }
      context.clip();
      context.drawImage(b, 0, 0);
      context.restore();
      return canvas.toDataURL("image/png").split(",")[1];
    },
    [`data:image/png;base64,${shot.toString("base64")}`, `data:image/png;base64,${frame.toString("base64")}`],
  );
  return Buffer.from(b64, "base64");
}

assertNoOtherApp();
// A display gone to sleep stops WebKit's animations, and the page would never settle: awake while this runs.
spawn("caffeinate", ["-d", "-u", "-w", String(process.pid)], { stdio: "ignore" }).unref();
await mkdir(png, { recursive: true });
const { server, base } = await servePreviews();
const webp = await webpEncoder({ smooth: true });
await defineLights(webp.page);
/** The real window in each theme: the sync shot borrows its frame. */
const frames = {};
try {
  if (views.length) await shootApp(base, webp.encode, frames, webp.page);
  if (views.includes("sync")) await shootSync(base, webp.encode, frames, webp.page);
} finally {
  await webp.close();
  server.close();
}
