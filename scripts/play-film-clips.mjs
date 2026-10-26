// Records the clips of the Google Play preview video (src-tauri/store/play/video/scenario.md) from the
// app's own interface: the built page (dist/) in its browser preview, as a phone (tests/phone/fixtures.ts
// injects the same), with the sample library and feeds of scripts/shots in the preview's demo storage.
// The screens are the app's code and its demo data; no device, emulator or network is involved, so a
// clip has no loading waits and no frames missing in screen transitions.
//
//   bun run play:clips                          build dist/ from this checkout, record every clip
//   bun run play:clips -- --only browse,feeds   record some
//   bun run play:clips -- --probe               one screenshot of the library, to look at
//   bun run play:clips -- --no-build            use dist/ as it is (just built by hand)
//
// Each clip is the page's screencast (Chrome DevTools, 1080 × 2160 JPEG frames as the page paints them),
// timed by the frames' own timestamps and encoded at 60 fps into
// src-tauri/store/play/video/film/public/clips/<name>.mp4 (kept out of Git).
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { root } from "./lib/paths.mjs";
import { demoStorage, servePreviews, serveDist } from "./lib/shots.mjs";

const { values: args } = parseArgs({
  strict: false,
  options: { only: { type: "string" }, probe: { type: "boolean" }, "no-build": { type: "boolean" } },
});
const film = path.join(root, "src-tauri", "store", "play", "video", "film");
const clips = path.join(film, "public", "clips");
const work = path.join(root, ".test-data", "play-film");
const shell = process.platform === "win32";

// A phone of 1080 × 2160 pixels: Play's ratio for the screenshots, the film's phone screen.
const VIEWPORT = { width: 393, height: 786 };
const SCALE = 1080 / VIEWPORT.width;
// Android's status bar and gesture bar: the film's phone frame draws them over these insets.
const INSETS = { top: 34, right: 0, bottom: 18, left: 0 };
const ANCHOR = Date.now();
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

const readJson = async (name) => JSON.parse(await readFile(path.join(root, "scripts", "shots", name), "utf8"));
const [siteFeeds, phoneFeeds] = await Promise.all([readJson("feeds.json"), readJson("play-feeds.json")]);
// The phone's own feeds first: a news site, a travel site, a blog (play-feeds.json).
const feeds = { feeds: [...phoneFeeds.feeds, ...siteFeeds.feeds], posts: [...phoneFeeds.posts, ...siteFeeds.posts] };

/** The demo storage of the film: the sample, and a Supporter with sync on (three devices, as the desktop's sync shot). */
const storage = async (base) => ({
  ...(await demoStorage(base, { anchor: ANCHOR, feeds, fetchedAt: ANCHOR - 2 * 60e3 })),
  "koonapin.language": "en",
  "koonapin.theme": "light",
  "koonapin.importBanner": "done",
  "koonapin.notifications.seen": "[]",
  "koonapin.demo.sync": "on",
  "koonapin.demo.supporter": "supporter",
});

/** A fresh phone page with the sample: the platform, the Back bridge and the insets, as tests/phone/fixtures.ts. */
async function phonePage(browser, url, entries) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE, hasTouch: true, locale: "en-US", colorScheme: "light" });
  const page = await context.newPage();
  await page.addInitScript(
    ({ entries, insets, version }) => {
      const w = window;
      // The preview names itself where the app names its version («Koona Pin demo · …» in You & sync):
      // the film shows what the phone shows, «Koona Pin <version> · …». Only new or changed text is looked at.
      const own = (node) => {
        if (node.nodeType === Node.TEXT_NODE && node.nodeValue.includes("Koona Pin demo"))
          node.nodeValue = node.nodeValue.replace("Koona Pin demo", `Koona Pin ${version}`);
        else if (node.nodeType === Node.ELEMENT_NODE && node.textContent.includes("Koona Pin demo"))
          for (const child of node.childNodes) own(child);
      };
      new MutationObserver((records) => {
        for (const r of records) {
          if (r.type === "characterData") own(r.target);
          for (const node of r.addedNodes) own(node);
        }
      }).observe(document, { subtree: true, childList: true, characterData: true });
      w.__KOONA__ = {
        platform: "android",
        capabilities: {
          file_manager: false, tray: false, autostart: false, updates: "store", browser_capture: false, mcp: false,
          quit: false, folder_picker: false, share_intake: true, haptics: true, icon_service: false, purchase: "play",
        },
      };
      w.__KOONA_MOBILE__ = { back: () => false, claim: () => true, system: () => ({ powerSave: false, lowRam: false, textScale: 1 }), bar: () => null };
      document.addEventListener("DOMContentLoaded", () => {
        for (const [side, px] of Object.entries(insets)) document.documentElement.style.setProperty(`--kp-inset-${side}`, `${px}px`);
      });
      if (sessionStorage.getItem("film")) return;
      sessionStorage.setItem("film", "1");
      localStorage.clear();
      for (const [k, v] of entries) localStorage.setItem(k, v);
    },
    { entries: Object.entries(entries), insets: INSETS, version },
  );
  await page.goto(url);
  await page.locator("[data-phone]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.locator("img").first().waitFor().catch(() => {});
  await page.waitForTimeout(600);
  return { page, context };
}

/**
 * Records what `act` does on the page as public/clips/<name>.mp4: the screencast's frames, each held
 * until the next one, encoded at 60 fps.
 */
async function record(name, page, act) {
  const frames = path.join(work, name);
  await rm(frames, { recursive: true, force: true });
  await mkdir(frames, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const shots = [];
  const writes = [];
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    // Acknowledged at once, so Chrome sends the next frame without waiting for the disk.
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    const file = path.join(frames, `${String(shots.length).padStart(5, "0")}.jpg`);
    shots.push({ file, at: metadata.timestamp });
    writes.push(writeFile(file, Buffer.from(data, "base64")));
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1080, maxHeight: 2160, everyNthFrame: 1 });
  await page.waitForTimeout(500);
  await act(page);
  await page.waitForTimeout(800);
  // The frames carry the time they were painted (seconds since the epoch): the last one lasts until now.
  const end = Date.now() / 1000;
  await cdp.send("Page.stopScreencast");
  await Promise.all(writes);
  if (!shots.length) throw new Error(`${name}: the page painted nothing while recording (did its actions do anything?)`);
  // Each frame lasts until the next; the last one until the recording stopped.
  const list = shots
    .map((s, i) => `file '${s.file.replaceAll("\\", "/")}'\nduration ${Math.max(0.001, (shots[i + 1]?.at ?? Math.max(end, s.at + 0.5)) - s.at).toFixed(4)}`)
    .join("\n");
  const concat = path.join(frames, "frames.txt");
  await writeFile(concat, `${list}\nfile '${shots.at(-1).file.replaceAll("\\", "/")}'\n`);
  await mkdir(clips, { recursive: true });
  const out = path.join(clips, `${name}.mp4`);
  execFileSync("bunx", ["remotion", "ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", concat, "-r", "60", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", out], {
    cwd: film,
    stdio: "inherit",
    shell,
  });
  const length = (Math.max(end, shots.at(-1).at + 0.5) - shots[0].at).toFixed(2);
  console.log(`${name}: ${shots.length} frames, ${length} s → ${path.relative(root, out)}`);
  return Number(length);
}

const pause = (page, ms) => page.waitForTimeout(ms);

/**
 * Scrolls the list under the middle of the screen by `dy` pixels, smoothly, as a flick would, and
 * waits for it to settle (a wheel jumps, and goes to whatever is under the pointer).
 */
async function scroll(page, dy, wait = 900) {
  await page.evaluate((dy) => {
    let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    while (el && !(el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
    (el ?? document.scrollingElement).scrollBy({ top: dy, behavior: "smooth" });
  }, dy);
  await pause(page, wait);
}
/** A tap on the element: the pointer goes there first, as a finger would, then a click. */
async function tap(page, locator, wait = 700) {
  await locator.first().click();
  await pause(page, wait);
}

/** The clips: what each does, from a fresh page on the library. */
const CLIPS = {
  // New link: the address typed, saved; the film cuts the wait out.
  async save(page) {
    await tap(page, page.getByRole("button", { name: "New link" }), 600);
    await page.keyboard.type("quietpages.blog/a-reading-journal", { delay: 45 });
    await pause(page, 400);
    await page.keyboard.press("Enter");
    await pause(page, 1500);
    await tap(page, page.getByRole("button", { name: /^Save/ }), 1600);
  },
  // The library as a list, then as cards; then Reading, and an article read.
  async browse(page) {
    await pause(page, 900);
    await scroll(page, 260, 900);
    await tap(page, page.getByRole("radio", { name: "Grid" }), 1200);
    await scroll(page, 300, 1000);
    await tap(page, page.getByRole("button", { name: "Reading" }).last(), 1200);
    await tap(page, page.getByText("The case for a short reading list"), 1600);
    await scroll(page, 420, 1300);
    await scroll(page, 420, 1200);
  },
  // Feeds, loaded: the news site, the travel site and the blog first; one feed, then all again.
  async feeds(page) {
    await tap(page, page.getByRole("button", { name: "Feeds" }).last(), 1300);
    await scroll(page, 360, 1000);
    await scroll(page, -360, 700);
    await tap(page, page.getByRole("button", { name: /^Slow Roads/ }), 1300);
    await tap(page, page.getByRole("button", { name: /^All feeds/ }), 1200);
  },
  // You & sync: synced with the computers, and once more by hand.
  async sync(page) {
    await tap(page, page.getByRole("button", { name: "You & sync" }), 1400);
    // Sync now: syncing, then synced again.
    await tap(page, page.getByRole("button", { name: "Sync now" }), 2200);
  },
};

// The clips show this checkout's interface: dist/ is built from it first (a dist/ left by another branch
// or an older commit would put another interface on film).
if (!args["no-build"]) execFileSync("bun", ["run", "build"], { cwd: root, stdio: "inherit", shell });
const { server: dist, url } = await serveDist();
const { server: pictures, base } = await servePreviews();
// The screencast sends the window's own pixels: a forced scale makes them the phone's 1080 × 2160.
const browser = await chromium.launch({ args: [`--force-device-scale-factor=${SCALE}`] });
try {
  const entries = await storage(base);
  if (args.probe) {
    const { page } = await phonePage(browser, url, entries);
    await mkdir(work, { recursive: true });
    const file = path.join(work, "probe.png");
    await page.screenshot({ path: file });
    console.log(file);
  } else {
    const only = args.only ? args.only.split(",") : Object.keys(CLIPS);
    for (const name of only) {
      const { page, context } = await phonePage(browser, url, entries);
      await record(name, page, CLIPS[name]);
      await context.close();
    }
  }
} finally {
  await browser.close();
  dist.close();
  pictures.close();
}
