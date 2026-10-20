import { type DragEvent, type MouseEvent, type PointerEvent, type RefObject, useEffect, useRef } from "react";
import { atEdge, axisOf, landOn, liftVelocity, offsetOf } from "./filterSwipe";

/** Room kept beside the active chip when the row scrolls to it. */
const CHIP_ROOM = 16;
/** A click this soon (ms) after a swipe lifts is the swipe's own; a later one is a tap. */
const SWIPE_CLICK = 400;

/**
 * Keeps the active chip (`aria-pressed`) of a scrolling chip row in view when `active` changes, as
 * a swipe does: the row scrolls sideways only, never the screen.
 */
export function useChipInView(row: RefObject<HTMLElement | null>, active: unknown) {
  useEffect(() => {
    const el = row.current;
    const chip = el?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!el || !chip) return;
    const box = el.getBoundingClientRect();
    const at = chip.getBoundingClientRect();
    const by = at.left < box.left + CHIP_ROOM ? at.left - box.left - CHIP_ROOM : at.right > box.right - CHIP_ROOM ? at.right - box.right + CHIP_ROOM : 0;
    if (by === 0) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: by, behavior: reduce ? "auto" : "smooth" });
  }, [row, active]);
}

/**
 * The swipe between a screen's filters (doc/mobile-design.md, "Swipes between filters"): `bind`
 * goes on the area under the chips (`.ph-swipe`, which takes `touch-action: pan-y`, so the browser
 * keeps the vertical scroll and pull to refresh and sends us only the sideways drags, and fills
 * the screen's height), `page` on the content inside it (`.ph-swipe-page`). The area stays put, so
 * a quick next swipe lands while the page still slides. The page follows the finger by transform
 * alone, set on the element without a render; past a third of its width or after a flick it calls
 * `onChange` with the neighbour's index (which chooses it as a tap does, `selection()` tick
 * included) and slides the new filter in from that side with the decision spring; short of it, or
 * past the first and the last filter (a rubber band), it springs back. Touches starting at the
 * screen's side edges are the system's Back; the chips, sheets and other screens are outside the
 * area. A row's long press cancels itself once the finger moves, and the click that follows a swipe
 * right away is swallowed (a later one, a screen reader's say, is a tap). Only the finger that began
 * the swipe moves or ends it. Reduce Motion: a cross-fade.
 */
export function useFilterSwipe({ index, count, onChange, enabled = true }: { index: number; count: number; onChange: (index: number) => void; enabled?: boolean }) {
  const page = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x: number; y: number; id: number; sideways: boolean; dx: number; t: number; velocity: number } | null>(null);
  /** When the last swipe lifted (the event's timeStamp), for the click that follows it. */
  const swipedAt = useRef<number | null>(null);
  const latest = useRef({ index, count, onChange });
  latest.current = { index, count, onChange };

  const end = (e: PointerEvent<HTMLElement>, land: boolean) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.id) return;
    gesture.current = null;
    const el = page.current;
    if (!g.sideways || !el) return;
    swipedAt.current = e.timeStamp;
    const { dx } = g;
    const { index, count, onChange } = latest.current;
    const to = land ? landOn(dx, liftVelocity(g.velocity, e.timeStamp - g.t), el.offsetWidth, index, count) : index;
    delete el.dataset.swiping;
    if (to === index) {
      el.style.transition = "transform var(--ph-spring-time) var(--ph-spring)";
      el.style.transform = "";
      return;
    }
    onChange(to);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // The new filter comes in from the side the finger went to, where the old one stood.
    el.style.transition = "none";
    el.style.transform = reduce ? "" : `translate3d(${dx - Math.sign(dx) * el.offsetWidth}px, 0, 0)`;
    el.style.opacity = reduce ? "0" : "0.6";
    void el.offsetWidth;
    el.style.transition = reduce ? "opacity 200ms ease-out" : "transform var(--ph-spring-time) var(--ph-spring), opacity var(--ph-spring-time) ease-out";
    el.style.transform = "";
    el.style.opacity = "";
  };

  const bind = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (!enabled || latest.current.count < 2 || !e.isPrimary) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // The system's back gesture starts at the edges: not a swipe of ours.
      if (atEdge(e.clientX, window.innerWidth)) return;
      gesture.current = { x: e.clientX, y: e.clientY, id: e.pointerId, sideways: false, dx: 0, t: e.timeStamp, velocity: 0 };
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
        el.style.transition = "none";
        el.style.opacity = "";
        el.dataset.swiping = "";
      }
      const elapsed = e.timeStamp - g.t;
      if (elapsed > 0) g.velocity = (dx - g.dx) / elapsed;
      g.dx = dx;
      g.t = e.timeStamp;
      el.style.transform = `translate3d(${offsetOf(dx, latest.current.index, latest.current.count)}px, 0, 0)`;
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => end(e, true),
    // The browser took the touch for its scroll, or the system took it.
    onPointerCancel: (e: PointerEvent<HTMLElement>) => end(e, false),
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
