/**
 * The rules of the swipe between a screen's filters (doc/mobile-design.md, "Swipes between
 * filters"; owner, 20 October 2026), apart from the DOM so Vitest checks them: Library's chips,
 * Feeds' feed chips, Reading's To read and Read.
 */

/** Touches starting this close to the screen's left or right edge belong to the system's Back. */
export const EDGE = 24;
/** Movement before a touch is a swipe (sideways) or a scroll (anything else). */
export const SLOP = 10;
/** Sideways must win by this much to be a swipe: a diagonal drag is the list's scroll. */
const SIDEWAYS = 1.2;
/** A drag this share of the width moves to the neighbour when let go… */
const SHARE = 1 / 3;
/** …or a flick this fast (px per ms) that has gone at least {@link FLICK_MIN}. */
const FLICK = 0.5;
const FLICK_MIN = 24;
/** A finger that rests this long (ms) before it lifts has no flick left. */
const REST = 80;
/** Past the first or the last filter the page follows the finger this much, at most {@link BAND_MAX}. */
const BAND = 0.25;
const BAND_MAX = 64;

/** The drag's velocity when the finger lifts: none after it rested since its last move. */
export function liftVelocity(velocity: number, sinceMove: number): number {
  return sinceMove > REST ? 0 : velocity;
}

/** Whether a touch at `x` starts in the system's back-gesture strips of a screen `width` wide. */
export function atEdge(x: number, width: number): boolean {
  return x < EDGE || x > width - EDGE;
}

/** What a drag is once it has moved past the slop: a swipe ("x"), the list's ("y"), or undecided. */
export function axisOf(dx: number, dy: number): "x" | "y" | null {
  if (Math.hypot(dx, dy) < SLOP) return null;
  return Math.abs(dx) > Math.abs(dy) * SIDEWAYS ? "x" : "y";
}

/** The filter a drag of `dx` heads to: the next one when dragged left, the previous when right; null past the ends. */
export function neighbour(dx: number, index: number, count: number): number | null {
  const next = dx < 0 ? index + 1 : index - 1;
  return dx === 0 || next < 0 || next >= count ? null : next;
}

/** Where the page is drawn for a drag of `dx`: with the finger, or a rubber band where there is nothing to go to. */
export function offsetOf(dx: number, index: number, count: number): number {
  if (neighbour(dx, index, count) !== null) return dx;
  return Math.sign(dx) * Math.min(BAND_MAX, Math.abs(dx) * BAND);
}

/**
 * The filter a drag lands on when let go: the neighbour past the threshold or after a flick its
 * way, else where it was; a flick back stays whatever the distance. `velocity` in px per ms.
 */
export function landOn(dx: number, velocity: number, width: number, index: number, count: number): number {
  const next = neighbour(dx, index, count);
  if (next === null) return index;
  const quick = Math.abs(velocity) >= FLICK;
  if (quick && Math.sign(velocity) !== Math.sign(dx)) return index;
  const far = Math.abs(dx) >= width * SHARE;
  return far || (quick && Math.abs(dx) >= FLICK_MIN) ? next : index;
}
