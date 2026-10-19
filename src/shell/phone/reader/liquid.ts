/**
 * The maths of the reading progress's liquid (the pie in the reader's pill, the drop in iPhone
 * Duo's column): springs, and the shapes drawn as SVG paths. Pure, so the motion can be tested
 * without a screen; the components move it with transforms and one path per frame, never a filter.
 */

/** A spring by how it feels: the period of its swing in seconds and its damping ratio (1 = no swing). */
export type SpringSpec = { period: number; damping: number };

/** The design's springs (doc: the reading progress board; the DO2 motion note). */
export const SPRINGS = {
  /** The finger's lag while pulling. */
  follow: { period: 0.3, damping: 0.7 },
  /** Released early: back with one slight wobble. */
  back: { period: 0.4, damping: 0.55 },
  /** Progress changing: the level settles with a soft slosh. */
  slosh: { period: 0.5, damping: 0.6 },
} satisfies Record<string, SpringSpec>;

export type SpringState = { x: number; v: number };

/**
 * One step of a damped spring toward `target`, `dt` seconds long, in small sub-steps (semi-implicit
 * Euler stays stable at a frame's length).
 */
export function springStep({ x, v }: SpringState, target: number, spec: SpringSpec, dt: number): SpringState {
  const w = (2 * Math.PI) / spec.period;
  const k = w * w;
  const c = 2 * spec.damping * w;
  let left = Math.min(dt, 0.1);
  while (left > 0) {
    const h = Math.min(left, 1 / 240);
    v += (-k * (x - target) - c * v) * h;
    x += v * h;
    left -= h;
  }
  return { x, v };
}

/** At rest: near enough to its target and slow enough to stop drawing. */
export const settled = ({ x, v }: SpringState, target: number, eps = 0.01) => Math.abs(x - target) < eps && Math.abs(v) < eps * 10;

const f = (n: number) => (Math.round(n * 100) / 100).toString();

/**
 * A pie's sector from twelve o'clock, clockwise, for `p` in 0…1, centred on (cx, cy): an empty
 * path at 0, the whole disc at 1.
 */
export function sectorPath(cx: number, cy: number, r: number, p: number): string {
  const q = Math.max(0, Math.min(1, p));
  if (q <= 0.001) return "";
  if (q >= 0.999) return `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;
  const a = q * 2 * Math.PI;
  const x = cx + r * Math.sin(a);
  const y = cy - r * Math.cos(a);
  return `M${f(cx)} ${f(cy)}L${f(cx)} ${f(cy - r)}A${f(r)} ${f(r)} 0 ${q > 0.5 ? 1 : 0} 1 ${f(x)} ${f(y)}Z`;
}

/**
 * How narrow the neck between the base and the pulled drop is: wide when it starts, thinning as
 * the pull nears `threshold` (surface tension), never quite a line before it snaps.
 */
export function neckHalfWidth(r: number, h: number, threshold: number): number {
  return r * Math.max(0.16, 1 - Math.max(0, h) / (threshold * 1.12));
}

/**
 * The liquid between a base disc of radius `r` at (0, 0) and the drop pulled `h` above it (its
 * radius `top`): one closed path, the base's lower half, a neck thinning toward the middle, the
 * drop's upper half. Empty at rest.
 */
export function liquidPath(r: number, top: number, h: number, threshold: number): string {
  if (h <= 0.5) return "";
  const n = neckHalfWidth(r, h, threshold);
  const m = -h / 2;
  return [
    `M${f(-r)} 0`,
    `A${f(r)} ${f(r)} 0 0 0 ${f(r)} 0`,
    `C${f(r)} ${f(-h * 0.22)} ${f(n)} ${f(m + h * 0.16)} ${f(n)} ${f(m)}`,
    `C${f(n)} ${f(m - h * 0.16)} ${f(top)} ${f(-h + h * 0.22)} ${f(top)} ${f(-h)}`,
    `A${f(top)} ${f(top)} 0 0 0 ${f(-top)} ${f(-h)}`,
    `C${f(-top)} ${f(-h + h * 0.22)} ${f(-n)} ${f(m - h * 0.16)} ${f(-n)} ${f(m)}`,
    `C${f(-n)} ${f(m + h * 0.16)} ${f(-r)} ${f(-h * 0.22)} ${f(-r)} 0`,
    "Z",
  ].join("");
}

/**
 * The liquid inside a round drop of radius `r` centred on (0, 0), filled to `level` (0…1) with a
 * surface tilted by `slosh` (−1…1, from the level's spring): a shape to clip by the circle.
 */
export function levelPath(r: number, level: number, slosh: number): string {
  const l = Math.max(0, Math.min(1, level));
  if (l <= 0.001) return "";
  const y = r - 2 * r * l;
  const tilt = Math.max(-1, Math.min(1, slosh)) * r * 0.18;
  return `M${f(-r - 1)} ${f(y + tilt)}Q0 ${f(y - tilt * 0.4)} ${f(r + 1)} ${f(y - tilt)}L${f(r + 1)} ${f(r + 1)}L${f(-r - 1)} ${f(r + 1)}Z`;
}

/** The base's wobble after a snap or a release: a damped swing of its scale, 1 at rest. */
export function wobble(t: number, amount = 0.08): number {
  if (t <= 0) return 1;
  return 1 + amount * Math.exp(-6 * t) * Math.sin(16 * t);
}
