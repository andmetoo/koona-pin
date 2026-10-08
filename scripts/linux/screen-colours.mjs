// Is the window drawn (NP-098)? A screenshot of the whole screen — X11 `xwd -root` or Weston's PNG — and
// the number of different colours in it. An empty or black window (WebKitGTK's renderer failing, as with
// DMABUF on NVIDIA) leaves the screen in a few flat colours; the interface brings hundreds with its text.
//   bun scripts/linux/screen-colours.mjs <file.xwd|file.png> [minimum, 50]
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const [file, minimum = "50"] = process.argv.slice(2);
const data = readFileSync(file);

/** Distinct RGB values of an X11 window dump: 24 or 32 bits per pixel, either byte order (ZPixmap). */
function xwd(b) {
  const u32 = (i) => b.readUInt32BE(i * 4);
  const [headerSize, , format, , width, height, , byteOrder, , , , bitsPerPixel, bytesPerLine] = Array.from({ length: 13 }, (_, i) => u32(i));
  const ncolors = u32(19);
  if (format !== 2 || (bitsPerPixel !== 32 && bitsPerPixel !== 24)) throw new Error(`xwd: format ${format}, ${bitsPerPixel} bits per pixel`);
  const start = headerSize + ncolors * 12;
  const colours = new Set();
  const step = bitsPerPixel / 8;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = start + y * bytesPerLine + x * step;
      const v = byteOrder ? (b[i] << 16) | (b[i + 1] << 8) | b[i + 2] : (b[i + 2] << 16) | (b[i + 1] << 8) | b[i];
      colours.add(v);
    }
  return { width, height, colours: colours.size };
}

/** Distinct RGB values of an 8-bit PNG, RGB or RGBA, not interlaced — what Weston's screenshooter writes. */
function png(b) {
  let width, height, type;
  const idat = [];
  for (let i = 8; i < b.length; ) {
    const length = b.readUInt32BE(i);
    const kind = b.toString("latin1", i + 4, i + 8);
    const body = b.subarray(i + 8, i + 8 + length);
    if (kind === "IHDR") {
      [width, height] = [body.readUInt32BE(0), body.readUInt32BE(4)];
      if (body[8] !== 8 || body[12] !== 0 || (body[9] !== 2 && body[9] !== 6)) throw new Error("png: not 8-bit RGB(A), or interlaced");
      type = body[9];
    } else if (kind === "IDAT") idat.push(body);
    i += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = type === 6 ? 4 : 3;
  const line = width * bpp;
  const pixels = Buffer.alloc(line * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (line + 1)];
    for (let x = 0; x < line; x++) {
      const v = raw[y * (line + 1) + 1 + x];
      const a = x >= bpp ? pixels[y * line + x - bpp] : 0;
      const up = y ? pixels[(y - 1) * line + x] : 0;
      const c = y && x >= bpp ? pixels[(y - 1) * line + x - bpp] : 0;
      const p = a + up - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - up) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - up) <= Math.abs(p - c) ? up : c;
      pixels[y * line + x] = (v + [0, a, up, (a + up) >> 1, paeth][filter]) & 0xff;
    }
  }
  const colours = new Set();
  for (let i = 0; i < pixels.length; i += bpp) colours.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
  return { width, height, colours: colours.size };
}

const result = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? png(data) : xwd(data);
console.log(`${result.width}×${result.height}, ${result.colours} colours`);
if (result.colours < Number(minimum)) {
  console.log(`FAIL: fewer than ${minimum} colours — the window is empty or not drawn`);
  process.exit(1);
}
