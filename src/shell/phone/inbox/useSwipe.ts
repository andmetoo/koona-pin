import { type PointerEvent, useRef, useState } from "react";
import { impactLight } from "../../../platform/haptics";

/** Where a dragged card is heading: left to the trash, right to keep. */
export type Toward = "trash" | "keep" | null;

/** Touches starting this close to the screen's left or right edge belong to the system's Back. */
export const EDGE = 24;
/** A drag this far (or 30 % of the card, whichever is less) decides when let go. */
const THRESHOLD = 110;
/** Movement before a touch is a drag (sideways) or a scroll (up and down). */
const SLOP = 8;

/**
 * The triage card's swipe (doc/mobile-design.md, Triage card): sideways it follows the finger and
 * leans; past the threshold `impactLight()` ticks once (again after coming back and crossing
 * anew) and letting go decides — left Trash, right Keep — from where it is; short of it the card
 * springs back. Up and down is the screen's scroll (`touch-action: pan-y`). The card moves by
 * transform only, set on the element without a render; React hears only the direction and the
 * threshold.
 */
export function useSwipe(onDecide: (kind: "trash" | "keep", from: number) => void) {
  const [toward, setToward] = useState<Toward>(null);
  const [armed, setArmed] = useState(false);
  const gesture = useRef<{ x: number; y: number; id: number; drag: boolean; dx: number; armed: boolean; toward: Toward } | null>(null);
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
      onDecide(g.dx < 0 ? "trash" : "keep", g.dx);
    } else if (el) settle(el, true);
  };

  const bind = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      down.current = { x: e.clientX, y: e.clientY, dragged: false };
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // The system's back gesture starts at the edges: not a swipe of ours.
      if (e.clientX < EDGE || e.clientX > window.innerWidth - EDGE) return;
      card.current = e.currentTarget;
      gesture.current = { x: e.clientX, y: e.clientY, id: e.pointerId, drag: false, dx: 0, armed: false, toward: null };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const g = gesture.current;
      const el = card.current;
      if (!g || !el || e.pointerId !== g.id) return;
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (!g.drag) {
        if (Math.abs(dy) > SLOP && Math.abs(dy) >= Math.abs(dx)) {
          gesture.current = null;
          return;
        }
        if (Math.abs(dx) <= SLOP) return;
        g.drag = true;
        el.setPointerCapture?.(e.pointerId);
        el.style.transition = "none";
      }
      g.dx = dx;
      const limit = Math.min(THRESHOLD, el.offsetWidth * 0.3);
      el.style.transform = `translate3d(${dx}px, ${dy * 0.12}px, 0) rotate(${dx / 22}deg)`;
      el.style.setProperty("--swipe", Math.min(1, Math.abs(dx) / limit).toFixed(3));
      const way: Toward = Math.abs(dx) < 12 ? null : dx < 0 ? "trash" : "keep";
      if (way !== g.toward) {
        g.toward = way;
        setToward(way);
      }
      const past = Math.abs(dx) >= limit;
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
