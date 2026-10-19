import { type PointerEvent, useRef, useState } from "react";
import { impactLight } from "../../../platform/haptics";

/** Where a dragged card is heading: left to the trash, up to Reading, right to keep. */
export type Toward = "trash" | "reading" | "keep" | null;
export type Swiped = Exclude<Toward, null>;

/** Touches starting this close to the screen's left or right edge belong to the system's Back. */
export const EDGE = 24;
/** A drag this far (or 30 % of the card, whichever is less) decides when let go. */
const THRESHOLD = 110;
/** Upward, this far (or a quarter of the card's height). */
const THRESHOLD_UP = 120;
/** Movement before a touch is a drag (sideways) or a scroll (up and down). */
const SLOP = 8;
/** Until the drag is this long its axis may still change: a swipe that starts a little upward can become Keep. */
const AXIS = 28;

/**
 * The triage card's swipe (doc/mobile-design.md, Triage card; owner, 19 October): it follows the
 * finger, leaning sideways; past the threshold `impactLight()` ticks once (again after coming back
 * and crossing anew) and letting go decides from where it is — left Trash, up Reading (keep and
 * add to Reading), right Keep; short of it the card springs back. Only a drag that starts on the
 * card counts (the card takes no scrolling, `touch-action: none`), so the upward swipe never
 * competes with the system's home gesture, and touches starting at the screen's side edges are the
 * system's Back. The card moves by transform only, set on the element without a render; React
 * hears only the direction and the threshold.
 */
export function useSwipe(onDecide: (kind: Swiped, from: number) => void) {
  const [toward, setToward] = useState<Toward>(null);
  const [armed, setArmed] = useState(false);
  const gesture = useRef<{ x: number; y: number; id: number; drag: boolean; dx: number; dy: number; up: boolean; armed: boolean; toward: Toward } | null>(null);
  /** Where the last touch went down, and whether it became a drag: only a touch that stayed put is a tap. */
  const down = useRef({ x: 0, y: 0, dragged: false });
  const card = useRef<HTMLElement | null>(null);

  const settle = (el: HTMLElement, spring: boolean) => {
    el.style.transition = spring ? "transform var(--ph-spring-time) var(--ph-spring)" : "none";
    el.style.transform = "";
    el.style.removeProperty("--swipe");
  };
  const end = (decide: boolean) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g?.drag) return;
    down.current.dragged = true;
    const el = card.current;
    setToward(null);
    setArmed(false);
    if (decide && g.armed) {
      if (el) settle(el, false);
      onDecide(g.up ? "reading" : g.dx < 0 ? "trash" : "keep", g.up ? g.dy : g.dx);
    } else if (el) settle(el, true);
  };

  const bind = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      down.current = { x: e.clientX, y: e.clientY, dragged: false };
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // The system's back gesture starts at the edges: not a swipe of ours.
      if (e.clientX < EDGE || e.clientX > window.innerWidth - EDGE) return;
      card.current = e.currentTarget;
      gesture.current = { x: e.clientX, y: e.clientY, id: e.pointerId, drag: false, dx: 0, dy: 0, up: false, armed: false, toward: null };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const g = gesture.current;
      const el = card.current;
      if (!g || !el || e.pointerId !== g.id) return;
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (!g.drag) {
        if (Math.hypot(dx, dy) <= SLOP) return;
        // Up decides Reading; a drag that starts downward is nothing of ours.
        if (Math.abs(dy) >= Math.abs(dx) && dy > 0) {
          gesture.current = null;
          return;
        }
        g.up = Math.abs(dy) >= Math.abs(dx);
        g.drag = true;
        el.setPointerCapture?.(e.pointerId);
        el.style.transition = "none";
      }
      if (Math.hypot(dx, dy) < AXIS) g.up = -dy >= Math.abs(dx);
      g.dx = dx;
      g.dy = dy;
      let progress: number;
      let way: Toward;
      if (g.up) {
        const rise = Math.max(0, -dy);
        const limit = Math.min(THRESHOLD_UP, el.offsetHeight * 0.25);
        el.style.transform = `translate3d(${dx * 0.12}px, ${-rise}px, 0) scale(${(1 - Math.min(rise, limit * 1.5) / 1200).toFixed(4)})`;
        progress = rise / limit;
        way = rise < 12 ? null : "reading";
      } else {
        const limit = Math.min(THRESHOLD, el.offsetWidth * 0.3);
        el.style.transform = `translate3d(${dx}px, ${dy * 0.12}px, 0) rotate(${dx / 22}deg)`;
        progress = Math.abs(dx) / limit;
        way = Math.abs(dx) < 12 ? null : dx < 0 ? "trash" : "keep";
      }
      el.style.setProperty("--swipe", Math.min(1, progress).toFixed(3));
      if (way !== g.toward) {
        g.toward = way;
        setToward(way);
      }
      const past = progress >= 1;
      if (past !== g.armed) {
        g.armed = past;
        setArmed(past);
        if (past) void impactLight();
      }
    },
    onPointerUp: () => end(true),
    onPointerCancel: () => end(false),
    // Only the card's own loss ends the drag. iOS's WebKit captures a touch on the element under
    // the finger (the picture, the title) and fires `lostpointercapture` there when the card takes
    // the capture over, which bubbles up here as the drag begins.
    onLostPointerCapture: (e: PointerEvent<HTMLElement>) => {
      if (e.target === e.currentTarget && gesture.current?.drag) end(true);
    },
  };

  return {
    bind,
    toward,
    armed,
    dragging: toward !== null,
    /** For the card's click: false after a drag or a touch that moved (an edge swipe of the system). */
    isTap: (e: { clientX: number; clientY: number }) =>
      !down.current.dragged && Math.abs(e.clientX - down.current.x) <= SLOP && Math.abs(e.clientY - down.current.y) <= SLOP,
  };
}
