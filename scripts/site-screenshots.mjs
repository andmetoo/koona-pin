// Screenshots of the real app for koona.app/pin (NP-079): the debug build with WebView2
// and SQLite in a data folder of its own, a sample library restored from JSON, previews from
// scripts/shots/previews (Unsplash licence, scripts/shots/previews/CREDITS.md), Chrome connected.
//
//   bun run site:shots   (builds the debug app with its interface embedded first, scripts/build-test-app.mjs)
//
// Writes release/shots/app-<lang>-<theme>-<view>.webp (1920 px — WebView2 shoots at 1.5× — and -1280).
// The site lives in andmetoo/koona-site: the shots go there by a commit, every few versions. The link
// previews (og-<lang>.jpg) are drawn there, not shot. Quit your own Koona Pin first:
// only one instance runs per user.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { appBinary, assertNoOtherApp, hello, hostMessage, pipeReady, testPipe } from "./lib/native-host.mjs";

const root = path.resolve(import.meta.dirname, "..");
const previews = path.join(root, "scripts", "shots", "previews");
const out = path.join(root, "release", "shots");
const VIEW = { width: 1280, height: 800 };
const PREVIEW_HOST = "previews.koona.test";

const library = JSON.parse(await readFile(path.join(root, "scripts", "shots", "library.json"), "utf8"));

/** Library copy in the app's JSON format (export.rs, restore.rs). */
function copyOf(lang, base) {
  const day = (i) => new Date(Date.UTC(2026, 9, 4 - i, 9, 30)).toISOString();
  const collections = library.collections.map((c, i) => ({
    uid: `site-collection-${i}`, name: c[lang], color: null, icon: null, created_at: day(20),
  }));
  const tags = new Map();
  const bookmarks = library.bookmarks.map((b, i) => {
    const t = b.tags[lang];
    t.forEach((name) => tags.set(name, { uid: `site-tag-${name}`, name, created_at: day(20) }));
    return {
      uid: `site-bookmark-${i}`, url: b.url, title: b.title[lang], description: null, notes: null,
      domain: new URL(b.url).hostname.replace(/^www\./, ""), image_url: `${base}/${b.preview}`, favicon_url: null, site_name: null,
      is_favorite: b.favorite, collection: `site-collection-${b.collection}`, tags: t,
      source: b.inbox ? "chrome" : "import", created_at: day(i), updated_at: day(i),
      triaged_at: b.inbox ? null : day(i), deleted_at: null,
    };
  });
  return {
    format: "koona-pin", version: 1, exported_at: day(0), app_version: "0.1.0",
    collections, tags: [...tags.values()], bookmarks,
  };
}

function servePreviews() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const file = path.join(previews, path.basename(new URL(req.url, "http://x").pathname));
        res.writeHead(200, { "content-type": "image/jpeg" }).end(await readFile(file));
      } catch {
        res.writeHead(404).end();
      }
    });
    // The app drops pictures on local addresses from a restored copy (NP-019, net_guard::public_url),
    // so the copy names a host of the reserved .test zone; only the WebView of these shots maps it
    // to this server (PREVIEW_HOST below).
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://${PREVIEW_HOST}:${server.address().port}` }));
  });
}

async function until(check, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** The window's page: the interface embedded in the binary (scripts/build-test-app.mjs). */
const appPage = (p) => p.url().startsWith("http://tauri.localhost");

async function shoot(lang, base, encoder) {
  const data = path.join(root, ".test-data", `site-shots-${lang}-${Date.now()}`);
  await mkdir(data, { recursive: true });
  const pipe = testPipe(`site-${lang}`);
  const env = {
    ...process.env,
    KOONAPIN_DATA_DIR: data,
    KOONAPIN_PIPE: pipe,
    WEBVIEW2_USER_DATA_FOLDER: path.join(data, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=9226 --lang=${lang === "ru" ? "ru" : "en-US"} --host-resolver-rules="MAP ${PREVIEW_HOST} 127.0.0.1"`,
  };
  const app = spawn(appBinary(), [], { env, windowsHide: true, stdio: "ignore" });
  let browser;
  try {
    await until(() => fetch("http://127.0.0.1:9226/json/version").then((r) => r.ok), "WebView2");
    // The DevTools port answers before the WebView is ready to take a client: retry.
    await until(async () => {
      browser = await chromium.connectOverCDP("http://127.0.0.1:9226");
      return true;
    }, "a DevTools connection");
    const context = browser.contexts()[0];
    await until(async () => context.pages().some(appPage), "the app page (built with the interface embedded? bun run site:shots does it)");
    const page = context.pages().find(appPage);
    await until(() => pipeReady(pipe), "the capture pipe");
    await page.evaluate(
      (content) => window.__TAURI_INTERNALS__.invoke("restore_library", { content, mode: "replace" }),
      JSON.stringify(copyOf(lang, base)),
    );
    // The sidebar shows Chrome as connected after a hello through the host.
    await hostMessage(hello("chrome"), { env });
    // Larger than 1×: asks for 2×; WebView2 on this machine gives 1.5× (1920 px), enough for 1200 px on the page.
    const cdp = await context.newCDPSession(page);
    const metrics = () => cdp.send("Emulation.setDeviceMetricsOverride", { ...VIEW, deviceScaleFactor: 2, mobile: false });
    for (const theme of ["light", "dark"]) {
      for (const view of ["grid", "list"]) {
        if (lang === "ru" && theme === "dark") continue;
        // The app speaks English until a language is picked (NP-085): pick the shot's.
        await page.evaluate(([t, v, l]) => {
          localStorage.setItem("koonapin.language", l);
          localStorage.setItem("koonapin.theme", t);
          localStorage.setItem("koonapin.view", v);
          // The import offer of a new library (NP-117) is closed: the shots show the library itself.
          localStorage.setItem("koonapin.importBanner", "done");
        }, [theme, view, lang]);
        await page.reload();
        await metrics();
        await page.locator("[data-bookmark-id]").first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        // Previews decode lazily; wait until the visible ones are in.
        await until(
          () => page.evaluate(() => [...document.images].filter((i) => i.getBoundingClientRect().top < innerHeight).every((i) => i.complete)),
          "previews",
        );
        // A preview that failed to load turns into a cover (NP-087): the shots must show the photos.
        if (view === "grid") {
          const photos = await page.evaluate(() => [...document.querySelectorAll("[data-bookmark-id] img")].filter((i) => i.naturalWidth > 0).length);
          if (!photos) throw new Error(`${lang} ${theme}: no preview photo loaded, the cards show covers`);
        }
        // The window is a real one: the system's pointer resting over it leaves a card in its hover state
        // (the selection box and «…» on the first card, 9 October 2026), whatever CDP moves.
        // Nothing reacts to the pointer while the shot is taken, and nothing keeps the focus. A style
        // property set from script: the app's CSP refuses a <style> of the test.
        await page.mouse.move(VIEW.width / 2, 16);
        await page.evaluate(() => {
          document.documentElement.style.setProperty("pointer-events", "none", "important");
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        });
        await page.waitForTimeout(500);
        const png = await page.screenshot({ scale: "device" });
        const name = `app-${lang}-${theme}-${view}`;
        await writeFile(path.join(out, `${name}.webp`), await encoder(png));
        await writeFile(path.join(out, `${name}-1280.webp`), await encoder(png, { width: 1280 }));
        console.log(`app-${lang}-${theme}-${view}.webp`);
      }
    }
  } finally {
    await browser?.close().catch(() => {});
    app.kill();
  }
}

assertNoOtherApp();
await mkdir(out, { recursive: true });
const { server, base } = await servePreviews();
// WebP for the site: Chromium encodes it from the PNG screenshot.
const encoderBrowser = await chromium.launch();
const encoderPage = await encoderBrowser.newPage();
/** Re-encodes a PNG: `width` scales it, `crop` = [w, h] cuts the top left corner at that scale. */
const encoder = async (png, { width, crop, type = "image/webp", quality = 0.86 } = {}) => {
  const b64 = await encoderPage.evaluate(
    async ([src, width, crop, type, quality]) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const k = width ? width / img.width : 1;
      const [w, h] = crop ?? [img.width * k, img.height * k];
      const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
      canvas.getContext("2d").drawImage(img, 0, 0, img.width * k, img.height * k);
      return canvas.toDataURL(type, quality).split(",")[1];
    },
    [`data:image/png;base64,${png.toString("base64")}`, width, crop, type, quality],
  );
  return Buffer.from(b64, "base64");
};
try {
  for (const lang of ["en", "ru"]) await shoot(lang, base, encoder);
} finally {
  await encoderBrowser.close();
  server.close();
}
