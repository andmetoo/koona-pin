// The geometry of the picture viewer (components/reader/PictureViewer.tsx): the picture is laid
// out once at its fitted size around a centre point (the middle of the room the buttons leave),
// and everything after (the lift from the article, zoom, pan, the swipe that closes it) is a
// translation of its centre from that point and a scale of that fitted size. Pure numbers, so
// they are tested apart.

export interface Size {
  width: number;
  height: number;
}

/** Where the picture stands: its centre's offset from the layout's centre, and its scale over the fit. */
export interface View {
  x: number;
  y: number;
  scale: number;
}

export const FITTED: View = { x: 0, y: 0, scale: 1 };

export interface Point {
  x: number;
  y: number;
}

const middle = (window: Size): Point => ({ x: window.width / 2, y: window.height / 2 });

/**
 * The picture at its largest inside `room`, never above `cap` (its own pixels): a small one is
 * shown at its size, not blown up.
 */
export function fitSize(natural: Size, room: Size, cap: number = natural.width): Size {
  if (natural.width <= 0 || natural.height <= 0) return { width: 0, height: 0 };
  const ratio = Math.min(room.width / natural.width, room.height / natural.height, cap / natural.width);
  const k = Math.max(0, ratio);
  return { width: natural.width * k, height: natural.height * k };
}

/** Zoom goes to twice the picture's own pixels, at least 4 × the fit and at most 10 ×. */
export function maxScale(fit: Size, naturalWidth: number): number {
  if (fit.width <= 0) return 1;
  return Math.min(10, Math.max(4, (naturalWidth * 2) / fit.width));
}

/**
 * A view the picture can stand in: the scale between 1 and `max`, and no edge pulled inside the
 * window while the picture is larger than it; a smaller side stays where it was laid out.
 */
export function clampView(view: View, fit: Size, window: Size, max: number, centre: Point = middle(window)): View {
  const scale = Math.min(max, Math.max(1, view.scale));
  const axis = (offset: number, length: number, room: number, at: number) => {
    const half = (length * scale) / 2;
    if (half * 2 <= room) return 0;
    return Math.min(half - at, Math.max(room - at - half, offset));
  };
  return { scale, x: axis(view.x, fit.width, window.width, centre.x), y: axis(view.y, fit.height, window.height, centre.y) };
}

/**
 * The view zoomed to `scale` with the point under `at` (from the layout's centre) kept in place,
 * as a pinch or the wheel at the pointer expects.
 */
export function zoomAt(view: View, scale: number, at: Point, fit: Size, window: Size, max: number, centre: Point = middle(window)): View {
  const next = Math.min(max, Math.max(1, scale));
  const k = next / view.scale;
  return clampView({ scale: next, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k }, fit, window, max, centre);
}

/** The view that puts the fitted picture over `rect` (the picture in the article), for the lift and the way back. */
export function viewOver(rect: { left: number; top: number; width: number; height: number }, fit: Size, centre: Point): View {
  if (fit.width <= 0 || fit.height <= 0) return FITTED;
  return {
    x: rect.left + rect.width / 2 - centre.x,
    y: rect.top + rect.height / 2 - centre.y,
    // A cropped preview (`object-fit: cover`) is covered, not left with gaps.
    scale: Math.max(rect.width / fit.width, rect.height / fit.height),
  };
}

/** Whether a swipe down on an unzoomed picture closes it: far enough, or fast enough. */
export function swipeCloses(dy: number, velocity: number, windowHeight: number): boolean {
  return Math.abs(dy) > Math.min(140, windowHeight * 0.18) || Math.abs(velocity) > 0.6;
}
