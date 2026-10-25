// What the icon scripts share: an SVG rendered to a PNG in Chromium, and an ICO put together from
// PNGs (brand-icons.mjs, dmg-assets.mjs, document-icon.mjs).
import { chromium } from "@playwright/test";

/**
 * A renderer of SVGs to PNGs on a transparent background; `close()` when done. `png(svg, width,
 * height, scale)` renders the SVG `width`×`height` CSS pixels large at `scale` device pixels each.
 */
export async function svgRenderer() {
  const browser = await chromium.launch();
  const pages = {};
  /** A page at `scale` device pixels per CSS pixel. */
  async function page(scale) {
    pages[scale] ??= await (await browser.newContext({ deviceScaleFactor: scale })).newPage();
    return pages[scale];
  }
  async function png(svg, width, height = width, scale = 1) {
    const p = await page(scale);
    await p.setViewportSize({ width, height });
    await p.setContent(`<body style="margin:0;background:transparent"><img style="display:block;width:${width}px;height:${height}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"></body>`);
    await p.locator("img").evaluate((img) => img.decode());
    return p.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width, height } });
  }
  return { png, page, close: () => browser.close() };
}

/** ICO with PNG entries (supported since Windows Vista): `entries` are `{ size, data }`. */
export function ico(entries) {
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.data)]);
}
