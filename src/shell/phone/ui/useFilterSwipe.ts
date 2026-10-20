import { type DragEvent, type MouseEvent, type PointerEvent, type RefObject, useEffect, useRef } from "react";
import { atEdge, axisOf, landOn, liftVelocity, offsetOf, pushSample, type Sample } from "./filterSwipe";

/** Room kept beside the active chip when the row scrolls to it. */
const CHIP_ROOM = 16;
/** A click this soon (ms) after a swipe lifts is the swipe's own; a later one is a tap. */
const SWIPE_CLICK = 400;
/** The old filter leaves the way the finger went in this long (ms), while the new list loads. */
const OUT = 160;
/** The new filter comes in once its list has come, or after this long (ms) whatever it shows. */
const WAIT = 400;

const reduceMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Keeps the active chip (`aria-pressed`) of a scrolling chip row in view when `active` changes, as
 * a swipe does: the row scrolls sideways only, never the screen, and not when the screen first
 * shows (the value it showed with is remembered, so React's double effects in development change
 * nothing).
 */
export function useChipInView(row: RefObject<HTMLElement | null>, active: unknown) {
  const shown = useRef(active);
  useEffect(() => {
    if (Object.is(shown.current, active)) return;
    shown.current = active;
    const el = row.current;
    const chip = el?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!el || !chip) return;
    const box = el.getBoundingClientRect();
    const at = chip.getBoundingClientRect();
    const by = at.left < box.left + CHIP_ROOM ? at.left - box.left - CHIP_ROOM : at.right > box.right - CHIP_ROOM ? at.right - box.right + CHIP_ROOM : 0;
    if (by === 0) return;
    el.scrollBy({ left: by, behavior: reduceMotion() ? "auto" : "smooth" });
  }, [row, active]);
}

/**
 * The swipe between a screen's filters (doc/mobile-design.md, "Swipes between filters"): `bind`
 * goes on the area under the chips (`.ph-swipe`, which takes `touch-action: pan-y`, so the browser
 * keeps the vertical scroll and pull to refresh and sends us only the sideways drags, and fills
 * the screen's height), `page` on the content inside it (`.ph-swipe-page`). The area stays put, so
 * a quick next swipe lands while the page still slides, and it takes the pointer once a drag turns
 * sideways, so a row redrawn under the finger cannot strand the swipe. The page follows the finger
 * by transform alone, set on the element without a render; past a third of its width or after a
 * flick (its speed over the drag's last 100 ms) it calls `onChange` with the neighbour's index
 * (which chooses it as a tap does, `selection()` tick included). The old filter then leaves the
 * way the finger went while the new list loads; once `content` has changed to it (null while it
 * loads; at most {@link WAIT}) the new filter comes in from the other side with the decision
 * spring, or, when `failed` says the load failed and the old list still shows, fades in where it
 * is. Short of the threshold, or past the first and the last filter (a rubber band), the page
 * springs back. Touches starting at the screen's side edges are the system's Back; the chips,
 * sheets and other screens are outside the area. A row's long press ends when the area takes the
 * pointer, and the click that follows a swipe right away is swallowed (a later one, a screen
 * reader's say, is a tap). Only the finger that began the swipe moves or ends it. Reduce Motion:
 * cross-fades only.
 */
export function useFilterSwipe({
  index,
  count,
  onChange,
  content,
  failed = false,
  enabled = true,
}: {
  index: number;
  count: number;
  onChange: (index: number) => void;
  /** The list shown, or null while it loads: a change after a swipe lets the new filter in. */
  content: unknown;
  /** The last load failed: the list shown is still the old filter's. */
  failed?: boolean;
  enabled?: boolean;
}) {
  const page = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x: number; y: number; id: number; sideways: boolean; dx: number; samples: Sample[] } | null>(null);
  /** When the last swipe lifted (the event's timeStamp), for the click that follows it. */
  const swipedAt = useRef<number | null>(null);
  /** A filter on its way in: which way the old one left, and what it still waits for. */
  const turn = useRef<{ dir: number; out: boolean; ready: boolean; timers: number[] } | null>(null);
  const latest = useRef({ index, count, onChange, failed });
  latest.current = { index, count, onChange, failed };

  /** Brings the new filter in: from the side opposite the one the old left, or in place (now: no motion). */
  const comeIn = (now = false) => {
    const t = turn.current;
    if (!t) return;
    turn.current = null;
    t.timers.forEach((timer) => window.clearTimeout(timer));
    const el = page.current;
    if (!el) return;
    const slide = !now && !reduceMotion() && !latest.current.failed;
    el.style.transition = "none";
    el.style.transform = slide ? `translate3d(${-t.dir * el.offsetWidth}px, 0, 0)` : "";
    if (now) {
      el.style.opacity = "";
      return;
    }
    el.style.opacity = slide ? "0.6" : "0";
    void el.offsetWidth;
    el.style.transition = slide ? "transform var(--ph-spring-time) var(--ph-spring), opacity var(--ph-spring-time) ease-out" : "opacity 200ms ease-out";
    el.style.transform = "";
    el.style.opacity = "";
  };
  const step = (part: "out" | "ready") => {
    const t = turn.current;
    if (!t) return;
    t[part] = true;
    if (t.out && t.ready) comeIn();
  };
  const steps = useRef(step);
  steps.current = step;
  useEffect(() => {
    if (content !== null && content !== undefined) steps.current("ready");
  }, [content]);
  useEffect(
    () => () => {
      turn.current?.timers.forEach((timer) => window.clearTimeout(timer));
    },
    [],
  );

  const end = (e: PointerEvent<HTMLElement>, land: boolean) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.id) return;
    gesture.current = null;
    const el = page.current;
    if (!g.sideways || !el) return;
    swipedAt.current = e.timeStamp;
    const { dx } = g;
    const { index, count, onChange } = latest.current;
    const to = land ? landOn(dx, liftVelocity(g.samples, e.timeStamp), el.offsetWidth, index, count) : index;
    delete el.dataset.swiping;
    if (to === index) {
      el.style.transition = "transform var(--ph-spring-time) var(--ph-spring)";
      el.style.transform = "";
      return;
    }
    const dir = Math.sign(dx);
    turn.current = {
      dir,
      out: false,
      ready: false,
      timers: [window.setTimeout(() => steps.current("out"), OUT), window.setTimeout(() => steps.current("ready"), WAIT)],
    };
    onChange(to);
    // The old filter leaves the way the finger went, while the new list loads.
    const reduce = reduceMotion();
    el.style.transition = reduce ? `opacity ${OUT}ms ease-in` : `transform ${OUT}ms ease-in, opacity ${OUT}ms ease-in`;
    if (!reduce) el.style.transform = `translate3d(${dir * el.offsetWidth}px, 0, 0)`;
    el.style.opacity = "0";
  };

  const bind = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      // A filter still on its way in shows as it is.
      comeIn(true);
      if (!enabled || latest.current.count < 2 || !e.isPrimary) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // The system's back gesture starts at the edges: not a swipe of ours.
      if (atEdge(e.clientX, window.innerWidth)) return;
      gesture.current = { x: e.clientX, y: e.clientY, id: e.pointerId, sideways: false, dx: 0, samples: [{ x: 0, t: e.timeStamp }] };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const g = gesture.current;
      const el = page.current;
      if (!g || !el || e.pointerId !== g.id) return;
      const dx = e.clientX - g.x;
      if (!g.sideways) {
        const axis = axisOf(dx, e.clientY - g.y);
        if (axis === null) return;
        if (axis === "y") {
          gesture.current = null;
          return;
        }
        g.sideways = true;
        // The area keeps the pointer even if the row under the finger is redrawn; the row loses it.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // A pointer that has already gone: its up or cancel ends the swipe.
        }
        el.style.transition = "none";
        el.style.opacity = "";
        el.dataset.swiping = "";
      }
      g.dx = dx;
      pushSample(g.samples, { x: dx, t: e.timeStamp });
      el.style.transform = `translate3d(${offsetOf(dx, latest.current.index, latest.current.count)}px, 0, 0)`;
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => end(e, true),
    // The browser took the touch for its scroll, or the system took it.
    onPointerCancel: (e: PointerEvent<HTMLElement>) => end(e, false),
    // The area itself lost the pointer it took (the screen hid): the swipe ends where it is.
    onLostPointerCapture: (e: PointerEvent<HTMLElement>) => {
      if (e.target === e.currentTarget) end(e, true);
    },
    // A picture or a link would start the browser's own drag, which cancels the pointer.
    onDragStart: (e: DragEvent<HTMLElement>) => e.preventDefault(),
    onClickCapture: (e: MouseEvent<HTMLElement>) => {
      const at = swipedAt.current;
      if (at === null || e.timeStamp - at > SWIPE_CLICK) return;
      swipedAt.current = null;
      e.preventDefault();
      e.stopPropagation();
    },
  };
  return { bind, page };
}
