// Brand icons from design/brand/pin-spirit-flat (NP-081): the mascot for 48 px and up,
// the micro mark for 16–32 px. Writes src-tauri/icons (via `tauri icon` + a mixed ICO),
// extension/src/icons and app-icon.svg.
//
//   node scripts/brand-icons.mjs [--preview out.png]
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const brand = path.join(root, "design", "brand", "pin-spirit-flat");
const mascot = await readFile(path.join(brand, "pin-spirit.svg"), "utf8");
const microSrc = await readFile(path.join(brand, "pin-spirit-micro.svg"), "utf8");

// The mark for OS icons: the background is unknown (light or dark taskbar, toolbar),
// so it is drawn like the mascot — body green, dark outline, cream eyes.
const BODY = "#699A74", LINE = "#365E42", EYE = "#EEEBDC";
const viewBox = microSrc.match(/viewBox="([^"]+)"/)[1];
const [silhouette, ...eyes] = microSrc.match(/ d="([^"]+)"/)[1].split(/(?=M)/);
// The source viewBox is tight (the silhouette touches its top and bottom), so it is widened
// by half the outline and one more pixel on every side: with half the outline alone the
// bottom of the outline fills the last pixel row and reads as cut off.
const [vx, vy, vw, vh] = viewBox.split(/\s+/).map(Number);
const micro = (stroke, pixel) => {
  const pad = stroke / 2 + pixel;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${[vx - pad, vy - pad, vw + 2 * pad, vh + 2 * pad].map((n) => n.toFixed(2)).join(" ")}">` +
    `<path d="${silhouette}" fill="${BODY}" stroke="${LINE}" stroke-width="${stroke.toFixed(2)}" stroke-linejoin="round"/>` +
    `<path d="${eyes.join("")}" fill="${EYE}"/></svg>`
  );
};
/** Outline ≈ 1.1 px at the target size and a 1 px margin; the viewBox is ~126 units wide. */
const microAt = (size) => micro((126 / size) * 1.1, 126 / size);

const browser = await chromium.launch();
const page = await browser.newPage();
/** Renders an SVG centred in a transparent square with the given margin (fraction of the side). */
async function png(svg, size, margin = 0) {
  const inner = Math.round(size * (1 - 2 * margin));
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;background:transparent;display:grid;place-items:center;width:${size}px;height:${size}px">` +
      `<img style="width:${inner}px;height:${inner}px;object-fit:contain" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"></body>`,
  );
  await page.locator("img").evaluate((img) => img.decode());
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

/** ICO with PNG entries (supported since Windows Vista). */
function ico(entries) {
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

const preview = process.argv.indexOf("--preview");
if (preview > 0) {
  // Mark at 16/24/32 on dark and light taskbars, ×4 for inspection.
  const cells = [];
  for (const bg of ["#202020", "#f3f3f3", "#35363a", "#dee1e6"])
    for (const s of [16, 24, 32]) cells.push({ bg, s, data: (await png(microAt(s), s)).toString("base64") });
  await page.setViewportSize({ width: 12 * 48 * 4, height: 48 * 4 });
  await page.setContent(
    `<body style="margin:0;display:flex">${cells
      .map((c) => `<div style="background:${c.bg};width:192px;height:192px;display:grid;place-items:center"><img style="image-rendering:pixelated;width:${c.s * 4}px" src="data:image/png;base64,${c.data}"></div>`)
      .join("")}</body>`,
  );
  await page.screenshot({ path: process.argv[preview + 1] });
  await browser.close();
  process.exit(0);
}

const work = await mkdtemp(path.join(tmpdir(), "netamipin-icons-"));
const master = path.join(work, "master-1024.png");
await writeFile(master, await png(mascot, 1024, 0.04));

// Everything Tauri needs (ICNS, Store logos, iOS, Android) from the mascot master…
execFileSync(process.execPath, [path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"), "icon", master], { cwd: root, stdio: "inherit" });

// …then the small sizes get the mark instead of a shrunken mascot.
const icons = path.join(root, "src-tauri", "icons");
const entries = [];
for (const size of [16, 24, 32, 48, 64, 128, 256])
  entries.push({ size, data: size <= 32 ? await png(microAt(size), size) : await png(mascot, size, size >= 128 ? 0.04 : 0.02) });
await writeFile(path.join(icons, "icon.ico"), ico(entries));
await writeFile(path.join(icons, "32x32.png"), await png(microAt(32), 32));
await writeFile(path.join(icons, "Square30x30Logo.png"), await png(microAt(30), 30));
await writeFile(path.join(icons, "Square44x44Logo.png"), await png(microAt(44), 44));

const ext = path.join(root, "extension", "src", "icons");
for (const size of [16, 32]) await writeFile(path.join(ext, `${size}.png`), await png(microAt(size), size));
for (const size of [48, 128]) await writeFile(path.join(ext, `${size}.png`), await png(mascot, size, 0.02));

await copyFile(path.join(brand, "pin-spirit.svg"), path.join(root, "app-icon.svg"));
await browser.close();
console.log("icons written: src-tauri/icons, extension/src/icons, app-icon.svg");
