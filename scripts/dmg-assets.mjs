// The macOS disk image's look (NP-051): the background of its Finder window and the icon of its volume,
// drawn from design/brand/pin-spirit-flat like scripts/brand-icons.mjs. Writes src-tauri/macos/dmg/
// background.tiff (660×440 with its @2x) and volume.icns; build-macos.mjs hands both to dmgbuild with
// src-tauri/macos/dmg/settings.py, whose window size and icon positions this drawing follows.
//
//   bun scripts/dmg-assets.mjs [--preview out.png]
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const brand = path.join(root, "design", "brand", "pin-spirit-flat");
const out = path.join(root, "src-tauri", "macos", "dmg");
const microSrc = await readFile(path.join(brand, "pin-spirit-micro.svg"), "utf8");
const mascot = await readFile(path.join(brand, "pin-spirit.svg"), "utf8");
const markPath = microSrc.match(/ d="([^"]+)"/)[1];
const [vx, vy, vw, vh] = microSrc.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
const [mw, mh] = mascot.match(/viewBox="([^"]+)"/)[1].split(/\s+/).slice(2).map(Number);

const GREEN = "#2F6B4F", CREAM = "#F7F4EC", INK = "#46594C";
// settings.py: the window's content is 660×400 under its title bar, the app's icon centred at (180, 170),
// Applications at (480, 170). The picture is BH high: Finder leaves the rest of a window white, and the
// title bar's height differs between macOS versions, so the cream goes on below what the window shows.
const W = 660, H = 400, BH = 440, APP = [180, 170], APPS = [480, 170];

/** The mark `width` wide, centred on (cx, cy). */
function mark(cx, cy, width, fill) {
  const k = width / vw;
  const x = cx - (vw * k) / 2 - vx * k, y = cy - (vh * k) / 2 - vy * k;
  return `<path transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${k.toFixed(4)})" d="${markPath}" fill="${fill}" fill-rule="evenodd"/>`;
}

/**
 * The window: cream, an arc from the app to Applications that ends in an arrowhead along its tangent,
 * the hint under them and Pin Spirit in the corner. Finder draws the icons and their names on top.
 */
function background() {
  const [x0, y0] = [APP[0] + 82, APP[1] - 2], [x1, y1] = [APPS[0] - 82, APPS[1] - 2];
  const [c0, c1] = [[x0 + 40, y0 - 30], [x1 - 40, y1 - 30]];
  const angle = Math.atan2(y1 - c1[1], x1 - c1[0]);
  const head = (turn) => `${(x1 - 14 * Math.cos(angle + turn)).toFixed(1)} ${(y1 - 14 * Math.sin(angle + turn)).toFixed(1)}`;
  const mascotW = 84, mascotH = (mascotW * mh) / mw;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${BH}" viewBox="0 0 ${W} ${BH}">` +
    `<defs><radialGradient id="glow" cx="50%" cy="37%" r="70%"><stop offset="0" stop-color="#FFFDF8"/><stop offset="1" stop-color="${CREAM}"/></radialGradient></defs>` +
    `<rect width="${W}" height="${BH}" fill="url(#glow)"/>` +
    `<g fill="none" stroke="${GREEN}" stroke-opacity="0.55" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M${x0} ${y0} C${c0.join(" ")} ${c1.join(" ")} ${x1} ${y1}"/>` +
    `<path d="M${head(-0.5)} L${x1} ${y1} L${head(0.5)}"/></g>` +
    `<text x="${W / 2}" y="322" text-anchor="middle" font-family="-apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif" font-size="15" font-weight="500" fill="${INK}">Drag Koona Pin to Applications</text>` +
    `<image x="${W - mascotW - 22}" y="${H - mascotH - 18}" width="${mascotW}" height="${mascotH.toFixed(1)}" href="data:image/svg+xml;base64,${Buffer.from(mascot).toString("base64")}"/>` +
    `</svg>`
  );
}

/** The volume: an external drive seen from the front on Apple's 1024 grid, the mark in green on it. */
const volume =
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs>` +
  `<linearGradient id="body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#ECE8DE"/></linearGradient>` +
  `<clipPath id="shape"><rect x="120" y="318" width="784" height="420" rx="96"/></clipPath>` +
  `<filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-opacity="0.25"/></filter></defs>` +
  `<rect x="120" y="318" width="784" height="420" rx="96" fill="url(#body)" filter="url(#shadow)"/>` +
  `<g clip-path="url(#shape)"><rect x="120" y="622" width="784" height="116" fill="#E1DCCF"/><rect x="120" y="620" width="784" height="4" fill="#CFC9BA"/></g>` +
  `<rect x="122" y="320" width="780" height="416" rx="94" fill="none" stroke="#D3CEC1" stroke-width="4"/>` +
  `<circle cx="806" cy="680" r="13" fill="#5FB585"/>` +
  mark(512, 470, 232, GREEN) +
  `</svg>`;

const browser = await chromium.launch();
const pages = {};
/** A page at `scale` device pixels per CSS pixel. */
async function page(scale) {
  pages[scale] ??= await (await browser.newContext({ deviceScaleFactor: scale })).newPage();
  return pages[scale];
}
/** Renders an SVG `width`×`height` CSS pixels large at `scale`, on a transparent background. */
async function png(svg, width, height, scale = 1) {
  const p = await page(scale);
  await p.setViewportSize({ width, height });
  await p.setContent(`<body style="margin:0;background:transparent"><img style="display:block;width:${width}px;height:${height}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"></body>`);
  await p.locator("img").evaluate((img) => img.decode());
  return p.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width, height } });
}

const preview = process.argv.indexOf("--preview");
if (preview > 0) {
  // The window at @2x with the app's icon and a stand-in for Applications where Finder puts them,
  // then the volume at 512, 128, 32 and 16 on light and dark.
  const app = (await readFile(path.join(root, "src-tauri", "icons", "128x128@2x.png"))).toString("base64");
  const bg = (await png(background(), W, BH, 2)).toString("base64");
  const vol = (await png(volume, 512, 512)).toString("base64");
  const p = await page(2);
  await p.setViewportSize({ width: W + 560, height: H });
  const at = ([x, y]) => `position:absolute;left:${x - 64}px;top:${y - 64}px;width:128px;height:128px`;
  const label = ([x, y], text) => `<div style="position:absolute;left:${x - 80}px;top:${y + 68}px;width:160px;text-align:center;font:13px -apple-system">${text}</div>`;
  await p.setContent(
    `<body style="margin:0;display:flex"><div style="position:relative;width:${W}px;height:${H}px;background:url(data:image/png;base64,${bg}) 0 0/${W}px ${BH}px">` +
      `<img style="${at(APP)}" src="data:image/png;base64,${app}">${label(APP, "Koona Pin")}` +
      `<div style="${at(APPS)};border-radius:18px;background:#6CB4F0"></div>${label(APPS, "Applications")}</div>` +
      ["#F2F2F2", "#1E1E1E"].map((c) => `<div style="background:${c};width:280px;display:grid;place-items:center">` +
        [256, 128, 32, 16].map((s) => `<img style="width:${s / 2 > 16 ? s / 2 : s}px" src="data:image/png;base64,${vol}">`).join("") + "</div>").join("") +
      `</body>`,
  );
  await p.screenshot({ path: process.argv[preview + 1] });
  await browser.close();
  process.exit(0);
}

await mkdir(out, { recursive: true });
const work = await mkdtemp(path.join(tmpdir(), "koonapin-dmg-"));

// The background: 1x and @2x in one TIFF, so Finder takes the sharp one on a Retina screen.
await writeFile(path.join(work, "background.png"), await png(background(), W, BH, 1));
await writeFile(path.join(work, "background@2x.png"), await png(background(), W, BH, 2));
execFileSync("tiffutil", ["-cathidpicheck", path.join(work, "background.png"), path.join(work, "background@2x.png"),
  "-out", path.join(out, "background.tiff")]);

// The volume icon: every size of an iconset drawn at its own size, then iconutil.
const iconset = path.join(work, "volume.iconset");
await mkdir(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  await writeFile(path.join(iconset, `icon_${size}x${size}.png`), await png(volume, size, size));
  await writeFile(path.join(iconset, `icon_${size}x${size}@2x.png`), await png(volume, size, size, 2));
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(out, "volume.icns")]);

await browser.close();
console.log("written: src-tauri/macos/dmg/background.tiff, src-tauri/macos/dmg/volume.icns");
