// Brand icons from design/brand/pin-spirit-flat (NP-081). The app has one icon everywhere — the
// one-colour mark (pin-spirit-micro.svg) in cream on an envy-green rounded tile, at every size, on
// Windows, Linux and macOS. The extension keeps no tile in the browser's toolbar: the mark drawn
// like the mascot at 16–32 px, the mascot at 48 px and up. Writes src-tauri/icons (via `tauri icon`
// + a mixed ICO, the macOS ICNS on Apple's grid, the macOS menu bar template), extension/src/icons,
// app-icon.svg and the phones' icons in src-tauri/gen (see phoneIcons).
//
//   bun scripts/brand-icons.mjs [--preview out.png | --phones]
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ico } from "./lib/icons.mjs";

const root = path.resolve(import.meta.dirname, "..");
const brand = path.join(root, "design", "brand", "pin-spirit-flat");
const microSrc = await readFile(path.join(brand, "pin-spirit-micro.svg"), "utf8");
const mascot = await readFile(path.join(brand, "pin-spirit.svg"), "utf8");

const TILE = "#2F6B4F", MARK = "#FAF7F0";
const markPath = microSrc.match(/ d="([^"]+)"/)[1];
const [vx, vy, vw, vh] = microSrc.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);

/**
 * The icon on a 1024 square: a tile `side` wide with corners of 22.5% (Apple's ratio), the mark
 * `share` of the tile wide and centred. `shadow` adds the drop shadow of a Dock icon.
 */
function tile({ side, share, shadow = false }) {
  const at = (1024 - side) / 2;
  const k = (side * share) / vw;
  const x = 512 - (vw * k) / 2 - vx * k;
  const y = 512 - (vh * k) / 2 - vy * k;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">` +
    (shadow ? `<defs><filter id="s" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="10" stdDeviation="12" flood-opacity="0.28"/></filter></defs>` : "") +
    `<rect x="${at}" y="${at}" width="${side}" height="${side}" rx="${(side * 0.225).toFixed(1)}" fill="${TILE}"${shadow ? ' filter="url(#s)"' : ""}/>` +
    `<path transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${k.toFixed(4)})" d="${markPath}" fill="${MARK}" fill-rule="evenodd"/></svg>`
  );
}
/** Windows, Linux, the extension: the tile nearly fills the square. Up to 32 px the mark grows, so its eyes stay open. */
const icon = (size) => tile({ side: 1024 * (size <= 32 ? 1 : 0.94), share: size <= 32 ? 0.72 : 0.62 });
/** The Dock: Apple's grid, an 824 tile with a 100 margin and a shadow; macOS draws no plate of its own around it. */
const dock = tile({ side: 824, share: 0.62, shadow: true });
/** The menu bar: the mark alone in black; the app marks it a template and macOS paints it. */
const template = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}"><path d="${markPath}" fill="#000" fill-rule="evenodd"/></svg>`;

/**
 * The extension's mark: the browser's toolbar is light or dark, so it is drawn like the mascot —
 * body green, dark outline, cream eyes. The viewBox is widened by half the outline and one more
 * pixel on every side, or the bottom of the outline fills the last pixel row and reads as cut off.
 */
const BODY = "#699A74", LINE = "#365E42", EYE = "#EEEBDC";
const [silhouette, ...eyes] = markPath.split(/(?=M)/);
/** Outline ≈ 1.1 px at the target size and a 1 px margin; the viewBox is ~126 units wide. */
function toolbarMark(size) {
  const stroke = (126 / size) * 1.1, pad = stroke / 2 + 126 / size;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${[vx - pad, vy - pad, vw + 2 * pad, vh + 2 * pad].map((n) => n.toFixed(2)).join(" ")}">` +
    `<path d="${silhouette}" fill="${BODY}" stroke="${LINE}" stroke-width="${stroke.toFixed(2)}" stroke-linejoin="round"/>` +
    `<path d="${eyes.join("")}" fill="${EYE}"/></svg>`
  );
}

/** A PNG without an alpha channel, by way of sips (macOS): the JPEG has none to carry over. */
async function jpegToPng(jpeg) {
  const dir = await mkdtemp(path.join(tmpdir(), "koonapin-opaque-"));
  await writeFile(path.join(dir, "in.jpg"), jpeg);
  execFileSync("sips", ["-s", "format", "png", path.join(dir, "in.jpg"), "--out", path.join(dir, "out.png")], { stdio: "ignore" });
  const data = await readFile(path.join(dir, "out.png"));
  await rm(dir, { recursive: true });
  return data;
}

const browser = await chromium.launch();
const page = await browser.newPage();
/**
 * Renders an SVG centred in a transparent square of `size` pixels, with a margin (a fraction of the
 * side); `opaque` drops the alpha channel (the App Store refuses an icon with one).
 */
async function png(svg, size, margin = 0, opaque = false) {
  const inner = Math.round(size * (1 - 2 * margin));
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;background:transparent;display:grid;place-items:center;width:${size}px;height:${size}px">` +
      `<img style="width:${inner}px;height:${inner}px;object-fit:contain" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"></body>`,
  );
  await page.locator("img").evaluate((img) => img.decode());
  const shot = { clip: { x: 0, y: 0, width: size, height: size } };
  return opaque ? jpegToPng(await page.screenshot({ ...shot, type: "jpeg", quality: 100 })) : page.screenshot({ ...shot, omitBackground: true });
}

const preview = process.argv.indexOf("--preview");
if (preview > 0) {
  // The icon at 16/24/32/48 on dark and light taskbars, ×4 for inspection, then the Dock tile.
  const cells = [];
  for (const bg of ["#202020", "#f3f3f3"])
    for (const s of [16, 24, 32, 48]) cells.push({ bg, s, data: (await png(icon(s), s)).toString("base64") });
  const dockData = (await png(dock, 192)).toString("base64");
  await page.setViewportSize({ width: 9 * 192, height: 192 });
  await page.setContent(
    `<body style="margin:0;display:flex">${cells
      .map((c) => `<div style="background:${c.bg};width:192px;height:192px;display:grid;place-items:center"><img style="image-rendering:pixelated;width:${c.s * 4}px" src="data:image/png;base64,${c.data}"></div>`)
      .join("")}<div style="background:#a9cf6a;width:192px;height:192px"><img src="data:image/png;base64,${dockData}"></div></body>`,
  );
  await page.screenshot({ path: process.argv[preview + 1] });
  await browser.close();
  process.exit(0);
}

/**
 * The phones get their own icons in the generated projects; Tauri's `icon` output fits neither:
 * - iOS: one opaque 1024 square, full bleed; the system rounds the corners and makes the other sizes.
 * - Android: an adaptive icon (the mark on a transparent 108 dp layer over the tile's colour, also the
 *   monochrome layer of themed icons) and, for Android 7, the tile at 48 dp. The mark fills about
 *   0.62 of the 72 dp the launcher shows, as on the desktop tile.
 */
async function phoneIcons() {
  const apple = path.join(root, "src-tauri", "gen", "apple", "Assets.xcassets", "AppIcon.appiconset");
  for (const name of await readdir(apple)) if (name.endsWith(".png")) await rm(path.join(apple, name));
  const square = tile({ side: 1024, share: 0.62 }).replace(/ rx="[^"]+"/, "");
  await writeFile(path.join(apple, "AppIcon.png"), await png(square, 1024, 0, true));
  await writeFile(path.join(apple, "Contents.json"), JSON.stringify({
    images: [{ filename: "AppIcon.png", idiom: "universal", platform: "ios", size: "1024x1024" }],
    info: { author: "xcode", version: 1 },
  }, null, 2) + "\n");

  const res = path.join(root, "src-tauri", "gen", "android", "app", "src", "main", "res");
  const k = (108 * 0.62 * 72) / 108 / vw;
  const layer = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108"><path transform="translate(${(54 - (vw * k) / 2 - vx * k).toFixed(3)} ${(54 - (vh * k) / 2 - vy * k).toFixed(3)}) scale(${k.toFixed(5)})" d="${markPath}" fill="${MARK}" fill-rule="evenodd"/></svg>`;
  const legacy = tile({ side: 1024 * 0.92, share: 0.62 });
  for (const [density, scale] of Object.entries({ mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 })) {
    const folder = path.join(res, `mipmap-${density}`);
    await rm(path.join(folder, "ic_launcher_round.png"), { force: true });
    await writeFile(path.join(folder, "ic_launcher.png"), await png(legacy, 48 * scale));
    const mark = await png(layer, 108 * scale);
    await writeFile(path.join(folder, "ic_launcher_foreground.png"), mark);
    await writeFile(path.join(folder, "ic_launcher_monochrome.png"), mark);
  }
  await mkdir(path.join(res, "mipmap-anydpi-v26"), { recursive: true });
  await writeFile(path.join(res, "mipmap-anydpi-v26", "ic_launcher.xml"), `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/ic_launcher_background"/>
  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
  <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
`);
  await writeFile(path.join(res, "values", "ic_launcher_background.xml"), `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <color name="ic_launcher_background">${TILE}</color>
</resources>
`);
  // Android Studio's sample icon that `tauri android init` leaves behind.
  await rm(path.join(res, "drawable", "ic_launcher_background.xml"), { force: true });
  await rm(path.join(res, "drawable-v24", "ic_launcher_foreground.xml"), { force: true });
}

if (process.argv.includes("--phones")) {
  await phoneIcons();
  await browser.close();
  console.log("icons written: src-tauri/gen/apple, src-tauri/gen/android");
  process.exit(0);
}
await phoneIcons();

const work = await mkdtemp(path.join(tmpdir(), "koonapin-icons-"));
const tauri = (master, ...args) =>
  execFileSync(process.execPath, [path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"), "icon", master, ...args], { cwd: root, stdio: "inherit" });

// Everything Tauri needs (Store logos, iOS, Android, the PNGs) from the icon master…
const master = path.join(work, "master-1024.png");
await writeFile(master, await png(icon(1024), 1024));
tauri(master);

// …the ICNS from the Dock master instead…
const dockMaster = path.join(work, "dock-1024.png");
await writeFile(dockMaster, await png(dock, 1024));
tauri(dockMaster, "--output", path.join(work, "dock"));
const icons = path.join(root, "src-tauri", "icons");
await copyFile(path.join(work, "dock", "icon.icns"), path.join(icons, "icon.icns"));

// …and the small sizes drawn at their own size, with the larger mark.
const entries = [];
for (const size of [16, 24, 32, 48, 64, 128, 256]) entries.push({ size, data: await png(icon(size), size) });
await writeFile(path.join(icons, "icon.ico"), ico(entries));
await writeFile(path.join(icons, "32x32.png"), await png(icon(32), 32));
await writeFile(path.join(icons, "Square30x30Logo.png"), await png(icon(30), 30));
await writeFile(path.join(icons, "Square44x44Logo.png"), await png(icon(44), 44));
// The menu bar is 18 pt high for a status icon: 36 px is its @2x.
await writeFile(path.join(icons, "tray-macos.png"), await png(template, 36));

const ext = path.join(root, "extension", "src", "icons");
for (const size of [16, 32]) await writeFile(path.join(ext, `${size}.png`), await png(toolbarMark(size), size));
for (const size of [48, 128]) await writeFile(path.join(ext, `${size}.png`), await png(mascot, size, 0.02));

await writeFile(path.join(root, "app-icon.svg"), icon(1024) + "\n");
await browser.close();
console.log("icons written: src-tauri/icons, extension/src/icons, app-icon.svg");
