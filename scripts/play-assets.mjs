// The pictures of the Google Play listing that are not screenshots (src-tauri/store/play/README.md):
//   bun scripts/play-assets.mjs   icon-512.png and feature-1024x500.png into src-tauri/store/play/en-US/
// Both from app-icon.svg: Play asks for a full square icon (it rounds the corners itself), so the
// rounded plate becomes the whole square; the feature graphic sets the spirit beside the name in Inter.
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium } from "@playwright/test";
import { root } from "./lib/paths.mjs";

const target = path.join(root, "src-tauri", "store", "play", "en-US");
const svg = readFileSync(path.join(root, "app-icon.svg"), "utf8");
const green = svg.match(/<rect[^>]*fill="(#[0-9A-Fa-f]{6})"/)[1];
const cream = svg.match(/<path[^>]*fill="(#[0-9A-Fa-f]{6})"/)[1];
const spirit = svg.match(/<path[\s\S]*?\/>/)[0];
const inter = createRequire(import.meta.url).resolve("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2");
const font = readFileSync(inter).toString("base64");

/** The spirit alone on a 1024 square, as in the icon; `size` is the square's side in CSS pixels. */
const spiritSvg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">${spirit}</svg>`;
const pages = {
  "icon-512.png": {
    width: 512, height: 512,
    html: `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="${green}"/>${spirit}</svg>`,
  },
  "feature-1024x500.png": {
    width: 1024, height: 500,
    html: `<div style="display:flex;align-items:center;justify-content:center;gap:40px;width:1024px;height:500px">
      ${spiritSvg(280)}
      <div style="color:${cream}">
        <div style="font:700 84px/1 Inter;letter-spacing:-2px">Koona Pin</div>
        <div style="font:500 32px/1.3 Inter;margin-top:20px;opacity:.85">Save links. Sort them.<br>Find them in seconds.</div>
      </div>
    </div>`,
  },
};

mkdirSync(target, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [name, { width, height, html }] of Object.entries(pages)) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(`<!doctype html><style>@font-face{font-family:Inter;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:100 900}
      html,body{margin:0;background:${green}}svg{display:block}</style>${html}`);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(target, name), omitBackground: false });
    await page.close();
    console.log(path.relative(root, path.join(target, name)));
  }
} finally {
  await browser.close();
}
