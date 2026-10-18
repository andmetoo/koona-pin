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
