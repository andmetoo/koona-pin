// What the screenshots of the real app share (scripts/site-screenshots.mjs on Windows,
// scripts/site-screenshots-macos.mjs on a Mac): the sample library of scripts/shots/library.json in
// the app's JSON format, the server of its preview photos (scripts/shots/previews, Unsplash licence,
// CREDITS.md there), a condition to wait for, and the PNG → WebP encoder of the site's images.
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { root } from "./paths.mjs";

export const shotsDir = path.join(root, "scripts", "shots");
export const previews = path.join(shotsDir, "previews");
/** Where the shots go: release/shots/ (scripts/lib/paths.mjs). */
export const shotsOut = path.join(root, "release", "shots");

export const library = JSON.parse(await readFile(path.join(shotsDir, "library.json"), "utf8"));

/** The day a bookmark was saved: the first is the newest, 4 October 2026 (or `from`), the next a day older. */
export const saved = (i, from = Date.UTC(2026, 9, 4, 9, 30)) => new Date(from - i * 86400e3).toISOString();

/**
 * Library copy in the app's JSON format (export.rs, restore.rs). `base` is where the previews are
 * served; a bookmark with `reading` is in Reading with that much read. `from` is when the newest was saved.
 */
export function copyOf(base, from) {
  const day = (i) => saved(i, from);
  const collections = library.collections.map((c, i) => ({
    uid: `site-collection-${i}`, name: c, color: null, icon: null, created_at: day(20),
  }));
  const tags = new Map();
  const bookmarks = library.bookmarks.map((b, i) => {
    const t = b.tags;
    t.forEach((name) => tags.set(name, { uid: `site-tag-${name}`, name, created_at: day(20) }));
    return {
      uid: `site-bookmark-${i}`, url: b.url, title: b.title, description: null, notes: null,
      domain: new URL(b.url).hostname.replace(/^www\./, ""), image_url: `${base}/${b.preview}`, favicon_url: null, site_name: null,
      is_favorite: b.favorite, collection: `site-collection-${b.collection}`, tags: t,
      source: b.inbox ? "chrome" : "import", created_at: day(i), updated_at: day(i),
      triaged_at: b.inbox ? null : day(i), deleted_at: null,
      ...(b.reading === undefined ? {} : { reading_at: day(i), reading_progress: b.reading }),
    };
  });
  return {
    format: "koona-pin", version: 1, exported_at: day(0), app_version: "0.1.0",
    collections, tags: [...tags.values()], bookmarks,
  };
}

/**
 * Serves scripts/shots/previews on 127.0.0.1 at a port of its own. `host` names it in the
 * addresses (`base`): a name the WebView maps to this server, as on Windows, or the address itself.
 */
export function servePreviews(host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const file = path.join(previews, path.basename(new URL(req.url, "http://x").pathname));
        res.writeHead(200, { "content-type": "image/jpeg" }).end(await readFile(file));
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://${host}:${server.address().port}` }));
  });
}

/**
 * The page pasted into New link: a site of the sample (earlytrail.org, its day hikes are in
 * library.json) with a feed. The site does not exist: the test app takes the answers of the page
 * and of its feed from a file named by KOONAPIN_SHOTS_PREVIEWS (src-tauri/src/feeds/discover.rs).
 */
export const NEW_LINK = {
  url: "https://earlytrail.org/coastal-walks",
  title: "Five coastal walks that end at a lighthouse",
  site: "Early Trail",
  picture: "lighthouse.jpg",
  feed: "https://earlytrail.org/feed.xml",
};

/** The answers for KOONAPIN_SHOTS_PREVIEWS: the page's preview (picture from `base`), its feed's. */
export function previewSeed(base, now = Date.now()) {
  const { url, title, site, picture, feed } = NEW_LINK;
  const domain = new URL(url).hostname;
  return {
    links: {
      [url]: {
        url, metadata: { title, description: null, image_url: `${base}/${picture}`, favicon_url: null, site_name: site, domain },
        feeds: [{ url: feed, title: site, kind: "rss" }], is_feed: false, subscribed_uid: null,
      },
    },
    // About 2 new posts a week, the last one 2 days ago.
    feeds: { [feed]: { title: site, site_url: `https://${domain}/`, icon_url: null, posts_per_day: 0.3, last_post_at: new Date(now - 2 * 86400e3).toISOString() } },
  };
}

/** Labels of the interface (English), to find buttons by what they say. */
export const locale = JSON.parse(await readFile(path.join(root, "src", "locales", "en.json"), "utf8"));
export const label = (key) => key.split(".").reduce((o, k) => o[k], locale);

/** A value as a JavaScript literal for code sent to the page: JSON, with the characters that could end
 * a string or a script outside JSON's rules (<, >, /, U+2028, U+2029) escaped. */
export const lit = (value) =>
  JSON.stringify(value).replace(/[<>\/\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** A click on the button whose text is `text` (or starts with it, a count after it); true once clicked. */
export const click = (text, exact = false) => {
  const match = exact ? `b.textContent.trim() === ${lit(text)}` : `b.textContent.trim().startsWith(${lit(text)})`;
  return `(() => { const b = [...document.querySelectorAll("button")].find((b) => ${match}); if (!b) return false; b.click(); return true; })()`;
};

/** What the page settles into before a shot: no picture, font or animation under way. */
export const SETTLED = `document.fonts.status === "loaded"
  && [...document.images].filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 0; }).every((i) => i.complete && i.naturalWidth > 0)
  && document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity)`;

/** The selection bar's button named `name` (its icon's label). */
const barButton = (name) =>
  `(() => { const b = document.querySelector(${lit(`[role=toolbar][aria-label="${label("selection.label")}"] button[aria-label="${name}"]`)}); if (!b) return false; b.click(); return true; })()`;

/**
 * The first three cards of the library into the bundle, as a person does it: Ctrl-click (⌘ on a
 * Mac) selects them, the selection bar's Export → Add to bundle, × lets the selection go. Each
 * step is an expression the page runs until it is true; one that clicks is true once it clicked.
 */
const BUNDLE = [
  `(() => { const cards = [...document.querySelectorAll("[data-bookmark-id]")].slice(0, 3); if (cards.length < 3) return false;
    cards.forEach((c) => c.querySelector("h2").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true, metaKey: true }))); return true; })()`,
  `document.querySelectorAll("[data-bookmark-id][data-selected]").length === 3`,
  barButton(label("selection.export")),
  `(() => { const m = [...document.querySelectorAll("[role=menuitem]")].find((m) => m.textContent.trim().startsWith(${lit(label("bundle.addToBundle"))})); if (!m) return false; m.click(); return true; })()`,
  barButton(label("selection.clear")),
  `!document.querySelector("[data-bookmark-id][data-selected]") && document.querySelector("[data-bundle-count]")?.textContent.trim() === "3"`,
];

/** The value of the field New link pastes into, set as a paste sets it (AddSheet.tsx tells a paste from typing). */
const PASTE = `(() => {
  const field = document.querySelector("[data-add-sheet] input[inputmode=url]");
  if (!field) return false;
  field.focus();
  field.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true }));
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, ${lit(NEW_LINK.url)});
  field.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;

/**
 * The views of the help (koona.app/pin/help) both scripts shoot, from the library in the grid:
 * `open`, the steps from a reload; `ready`, what shows the view is there.
 * - bundle: three bookmarks in the bundle, its capsule with «3» at the bottom right;
 * - bundle-open: the same bundle opened: its panel, the three rows, Copy as Markdown and Save .kpin…;
 * - new-link: New link with the sample's page pasted, its preview and Follow turned on;
 * - settings: Settings at the top, its first section (General).
 */
export const HELP_VIEWS = {
  bundle: { open: BUNDLE, ready: `!!document.querySelector("[data-bundle-capsule] [data-bundle-count]")` },
  "bundle-open": {
    open: [...BUNDLE, `(() => { const b = document.querySelector("[data-bundle-capsule] > button"); if (!b) return false; b.click(); return true; })()`],
    ready: `document.querySelectorAll("[data-bundle-panel] [data-bundle-row]").length === 3
      && [${lit(label("bundle.copy"))}, ${lit(label("bundle.save"))}].every((t) => [...document.querySelectorAll("[data-bundle-panel] button")].some((b) => b.textContent.trim() === t))`,
  },
  "new-link": {
    open: [
      `(() => { const b = document.querySelector(${lit(`button[aria-label="${label("sidebar.newLink")}"]`)}) ?? [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(${lit(label("sidebar.newLink"))})); if (!b) return false; b.click(); return true; })()`,
      PASTE,
      // The page's answer, then Follow on: the feed's own answer says how often it posts.
      `(() => { const s = document.querySelector("[data-feed-offer] [role=switch]"); if (!s || !document.querySelector("[data-add-preview=new]")) return false; if (s.getAttribute("aria-checked") !== "true") s.click(); return true; })()`,
    ],
    ready: `!!document.querySelector("[data-feed-offer=ready]") && !!document.querySelector("[data-add-preview=new] img")`,
  },
  settings: {
    open: [click(label("nav.settings"), true)],
    ready: `!!document.querySelector(${lit(`select[aria-label="${label("settings.language")}"]`)})`,
  },
};

/** Polls `check` until it is true; a check that throws counts as false. */
export async function until(check, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/**
 * WebP for the site: Chromium encodes it from a PNG, keeping its alpha. `encode(png, { width, crop,
 * type, quality })`: `width` scales it, `crop` = [w, h] cuts the top left corner at that scale.
 * `smooth` scales with the canvas's high-quality filter (a 2× shot halved stays crisp). `page` is the
 * Chromium page it draws in, for other work on pictures; `close()` when done.
 */
export async function webpEncoder({ smooth = false } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const encode = async (png, { width, crop, type = "image/webp", quality = 0.86 } = {}) => {
    const b64 = await page.evaluate(
      async ([src, width, crop, type, quality, smooth]) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const k = width ? width / img.width : 1;
        const [w, h] = crop ?? [img.width * k, img.height * k];
        const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
        const context = canvas.getContext("2d");
        if (smooth) context.imageSmoothingQuality = "high";
        context.drawImage(img, 0, 0, img.width * k, img.height * k);
        return canvas.toDataURL(type, quality).split(",")[1];
      },
      [`data:image/png;base64,${png.toString("base64")}`, width, crop, type, quality, smooth],
    );
    return Buffer.from(b64, "base64");
  };
  return { encode, page, close: () => browser.close() };
}
