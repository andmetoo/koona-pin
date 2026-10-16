// The interface in WebKitGTK next to Chromium (NP-098): key screens of every language in both themes,
// labels cut off, the system theme and «reduce motion», scrolling 10 000 and 100 000 bookmarks. WebKitGTK
// has no CDP, so on Linux the distribution's own engine is driven over WebDriver: WebKitWebDriver starts
// its MiniBrowser on the browser preview (demo adapter, no Tauri), and Koona Pin itself (--app) for the
// system's settings and the scroll through SQLite. On Windows the same steps run in
// Playwright's Chromium — the engine of WebView2 — and give the other half of each pair.
//
//   bun scripts/webkitgtk-check.mjs                  Linux: WebKitWebDriver + MiniBrowser (DISPLAY or WAYLAND_DISPLAY)
//   bun scripts/webkitgtk-check.mjs --chromium       Windows: Playwright's Chromium
//   bun scripts/webkitgtk-check.mjs --pairs <linux> <windows>   side-by-side PNGs of two runs
// Options: --only screens,scroll,media,gnome,appscroll  --app <koonapin>  --libraries <library-10k-v1.db,…>
//          --languages en,ja  --label <name>  --frames 1500  --css <rules for the scroll>
//          --counts 10000,100000
// Results: .test-data/webkitgtk-check/<label>/ — report.json, screens/, pairs/.
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const out = path.join(root, ".test-data", "webkitgtk-check");

if (args.includes("--pairs")) {
  await pairs(args[args.indexOf("--pairs") + 1], args[args.indexOf("--pairs") + 2]);
  process.exit(0);
}

const only = new Set((option("only", "screens,media,scroll")).split(","));
const counts = option("counts", "10000,100000").split(",").map(Number);
/** At most this many frames per scroll: WebKitGTK drawing without a GPU takes 20 minutes for 10 000 to the end. */
const frames = option("frames") && Number(option("frames"));
const chromium = args.includes("--chromium");

// ---- What runs in the page: one self-contained function, the same text for both engines. ----

function lib() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const visible = (el) => !!el.offsetParent || getComputedStyle(el).position === "fixed";
  const nameOf = (el) => (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
  /** Like Playwright's getByRole("button", { name }): exact, or the name's start. */
  const button = (name, exact) =>
    [...document.querySelectorAll("button, [role=button]")].find(
      (el) => visible(el) && (exact ? nameOf(el) === name : nameOf(el).startsWith(name)),
    );
  const until = async (test, what, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!test()) {
      if (Date.now() > end) throw new Error(`timed out: ${what}`);
      await sleep(50);
    }
  };
  return {
    async ready() {
      await until(() => document.querySelector("[data-bookmark-id]"), "the first bookmark");
      await document.fonts.ready;
      await frame();
      return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent };
    },
    /** Koona Pin itself, with an empty library of its own. */
    async appReady() {
      await until(() => document.querySelector("#root > *"), "the app's interface", 30_000);
      await document.fonts.ready;
      await frame();
    },
    async click(name, exact = true) {
      await until(() => button(name, exact), `button «${name}»`, 5_000);
      button(name, exact).click();
      await frame();
      await sleep(150);
    },
    async ctrlClick(n) {
      const card = document.querySelectorAll("[data-bookmark-id]")[n];
      card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
      await frame();
    },
    async settle() {
      await frame();
      await sleep(150);
    },
    /** Hover effects and the shimmer of fresh links stand still for the screenshot, in both engines. */
    freeze() {
      if (document.getElementById("np098-freeze")) return;
      const style = document.createElement("style");
      style.id = "np098-freeze";
      style.textContent = "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}";
      document.head.append(style);
    },
    style(rules) {
      const style = document.createElement("style");
      style.textContent = rules;
      document.head.append(style);
    },
    /** Interface text that is cut off — the rule of tests/ui/languages.spec.ts. */
    cut() {
      const cut = [];
      for (const el of document.querySelectorAll("body *")) {
        if (el.closest("[data-bookmark-id], [data-user-text]") || !el.offsetParent || !el.textContent.trim()) continue;
        const style = getComputedStyle(el);
        const hides = style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none";
        if (!hides) continue;
        const range = document.createRange();
        range.selectNodeContents(el);
        const room =
          el.getBoundingClientRect().width -
          ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"].reduce((sum, side) => sum + parseFloat(style[side]), 0);
        const wide = range.getBoundingClientRect().width > room + 0.05;
        const tall = style.webkitLineClamp !== "none" && el.scrollHeight > el.clientHeight + 1;
        if (wide || tall) cut.push(el.textContent.trim().slice(0, 80));
      }
      return cut;
    },
    /** What the system told the engine, and what the app made of it. */
    media() {
      const root = document.documentElement;
      return {
        dark: matchMedia("(prefers-color-scheme: dark)").matches,
        reduce: matchMedia("(prefers-reduced-motion: reduce)").matches,
        appDark: root.dataset.theme === "dark",
        background: getComputedStyle(document.body).backgroundColor,
      };
    },
    /** scripts/scroll-bench.mjs: frame gaps while the list scrolls on, pages loading on the way. */
    async scroll(step, maxFrames, count) {
      const first = Math.min(count, 100);
      const loaded = () => Number(document.querySelector("[data-loaded]")?.getAttribute("data-loaded"));
      await until(() => loaded() === first, `${first} loaded bookmarks of the seeded library`, 60_000);
      const scroller = document.querySelector('[data-scroll="main"]');
      // The page standing still first: what a frame costs without scrolling.
      const still = [];
      for (let i = 0, t = performance.now(); i < 120; i++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        still.push(performance.now() - t);
        t = performance.now();
      }
      still.sort((a, b) => a - b);
      const gaps = [];
      let last = performance.now();
      for (let i = 0; i < maxFrames; i++) {
        const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
        if (atEnd && loaded() === count) break;
        scroller.scrollTop += step;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const now = performance.now();
        gaps.push(now - last);
        last = now;
      }
      gaps.sort((a, b) => a - b);
      const at = (p) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))];
      return {
        stillP50: still[60],
        frames: gaps.length,
        p50: at(0.5),
        p95: at(0.95),
        p99: at(0.99),
        max: gaps.at(-1),
        over33: gaps.filter((g) => g > 33.4).length,
        over50: gaps.filter((g) => g > 50).length,
        loaded: loaded(),
        inDom: document.querySelectorAll("[data-bookmark-id]").length,
      };
    },
  };
}

/**
 * The preview with a seeded library: the demo reads its library from localStorage once, when its module
 * loads, and 100 000 bookmarks do not fit the 5 MB of localStorage. This page answers the demo's key from
 * memory before the app's own script runs; the app's code is not touched.
 */
const SEEDED = "/np098-seeded.html";
/** Settings go into localStorage on an empty page of the same origin: the app, once loaded, may write its own back. */
const BLANK = "/np098-blank.html";
function seededPage(html) {
  const seed = `<script type="module">
const count = Number(new URLSearchParams(location.search).get("seed"));
if (count) {
  const words = ["Architecture", "интерфейс", "design", "notes", "Ёлка", "search", "библиотека", "release"];
  const bookmarks = Array.from({ length: count }, (_, i) => {
    const at = new Date(Date.UTC(2026, 9, 3) - i * 3_153_600).toISOString();
    return {
      id: i + 1, url: "https://site" + (i % 300) + ".example/" + i, domain: "site" + (i % 300) + ".example",
      title: words[i % 8] + " " + words[(i * 3) % 8] + " " + i, description: words[(i * 5) % 8] + " — " + words[(i * 7) % 8],
      image_url: i % 7 === 0 ? null : "/app-icon.svg?v=" + (i % 6), favicon_url: null, site_name: null, notes: null,
      is_favorite: i % 11 === 0, collection_id: null, tags: [words[i % 8].toLowerCase()],
      created_at: at, updated_at: at, revision: 1, triaged_at: at, deleted_at: null, source: "import",
    };
  });
  let stored = JSON.stringify({ bookmarks, collections: [] });
  const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
  Storage.prototype.getItem = function (key) { return key === "koonapin.demo.v4" ? stored : get.call(this, key); };
  Storage.prototype.setItem = function (key, value) { if (key === "koonapin.demo.v4") stored = value; else set.call(this, key, value); };
}
</script>`;
  return html.replace('<script type="module" src="/src/main.tsx">', `${seed}\n    <script type="module" src="/src/main.tsx">`);
}

// ---- Engines: open a page, size it, run lib's functions in it, take its picture. ----

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const libSource = `(${lib.toString()})()`;

async function playwrightEngine() {
  const { chromium: browserType } = await import("@playwright/test");
  const browser = await browserType.launch();
  let page;
  return {
    name: "chromium",
    version: browser.version(),
    async open(width, height, env = {}) {
      page = await browser.newPage({ viewport: { width, height }, locale: "en-US", ...env });
    },
    goto: (url) => page.goto(url),
    run: (name, ...params) => page.evaluate(([src, name, params]) => eval(src)[name](...params), [libSource, name, params]),
    shot: (file) => page.screenshot({ path: file }),
    key: (key) => page.keyboard.press(key),
    async storage(values) {
      await page.evaluate((values) => {
        for (const [k, v] of Object.entries(values)) v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
      }, values);
    },
    async closePage() {
      await page.close();
    },
    close: () => browser.close(),
  };
}

const MINIBROWSER = [
  "/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser",
  "/usr/libexec/webkit2gtk-4.1/MiniBrowser",
  "/usr/lib/webkit2gtk-4.1/MiniBrowser",
].find(existsSync);

/** WebKitWebDriver speaks plain W3C WebDriver over HTTP: a few requests, no client library. */
async function webdriverEngine() {
  if (!MINIBROWSER) throw new Error("MiniBrowser of webkit2gtk-4.1 is missing: install libwebkit2gtk-4.1-0 (Debian, Ubuntu)");
  // WebKitWebDriver has no --version: the package's.
  const version = [
    ["dpkg-query", ["-W", "-f", "${Version}", "libwebkit2gtk-4.1-0"]],
    ["rpm", ["-q", "--qf", "%{VERSION}", "webkit2gtk4.1"]],
    ["pacman", ["-Q", "webkit2gtk-4.1"]],
  ].reduce((found, [command, params]) => {
    if (found) return found;
    try {
      return execFileSync(command, params, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).match(/\d+\.\d+\.\d+/)?.[0];
    } catch {
      return undefined;
    }
  }, undefined) ?? "unknown";
  let driver, base, session, runs = 0, started;
  /** The running processes of a binary, by /proc (Linux, where the app is driven). */
  const instances = (binary) => {
    const pids = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        if (readlinkSync(`/proc/${entry}/exe`) === binary) pids.push(Number(entry));
      } catch {}
    }
    return pids;
  };
  /**
   * Koona Pin is one instance per session bus: one still ending when the next page opens takes that start
   * over, and WebDriver waits for a window that never comes. So a page of the app is over only when its
   * process is gone: asked to end, then killed after 15 s.
   */
  const ended = async (binary) => {
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      for (const pid of instances(binary)) {
        try {
          process.kill(pid, signal);
        } catch {}
      }
      for (let i = 0; i < 150 && instances(binary).length; i++) await new Promise((resolve) => setTimeout(resolve, 100));
      if (!instances(binary).length) return;
    }
    throw new Error(`${binary} still runs after SIGKILL`);
  };
  const call = async (method, url, body) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body && JSON.stringify(body),
      // A browser that never answers fails the step instead of the whole run.
      signal: AbortSignal.timeout(120_000),
    });
    const json = await response.json();
    if (!response.ok) throw new Error(`${method} ${url}: ${json.value?.error} ${json.value?.message}`);
    return json.value;
  };
  const s = (url) => `/session/${session}${url}`;
  const engine = {
    name: "webkitgtk",
    version,
    /**
     * One browser per page: the GTK settings (theme, animations) are the process's environment. `app` drives
     * Koona Pin itself instead of MiniBrowser, the way tauri-driver does: Tauri lets WebDriver in with
     * TAURI_WEBVIEW_AUTOMATION; a home of its own keeps its library and WebKit data out of the user's.
     */
    async open(width, height, env = {}, app) {
      const port = await freePort();
      if (app) env = { ...env, TAURI_WEBVIEW_AUTOMATION: "true", HOME: mkdtempSync(path.join(tmpdir(), "np098-")) };
      started = app && realpathSync(app);
      driver = spawn("WebKitWebDriver", [`--port=${port}`], { env: { ...process.env, ...env }, stdio: "ignore" });
      base = `http://127.0.0.1:${port}`;
      for (let i = 0; ; i++) {
        try {
          await call("GET", "/status");
          break;
        } catch (error) {
          if (i > 100) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      ({ sessionId: session } = await call("POST", "/session", {
        capabilities: { alwaysMatch: { "webkitgtk:browserOptions": app ? { binary: app, args: [] } : { binary: MINIBROWSER, args: ["--automation"] } } },
      }));
      await call("POST", s("/timeouts"), { script: 30 * 60_000, pageLoad: 120_000 });
      await call("POST", s("/window/rect"), { width, height });
      engine.size = { width, height };
    },
    async goto(url) {
      await call("POST", s("/url"), { url });
      // The window has MiniBrowser's toolbar: grow it until the page itself has the size asked for.
      const { width, height } = engine.size;
      for (let i = 0; i < 3; i++) {
        const inner = await call("POST", s("/execute/sync"), { script: "return [innerWidth, innerHeight]", args: [] });
        if (inner[0] === width && inner[1] === height) break;
        const rect = await call("GET", s("/window/rect"));
        await call("POST", s("/window/rect"), { width: rect.width + width - inner[0], height: rect.height + height - inner[1] });
      }
    },
    /**
     * Started in the page, then asked for: a scroll runs for minutes, longer than Node's fetch waits for an
     * answer (5 minutes). The questions come further apart the longer it runs, so they barely touch the frames.
     */
    async run(name, ...params) {
      const id = JSON.stringify(`${name}-${++runs}`);
      await call("POST", s("/execute/sync"), {
        script: `const results = (window.__np098 ??= {}); results[${id}] = { pending: true };
          Promise.resolve().then(() => ${libSource}[${JSON.stringify(name)}](...${JSON.stringify(params)}))
            .then((value) => (results[${id}] = { value: value === undefined ? null : value }),
                  (e) => (results[${id}] = { error: String(e) + " " + (e && e.stack) }));
          return true;`,
        args: [],
      });
      for (let wait = 20; ; wait = Math.min(wait * 2, 2_000)) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        const result = await call("POST", s("/execute/sync"), { script: `return window.__np098[${id}]`, args: [] });
        if (result.pending) continue;
        if (result.error) throw new Error(`${name}: ${result.error}`);
        return result.value;
      }
    },
    async shot(file) {
      writeFileSync(file, Buffer.from(await call("GET", s("/screenshot")), "base64"));
    },
    /** A real key press, not a script's event: the native <dialog> closes only on one. */
    async key(key) {
      const value = { Escape: "\uE00C" }[key] ?? key;
      await call("POST", s("/actions"), {
        actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value }, { type: "keyUp", value }] }],
      });
    },
    async storage(values) {
      await call("POST", s("/execute/sync"), {
        script: "for (const [k, v] of Object.entries(arguments[0])) v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v)",
        args: [values],
      });
    },
    async closePage() {
      await call("DELETE", `/session/${session}`).catch(() => {});
      driver.kill();
      if (started) await ended(started);
    },
    close: async () => {},
  };
  return engine;
}

// ---- The run ----

const { createServer } = await import("vite");
const server = await createServer({
  root,
  server: { port: 0, host: "127.0.0.1", strictPort: false },
  logLevel: "error",
  plugins: [
    {
      name: "np098-seeded",
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url.startsWith(BLANK)) return res.end("<!doctype html><title>blank</title>");
          if (!req.url.startsWith(SEEDED)) return next();
          const html = await vite.transformIndexHtml(req.url, readFileSync(path.join(root, "index.html"), "utf8"));
          res.setHeader("content-type", "text/html");
          res.end(seededPage(html));
        });
      },
    },
  ],
});
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, "");
const engine = chromium ? await playwrightEngine() : await webdriverEngine();
const session = process.env.WAYLAND_DISPLAY && process.env.GDK_BACKEND !== "x11" ? "wayland" : process.env.DISPLAY ? "x11" : process.platform;
const os = existsSync("/etc/os-release")
  ? Object.fromEntries(readFileSync("/etc/os-release", "utf8").split("\n").filter(Boolean).map((l) => l.split("=")).map(([k, v]) => [k, v?.replace(/"/g, "")]))
  : { PRETTY_NAME: `Windows ${process.platform}` };
const label = option("label", chromium ? `chromium-${process.platform}` : `webkitgtk-${engine.version}-${os.ID}-${os.VERSION_ID}-${session}`);
const dir = path.join(out, label);
mkdirSync(path.join(dir, "screens"), { recursive: true });
const report = { engine: engine.name, version: engine.version, system: os.PRETTY_NAME, session, date: new Date().toISOString() };
console.log(`${engine.name} ${engine.version}, ${os.PRETTY_NAME}, ${session} → ${path.relative(root, dir)}`);
/** Rules added for the scroll, to find what costs a frame: --css "img{display:none}". */
const css = option("css");
const failures = [];

const locales = path.join(root, "src", "locales");
const codes = option("languages", readdirSync(locales).map((file) => file.replace(/\.json$/, "")).join(",")).split(",");
const catalog = (code) => JSON.parse(readFileSync(path.join(locales, `${code}.json`), "utf8"));
const text = (c, key) => key.split(".").reduce((node, k) => node[k], c);
/** Pictures for the pairs: Latin, Cyrillic, the longest (German), Serbian, and the three CJK scripts. */
const pictured = ["en", "ru", "de", "sr", "ja", "ko", "zh-CN"];
/** GNOME's window bar in both engines, so a pair differs only by the engine. */
const desktop = JSON.stringify({ linux: true, left: [], right: ["close"], tray: true });

async function screens(code, width, height, theme) {
  const t = (key) => text(catalog(code), key);
  await engine.open(width, height);
  try {
    await engine.goto(`${url}${BLANK}`);
    await engine.storage({ "koonapin.demo.v4": null, "koonapin.language": code, "koonapin.theme": theme, "koonapin.demo.desktop": desktop });
    await engine.goto(`${url}/`);
    const page = await engine.run("ready");
    const { appDark, background } = await engine.run("media");
    if (appDark !== (theme === "dark")) throw new Error(`the ${theme} theme did not apply: data-theme ${appDark ? "dark" : "light"}, background ${background}`);
    await engine.run("freeze");
    const picture = pictured.includes(code) && (width === 1600 || code === "en");
    const found = {};
    const shot = async (name) => {
      found[name] = await engine.run("cut");
      if (picture) await engine.shot(path.join(dir, "screens", `${code}-${width}x${height}-${theme}-${name}.png`));
    };
    await shot("grid");
    await engine.run("click", t("toolbar.list"));
    await shot("list");
    await engine.run("ctrlClick", 0);
    await engine.run("ctrlClick", 1);
    await shot("selection");
    await engine.key("Escape");
    await engine.run("settle");
    await engine.run("click", t("toolbar.add"));
    await shot("add-dialog");
    await engine.key("Escape");
    await engine.run("settle");
    await engine.run("click", t("nav.inbox"), false);
    await engine.run("click", t("inbox.sort"));
    await shot("triage");
    await engine.key("Escape");
    await engine.run("settle");
    await engine.run("click", t("nav.settings"));
    await shot("settings");
    return { page, cut: Object.fromEntries(Object.entries(found).filter(([, v]) => v.length)) };
  } finally {
    await engine.closePage();
  }
}

if (only.has("screens")) {
  report.screens = {};
  for (const code of codes)
    for (const [width, height] of [
      [800, 550],
      [1600, 800],
    ])
      for (const theme of code === "en" || width === 1600 ? ["light", "dark"] : ["light"]) {
        const key = `${code} ${width}×${height} ${theme}`;
        try {
          const result = await screens(code, width, height, theme);
          report.screens[key] = result.cut;
          report.page ??= result.page;
          const cut = Object.entries(result.cut).map(([screen, labels]) => `${screen}: ${labels.join(" | ")}`);
          if (cut.length) failures.push(`${key} cut: ${cut.join("; ")}`);
          console.log(`${cut.length ? "CUT " : "ok  "} ${key}${cut.length ? ` — ${cut.join("; ")}` : ""}`);
        } catch (error) {
          failures.push(`${key}: ${error.message}`);
          console.log(`FAIL ${key}: ${error.message}`);
        }
      }
}

/**
 * The system's theme and «reduce motion» as GTK hands them to WebKitGTK, in Koona Pin itself (--app):
 * MiniBrowser sets gtk-application-prefer-dark-theme on its own and would hide what the app sees. KDE and a
 * desktop without a settings daemon give GTK settings.ini; GNOME gives dconf, which GTK 3 reads itself under
 * Wayland and follows while the program runs.
 */
const app = option("app");
async function media(name, env, steps) {
  report.media[name] = {};
  await engine.open(1200, 800, env, app);
  try {
    await engine.run("appReady");
    for (const [step, change, expected] of steps) {
      change?.();
      // A change while the app runs reaches the page through GTK, the settings portal and the app's own
      // theme: asked again for up to 10 s, as a busy runner may take longer than a desktop.
      let seen, wrong;
      for (let waited = 0; ; waited += 500) {
        if (change) await new Promise((resolve) => setTimeout(resolve, waited ? 500 : 1_000));
        seen = await engine.run("media");
        wrong = Object.entries(expected).filter(([k, v]) => seen[k] !== v);
        if (!change || !wrong.length || waited >= 9_000) break;
      }
      report.media[name][step] = { ...seen, expected, ok: wrong.length === 0 };
      console.log(`${wrong.length ? "FAIL" : "ok  "} ${name}, ${step}: ${JSON.stringify(seen)}`);
      if (wrong.length) failures.push(`${name}, ${step}: ${wrong.map(([k, v]) => `${k} ${seen[k]}, expected ${v}`).join(", ")}`);
    }
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`FAIL ${name}: ${error.message}`);
  } finally {
    await engine.closePage();
  }
}

function gtkSettings(lines) {
  const home = path.join(dir, "gtk", lines.join("_").replace(/\W+/g, "-") || "default");
  mkdirSync(path.join(home, "gtk-3.0"), { recursive: true });
  writeFileSync(path.join(home, "gtk-3.0", "settings.ini"), ["[Settings]", ...lines, ""].join("\n"));
  return { XDG_CONFIG_HOME: home };
}

const light = { dark: false, appDark: false };
const dark = { dark: true, appDark: true };
if ((only.has("media") || only.has("gnome")) && (chromium || !app)) console.log("media, gnome: Linux only, with --app <koonapin binary>");
else {
  report.media = {};
  if (only.has("media")) {
    await media("settings.ini: nothing", gtkSettings([]), [["start", null, { ...light, reduce: false }]]);
    await media("settings.ini: gtk-application-prefer-dark-theme", gtkSettings(["gtk-application-prefer-dark-theme=true"]), [["start", null, dark]]);
    await media("settings.ini: gtk-theme-name Adwaita-dark", gtkSettings(["gtk-theme-name=Adwaita-dark"]), [["start", null, dark]]);
    await media("settings.ini: gtk-enable-animations false", gtkSettings(["gtk-enable-animations=false"]), [["start", null, { reduce: true }]]);
  }
  if (only.has("gnome")) {
    const gsettings = (...a) => execFileSync("gsettings", [a[0], "org.gnome.desktop.interface", ...a.slice(1)], { encoding: "utf8" });
    const keys = ["color-scheme", "gtk-theme", "enable-animations"];
    keys.forEach((key) => gsettings("reset", key));
    // dconf reads its database from the user's config folder: the app's home of its own must not move it.
    const config = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config") };
    // GNOME 42+ dark style sets color-scheme only; Ubuntu's also switches gtk-theme to a -dark one.
    await media("gsettings, changed while running", config, [
      ["defaults", null, { ...light, reduce: false }],
      ["color-scheme prefer-dark (GNOME dark style)", () => gsettings("set", "color-scheme", "prefer-dark"), dark],
      ["gtk-theme Adwaita-dark as well (Ubuntu dark style)", () => gsettings("set", "gtk-theme", "Adwaita-dark"), dark],
      ["back to light", () => keys.slice(0, 2).forEach((key) => gsettings("reset", key)), light],
      ["enable-animations false (reduce animation)", () => gsettings("set", "enable-animations", "false"), { reduce: true }],
    ]);
    keys.forEach((key) => gsettings("reset", key));
  }
}

if (only.has("scroll")) {
  report.scroll = [];
  const STEP = 120;
  for (const count of counts)
    for (const view of ["grid", "list"]) {
      // 100 000 to the end would be over an hour of frames: the first 4 000 frames, pages loading on the way.
      const maxFrames = frames ?? (count > 10_000 ? 4_000 : 12_000);
      await engine.open(1440, 900);
      try {
        await engine.goto(`${url}${BLANK}`);
        await engine.storage({ "koonapin.view": view, "koonapin.theme": "light", "koonapin.demo.desktop": desktop });
        await engine.goto(`${url}${SEEDED}?seed=${count}`);
        await engine.run("ready");
        if (css) await engine.run("style", css);
        const r = await engine.run("scroll", STEP, maxFrames, count);
        report.scroll.push({ count, view, step: STEP, ...r });
        const ms = (v) => `${v.toFixed(1)} ms`;
        console.log(
          `scroll ${count} ${view.padEnd(4)} still ${ms(r.stillP50)}  frames ${r.frames}  p50 ${ms(r.p50)}  p95 ${ms(r.p95)}  p99 ${ms(r.p99)}  max ${ms(r.max)}  ` +
            `over 33 / 50 ms: ${r.over33} / ${r.over50}  loaded ${r.loaded}  in DOM ${r.inDom}`,
        );
        if (!frames && count <= 10_000 && r.loaded !== count) failures.push(`scroll ${count} ${view}: ended with ${r.loaded} loaded`);
      } catch (error) {
        failures.push(`scroll ${count} ${view}: ${error.message}`);
        console.log(`FAIL scroll ${count} ${view}: ${error.message}`);
      } finally {
        await engine.closePage();
      }
    }
}

/**
 * Scrolling Koona Pin itself: a test library (src-tauri/src/test_libraries.rs) through IPC and SQLite, as the
 * native @perf test does on Windows. The library is a copy; the app migrates it to the current schema.
 */
const libraries = option("libraries");
if (only.has("appscroll") && app && libraries) {
  report.appScroll = [];
  for (const file of libraries.split(",")) {
    const count = Number(path.basename(file).match(/(\d+)k/)[1]) * 1000;
    for (const view of ["grid", "list"]) {
      const data = mkdtempSync(path.join(tmpdir(), "np098-data-"));
      copyFileSync(file, path.join(data, "koonapin.db"));
      await engine.open(1440, 900, { KOONAPIN_DATA_DIR: data }, app);
      try {
        await engine.run("ready");
        if (view === "list") await engine.run("click", text(catalog("en"), "toolbar.list"));
        const r = await engine.run("scroll", 120, frames ?? (count > 10_000 ? 4_000 : 12_000), count);
        report.appScroll.push({ library: path.basename(file), count, view, step: 120, ...r });
        const ms = (v) => `${v.toFixed(1)} ms`;
        console.log(
          `app scroll ${count} ${view.padEnd(4)} still ${ms(r.stillP50)}  frames ${r.frames}  p50 ${ms(r.p50)}  p95 ${ms(r.p95)}  p99 ${ms(r.p99)}  max ${ms(r.max)}  ` +
            `over 33 / 50 ms: ${r.over33} / ${r.over50}  loaded ${r.loaded}  in DOM ${r.inDom}`,
        );
      } catch (error) {
        failures.push(`app scroll ${count} ${view}: ${error.message}`);
        console.log(`FAIL app scroll ${count} ${view}: ${error.message}`);
      } finally {
        await engine.closePage();
      }
    }
  }
}

report.failures = failures;
writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
await engine.close();
await server.close();
console.log(failures.length ? `\n${failures.length} problem(s):\n${failures.join("\n")}` : "\nno problems");
process.exit(failures.length ? 1 : 0);

/** Each screen of two runs side by side, for the eye: left — the first run, right — the second. */
async function pairs(left, right) {
  const { chromium: browserType } = await import("@playwright/test");
  const [a, b] = [left, right].map((d) => path.resolve(d, "screens"));
  const target = path.join(path.resolve(left), "pairs");
  mkdirSync(target, { recursive: true });
  const browser = await browserType.launch();
  const page = await browser.newPage();
  const names = readdirSync(a).filter((f) => f.endsWith(".png") && existsSync(path.join(b, f)));
  for (const name of names) {
    const png = [a, b].map((d) => readFileSync(path.join(d, name)));
    // The PNG header: width and height at bytes 16 and 20.
    const size = png.map((p) => [p.readUInt32BE(16), p.readUInt32BE(20)]);
    await page.setViewportSize({ width: size[0][0] + size[1][0] + 8, height: Math.max(size[0][1], size[1][1]) + 40 });
    const src = (d) => `data:image/png;base64,${png[d === a ? 0 : 1].toString("base64")}`;
    await page.setContent(
      `<body style="margin:0;display:flex;gap:8px;background:#888;font:12px sans-serif">
        <figure style="margin:0"><figcaption>${path.basename(path.resolve(left))}</figcaption><img src="${src(a)}"></figure>
        <figure style="margin:0"><figcaption>${path.basename(path.resolve(right))}</figcaption><img src="${src(b)}"></figure></body>`,
    );
    await page.waitForFunction(() => [...document.images].every((i) => i.complete));
    await page.locator("body").screenshot({ path: path.join(target, name) });
  }
  await browser.close();
  console.log(`${names.length} pairs → ${target}`);
}
