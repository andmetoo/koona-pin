// The "netami pin" wordmark of pin.netami.app as outlines (Р-37): Nunito ExtraBold
// (@fontsource/nunito, SIL OFL 1.1) → site/src/brand/wordmark.svg, fill="currentColor".
// The site ships the outlines, not the font. Rerun only when the wordmark changes:
//   node scripts/site-wordmark.mjs
import opentype from "opentype.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const font = opentype.parse(
  (await readFile(path.join(root, "node_modules/@fontsource/nunito/files/nunito-latin-800-normal.woff"))).buffer,
);
const size = 100;
const glyphs = font.getPath("netami pin", 0, 0, size);
const box = glyphs.getBoundingBox();
// Height of the line box (ascender to descender) keeps the baseline where text would put it.
const scale = size / font.unitsPerEm;
const top = -font.ascender * scale;
const bottom = -font.descender * scale;
const shifted = font.getPath("netami pin", -box.x1, -top, size);
const width = Math.ceil(box.x2 - box.x1);
const height = Math.ceil(bottom - top);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" fill="currentColor" role="img" aria-label="netami pin"><path d="${shifted.toPathData(1)}"/></svg>\n`;
await mkdir(path.join(root, "site/src/brand"), { recursive: true });
await writeFile(path.join(root, "site/src/brand/wordmark.svg"), svg);
console.log(`wordmark.svg ${width}×${height}, ${svg.length} bytes`);
