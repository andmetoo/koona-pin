// The cover of a bookmark without a picture (NP-087, Р-43): a gradient of
// the site, a pattern of the page and the site's icon on a tile. Everything
// comes from the address alone — nothing is fetched or stored — and the same
// address gives the same cover on every start and every machine.

/** FNV-1a, 32 bits: a fast, stable spread of short strings. */
export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A small deterministic sequence from one seed (mulberry32). */
function random(seed: number) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Gradients in the spirit of Linear, Raycast and Apple wallpapers: two
 * neighbours on the colour wheel, saturated but soft, light enough for a
 * white tile and white words. Dark theme dims them in CSS.
 */
export const PALETTE: readonly (readonly [string, string])[] = [
  ["#7c86f2", "#5e3fd6"], // indigo
  ["#4cc3f5", "#2b63e0"], // sky
  ["#3cc9b4", "#11806a"], // teal
  ["#9bd65e", "#2f9a52"], // lime
  ["#f8c25a", "#e3692a"], // amber
  ["#fb8aa0", "#d63f7d"], // rose
  ["#ff9a76", "#d8443a"], // coral
  ["#e08cf7", "#8a45e0"], // orchid
  ["#8fa3c4", "#3d4c6b"], // slate
  ["#e2bf95", "#a8703f"], // sand
  ["#8fc0a5", "#2f6b4f"], // forest, the accent of the app
  ["#5fd0e6", "#1e7f99"], // lagoon
  ["#b48cf5", "#5b2fa8"], // plum
  ["#f89a5c", "#c23d76"], // sunset
];

export type Pattern = "waves" | "grid" | "rings" | "dots";
const PATTERNS: readonly Pattern[] = ["waves", "grid", "rings", "dots"];

/** The pattern's canvas; `xMidYMid slice` fits it to any preview. */
export const VIEW = { width: 160, height: 100 } as const;

export interface Cover {
  from: string;
  to: string;
  /** Of the gradient, degrees. */
  angle: number;
  pattern: Pattern;
  /** SVG path data of the pattern, in VIEW coordinates. */
  path: string;
  /** Circles of `rings` and `dots`: [cx, cy, r]. */
  circles: [number, number, number][];
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * The colour belongs to the site, so its cards are recognised together; the
 * pattern and its details belong to the page, so they still differ.
 */
export function coverOf(domain: string, url: string): Cover {
  const site = hash(domain.toLowerCase());
  const [from, to] = PALETTE[site % PALETTE.length];
  const page = hash(url);
  const next = random(page);
  const pattern = PATTERNS[page % PATTERNS.length];
  const angle = 110 + Math.round(next() * 60);
  const { width: W, height: H } = VIEW;
  let path = "";
  const circles: [number, number, number][] = [];
  if (pattern === "waves") {
    const amplitude = 4 + next() * 6;
    const length = 40 + next() * 40;
    const phase = next() * length;
    for (let line = 0; line < 6; line++) {
      const y = 18 + line * 14 + next() * 4;
      let d = `M${-length + phase},${round(y)}`;
      for (let x = -length + phase; x < W + length; x += length) d += ` q${round(length / 4)},${round(-amplitude)} ${round(length / 2)},0 t${round(length / 2)},0`;
      path += d;
    }
  } else if (pattern === "grid") {
    // Isometric: two diagonal families and the verticals.
    const step = 14 + Math.round(next() * 8);
    for (let x = -H * 2; x < W + H; x += step) {
      path += `M${round(x)},0 L${round(x + H / Math.tan(Math.PI / 6))},${H}`;
      path += `M${round(x)},${H} L${round(x + H / Math.tan(Math.PI / 6))},0`;
    }
    for (let x = next() * step; x < W; x += step * 2) path += `M${round(x)},0 V${H}`;
  } else if (pattern === "rings") {
    const cx = next() < 0.5 ? W * (0.15 + next() * 0.2) : W * (0.65 + next() * 0.2);
    const cy = H * (0.2 + next() * 0.6);
    const gap = 9 + next() * 6;
    for (let r = gap; r < W * 1.2; r += gap) circles.push([round(cx), round(cy), round(r)]);
  } else {
    // A halftone: dots grow towards one corner.
    // Coarse enough to stay under a hundred dots: every card draws them.
    const step = 14 + Math.round(next() * 4);
    const toward = next() < 0.5 ? 0 : W;
    for (let y = step / 2; y < H; y += step)
      for (let x = step / 2; x < W; x += step) {
        const r = 0.4 + (1 - Math.abs(x - toward) / W) * 2.4;
        circles.push([round(x), round(y), round(r)]);
      }
  }
  return { from, to, angle, pattern, path, circles };
}

/** Second-level labels that are not the site's name: «co» of «bbc.co.uk». */
const GENERIC = new Set(["co", "com", "org", "net", "gov", "ac", "edu", "or", "ne", "go"]);

/**
 * The letter of a site without an icon: «G» for «mail.google.com», «B» for
 * «bbc.co.uk». An address by number says nothing: the page's title does.
 */
export function monogram(domain: string, title = ""): string {
  if (/^[\d.:[\]]+$/.test(domain)) return (Array.from(title.trim())[0] ?? "#").toLocaleUpperCase();
  const labels = domain.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  let name = labels.length > 1 ? labels[labels.length - 2] : (labels[0] ?? "");
  if (labels.length > 2 && GENERIC.has(name)) name = labels[labels.length - 3];
  return (Array.from(name)[0] ?? "?").toLocaleUpperCase();
}

/**
 * Metadata of a link just saved is still on its way: no picture, no icon, the
 * first revision (the metadata's own update makes the second, found or not),
 * a few seconds old, not from an import (imports never fetch). The preview
 * shimmers until it comes or this time is out.
 */
export const PENDING_MS = 12_000;
export function pendingFor(
  b: { image_url: string | null; favicon_url: string | null; created_at: string; source: string | null; revision: number },
  now = Date.now(),
): number {
  if (b.image_url || b.favicon_url || b.source === "import" || b.revision > 1) return 0;
  const left = Date.parse(b.created_at) + PENDING_MS - now;
  return left > 0 && left <= PENDING_MS ? left : 0;
}
