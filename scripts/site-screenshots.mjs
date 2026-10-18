// Screenshots of the real app for koona.app/pin (NP-079): the debug build with WebView2
// and SQLite in a data folder of its own, a sample library restored from JSON, previews from
// scripts/shots/previews (Unsplash licence, scripts/shots/previews/CREDITS.md), Chrome connected.
//
//   bun run site:shots   (builds the debug app with its interface embedded first, scripts/build-test-app.mjs)
//
// Writes release/shots/app-en-<theme>-<view>.webp (1920 px — WebView2 shoots at 1.5× — and -1280),
// in English: the site's shots are English only.
// The site lives in andmetoo/koona-site: the shots go there by a commit, every few versions. The link
// previews (og-*.jpg) are drawn there, not shot. Quit your own Koona Pin first:
// only one instance runs per user.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { appBinary, assertNoOtherApp, hello, hostMessage, pipeReady, testPipe } from "./lib/native-host.mjs";
import { copyOf, servePreviews, shotsOut as out, until, webpEncoder } from "./lib/shots.mjs";

const root = path.resolve(import.meta.dirname, "..");
const VIEW = { width: 1280, height: 800 };
// The app drops pictures on local addresses from a restored copy (NP-019, net_guard::public_url),
// so the copy names a host of the reserved .test zone; only the WebView of these shots maps it
// to the previews' server (--host-resolver-rules below).
const PREVIEW_HOST = "previews.koona.test";

/** The window's page: the interface embedded in the binary (scripts/build-test-app.mjs). */
const appPage = (p) => new URL(p.url()).origin === "http://tauri.localhost";

async function shoot(base, encoder) {
  const data = path.join(root, ".test-data", `site-shots-${Date.now()}`);
  await mkdir(data, { recursive: true });
  const pipe = testPipe("site");
  const env = {
    ...process.env,
    KOONAPIN_DATA_DIR: data,
    KOONAPIN_PIPE: pipe,
    WEBVIEW2_USER_DATA_FOLDER: path.join(data, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=9226 --lang=en-US --host-resolver-rules="MAP ${PREVIEW_HOST} 127.0.0.1"`,
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
      JSON.stringify(copyOf(base)),
    );
    // The sidebar shows Chrome as connected after a hello through the host.
    await hostMessage(hello("chrome"), { env });
    // Larger than 1×: asks for 2×; WebView2 on this machine gives 1.5× (1920 px), enough for 1200 px on the page.
    const cdp = await context.newCDPSession(page);
    const metrics = () => cdp.send("Emulation.setDeviceMetricsOverride", { ...VIEW, deviceScaleFactor: 2, mobile: false });
    for (const theme of ["light", "dark"]) {
      for (const view of ["grid", "list"]) {
        // The app speaks English until a language is picked (NP-085): English, picked.
        await page.evaluate(([t, v, l]) => {
          localStorage.setItem("koonapin.language", l);
          localStorage.setItem("koonapin.theme", t);
          localStorage.setItem("koonapin.view", v);
          // The import offer of a new library (NP-117) is closed: the shots show the library itself.
          localStorage.setItem("koonapin.importBanner", "done");
        }, [theme, view, "en"]);
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
          if (!photos) throw new Error(`${theme}: no preview photo loaded, the cards show covers`);
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
        const name = `app-en-${theme}-${view}`;
        await writeFile(path.join(out, `${name}.webp`), await encoder(png));
        await writeFile(path.join(out, `${name}-1280.webp`), await encoder(png, { width: 1280 }));
        console.log(`${name}.webp`);
      }
    }
  } finally {
    await browser?.close().catch(() => {});
    app.kill();
  }
}

assertNoOtherApp();
await mkdir(out, { recursive: true });
const { server, base } = await servePreviews(PREVIEW_HOST);
// WebP for the site: Chromium encodes it from the PNG screenshot.
const webp = await webpEncoder();
const encoder = webp.encode;
try {
  await shoot(base, encoder);
} finally {
  await webp.close();
  server.close();
}
