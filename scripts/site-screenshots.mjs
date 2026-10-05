// Screenshots of the real app for pin.netami.app (NP-079): the debug build with WebView2
// and SQLite in a data folder of its own, a sample library restored from JSON, previews from
// site/shots/previews (Unsplash licence, site/shots/previews/CREDITS.md), Chrome connected.
//
//   cargo build --manifest-path src-tauri/Cargo.toml   (once, the debug app and its host)
//   node scripts/site-screenshots.mjs
//
// Writes site/src/shots/app-<lang>-<theme>-<view>.webp (1920 px — WebView2 shoots at 1.5× — and -1280)
// and og-<lang>.jpg. Quit your own Netami Pin first:
// only one instance runs per user.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { appBinary, assertNoOtherApp, hello, hostMessage, pipeReady, testPipe } from "./lib/native-host.mjs";

const root = path.resolve(import.meta.dirname, "..");
const previews = path.join(root, "site", "shots", "previews");
const out = path.join(root, "site", "src", "shots");
const VIEW = { width: 1280, height: 800 };

const library = JSON.parse(await readFile(path.join(root, "site", "shots", "library.json"), "utf8"));

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
      domain: new URL(b.url).hostname.replace(/^www\./, ""), image_url: `${base}/${b.preview}`, favicon_url: null,
      is_favorite: b.favorite, collection: `site-collection-${b.collection}`, tags: t,
      source: b.inbox ? "chrome" : "import", created_at: day(i), updated_at: day(i),
      triaged_at: b.inbox ? null : day(i), deleted_at: null,
    };
  });
  return {
    format: "netami-pin", version: 1, exported_at: day(0), app_version: "0.1.0",
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
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
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

const devServerUp = () => fetch("http://127.0.0.1:1420").then((r) => r.ok);

async function shoot(lang, base, encoder) {
  const data = path.join(root, ".test-data", `site-shots-${lang}-${Date.now()}`);
  await mkdir(data, { recursive: true });
  const pipe = testPipe(`site-${lang}`);
  const env = {
    ...process.env,
    NETAMIPIN_DATA_DIR: data,
    NETAMIPIN_PIPE: pipe,
    WEBVIEW2_USER_DATA_FOLDER: path.join(data, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=9226 --lang=${lang === "ru" ? "ru" : "en-US"}`,
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
    await until(async () => context.pages().some((p) => p.url().includes("1420")), "the app page");
    const page = context.pages().find((p) => p.url().includes("1420"));
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
        await page.evaluate(([t, v]) => {
          localStorage.setItem("netamipin.theme", t);
          localStorage.setItem("netamipin.view", v);
        }, [theme, view]);
        await page.reload();
        await metrics();
        await page.locator("[data-bookmark-id]").first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        // Previews decode lazily; wait until the visible ones are in.
        await until(
          () => page.evaluate(() => [...document.images].filter((i) => i.getBoundingClientRect().top < innerHeight).every((i) => i.complete)),
          "previews",
        );
        await page.waitForTimeout(500);
        const png = await page.screenshot({ scale: "device" });
        const name = `app-${lang}-${theme}-${view}`;
        await writeFile(path.join(out, `${name}.webp`), await encoder(png));
        await writeFile(path.join(out, `${name}-1280.webp`), await encoder(png, { width: 1280 }));
        // Link previews (og:image): the left of the light grid, 1200×630.
        if (theme === "light" && view === "grid")
          await writeFile(path.join(out, `og-${lang}.jpg`), await encoder(png, { width: 1600, crop: [1200, 630], type: "image/jpeg", quality: 0.85 }));
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
const vite = (await devServerUp().catch(() => false))
  ? null
  : spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"], { cwd: root, stdio: "ignore" });
await until(devServerUp, "the dev server");
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
  vite?.kill();
}
