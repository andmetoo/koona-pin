// The icon Finder and Explorer show on a `.kpin` list (2.18.1): a page with a folded corner, the app's
// tile on it and «KPIN» under it, drawn from design/brand/pin-spirit-flat like scripts/brand-icons.mjs.
// Tauri's file associations name no document icon. On a Mac src-tauri/macos/Info.plist names this one
// and tauri.macos.conf.json puts it in the bundle's Resources; on Windows tauri.windows.conf.json
// installs the ICO beside the app and src-tauri/nsis/hooks.nsh points the type's DefaultIcon at it.
// Writes src-tauri/macos/kpin.icns and src-tauri/windows/kpin.ico, both put together here from PNGs,
// so they are made on any system, without iconutil.
//
//   bun scripts/document-icon.mjs [--preview out.png]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ico, svgRenderer } from "./lib/icons.mjs";

const root = path.resolve(import.meta.dirname, "..");
const brand = path.join(root, "design", "brand", "pin-spirit-flat");
const microSrc = await readFile(path.join(brand, "pin-spirit-micro.svg"), "utf8");
const markPath = microSrc.match(/ d="([^"]+)"/)[1];
const [vx, vy, vw, vh] = microSrc.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);

const TILE = "#2F6B4F", MARK = "#FAF7F0", INK = "#46594C";

/**
 * The page on Apple's 1024 grid for documents: 680 wide, 860 high, a 200 fold. From 32 points down
 * the label is left out, and the tile grows to stay legible.
 */
function documentIcon(size) {
  const small = size <= 32;
  const [left, top, right, bottom, fold, r] = [172, 82, 852, 942, 200, 36];
  const page =
    `M${left + r} ${top} H${right - fold} L${right} ${top + fold} V${bottom - r} Q${right} ${bottom} ${right - r} ${bottom}` +
    ` H${left + r} Q${left} ${bottom} ${left} ${bottom - r} V${top + r} Q${left} ${top} ${left + r} ${top} Z`;
  const flap = `M${right - fold} ${top} V${top + fold - r} Q${right - fold} ${top + fold} ${right - fold + r} ${top + fold} H${right} Z`;
  const side = small ? 440 : 360, cy = small ? 560 : 470;
  const k = (side * 0.62) / vw;
  const x = 512 - (vw * k) / 2 - vx * k, y = cy - (vh * k) / 2 - vy * k;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs>` +
    `<filter id="s" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-opacity="0.22"/></filter>` +
    `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#F4F1EA"/></linearGradient></defs>` +
    `<path d="${page}" fill="url(#g)" filter="url(#s)"/>` +
    `<path d="${page}" fill="none" stroke="#D8D3C7" stroke-width="${small ? 16 : 6}"/>` +
    `<path d="${flap}" fill="#E6E1D5"/>` +
    `<rect x="${512 - side / 2}" y="${cy - side / 2}" width="${side}" height="${side}" rx="${(side * 0.225).toFixed(1)}" fill="${TILE}"/>` +
    `<path transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${k.toFixed(4)})" d="${markPath}" fill="${MARK}" fill-rule="evenodd"/>` +
    (small ? "" : `<text x="512" y="808" text-anchor="middle" font-family="-apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif" font-size="112" font-weight="700" letter-spacing="6" fill="${INK}">KPIN</text>`) +
    `</svg>`
  );
}

const { png, page: pageAt, close } = await svgRenderer();

const preview = process.argv.indexOf("--preview");
if (preview > 0) {
  // 512, 128, 64, 32 and 16 on light and dark, as Finder shows them.
  const sizes = [512, 128, 64, 32, 16];
  const pngs = [];
  for (const s of sizes) pngs.push((await png(documentIcon(s), s * (s <= 32 ? 2 : 1))).toString("base64"));
  const page = await pageAt(1);
  await page.setViewportSize({ width: 1000, height: 560 });
  await page.setContent(
    `<body style="margin:0;display:flex">` +
      ["#F2F2F2", "#1E1E1E"].map((c) => `<div style="background:${c};width:500px;height:560px;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px">` +
        sizes.map((s, i) => `<img style="width:${s / (s > 128 ? 2 : 1)}px" src="data:image/png;base64,${pngs[i]}">`).join("") + "</div>").join("") +
      `</body>`,
  );
  await page.screenshot({ path: process.argv[preview + 1] });
  await close();
  process.exit(0);
}

// The ICNS: each element a type, its length with the header and a PNG, every size drawn at its own
// size; an @2x element keeps the drawing of its size in points.
const types = [["icp4", 16, 16], ["icp5", 32, 32], ["icp6", 64, 64], ["ic07", 128, 128], ["ic08", 256, 256], ["ic09", 512, 512],
  ["ic10", 1024, 512], ["ic11", 32, 16], ["ic12", 64, 32], ["ic13", 256, 128], ["ic14", 512, 256]];
const elements = [];
for (const [type, size, points] of types) {
  const data = await png(documentIcon(points), size);
  const head = Buffer.alloc(8);
  head.write(type, 0, "ascii");
  head.writeUInt32BE(data.length + 8, 4);
  elements.push(head, data);
}
const body = Buffer.concat(elements);
const head = Buffer.alloc(8);
head.write("icns", 0, "ascii");
head.writeUInt32BE(body.length + 8, 4);
await writeFile(path.join(root, "src-tauri", "macos", "kpin.icns"), Buffer.concat([head, body]));

// The ICO: a PNG for each size Explorer asks for.
const entries = [];
for (const size of [16, 20, 24, 32, 40, 48, 64, 256]) entries.push({ size, data: await png(documentIcon(size), size) });
await mkdir(path.join(root, "src-tauri", "windows"), { recursive: true });
await writeFile(path.join(root, "src-tauri", "windows", "kpin.ico"), ico(entries));

await close();
console.log("written: src-tauri/macos/kpin.icns, src-tauri/windows/kpin.ico");
