import { useCallback, useEffect, useRef, useState } from "react";
import { Bookmark } from "../types";
import { DropTarget, parseDrop, sameDrop } from "../services/drag";

/** A press becomes a drag after this many pixels, as the selection frame does (NP-028). */
const DRAG_START = 4;
/** Near the top or bottom of the sidebar the drag scrolls it, faster the further in. */
const SCROLL_EDGE = 40;
const SCROLL_MAX = 16;

export interface SelectionDrag {
  /** The bookmark under the pointer when the drag started: the top of the stack. */
  bookmark: Bookmark;
  count: number;
  target: DropTarget | null;
}

/** The click that follows the end of a drag would open the card or the row it ended on. */
function swallowClick() {
  const swallow = (click: MouseEvent) => {
    click.preventDefault();
    click.stopPropagation();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

/** The element under the pointer that names a drop target, if any (the stack lets the pointer through). */
const targetAt = (x: number, y: number) => parseDrop(document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]")?.dataset.drop);

/**
 * Dragging the selection onto the sidebar (NP-030, frame 05, sheet 32). A press
 * on a selected bookmark becomes a drag after 4 px; until then it is a click.
 * The stack follows the pointer through `stack` without re-rendering; only a
 * new target under it re-renders. Releasing over a target calls `onDrop`,
 * releasing elsewhere or `Esc` does nothing; the click that ends a drag is
 * swallowed, so a card or a sidebar row under it does not open.
 */
export function useSelectionDrag(onDrop: (target: DropTarget, at: { x: number; y: number }) => void) {
  const [drag, setDrag] = useState<SelectionDrag | null>(null);
  const stack = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const latest = useRef(onDrop);
  latest.current = onDrop;
  const stop = useRef(() => {});

  const place = () => {
    const { x, y } = pointer.current;
    if (stack.current) stack.current.style.transform = `translate(${x}px, ${y}px)`;
  };

  const start = useCallback((e: { clientX: number; clientY: number }, bookmark: Bookmark, count: number) => {
    stop.current();
    const origin = { x: e.clientX, y: e.clientY };
    pointer.current = origin;
    let dragging = false;
    let target: DropTarget | null = null;
    let animation = 0;

    const scroll = () => {
      animation = requestAnimationFrame(scroll);
      const sidebar = document.querySelector<HTMLElement>("[data-drop-scroll]");
      if (!sidebar) return;
      const box = sidebar.getBoundingClientRect();
      const { x, y } = pointer.current;
      if (x < box.left || x > box.right) return;
      const below = y - (box.bottom - SCROLL_EDGE);
      const above = box.top + SCROLL_EDGE - y;
      const before = sidebar.scrollTop;
      if (below > 0) sidebar.scrollTop += Math.min(SCROLL_MAX, Math.ceil(below / 3));
      else if (above > 0) sidebar.scrollTop -= Math.min(SCROLL_MAX, Math.ceil(above / 3));
      // What is under the pointer moved with the sidebar.
      if (sidebar.scrollTop !== before) aim();
    };
    const aim = () => {
      const next = targetAt(pointer.current.x, pointer.current.y);
      if (sameDrop(next, target)) return;
      target = next;
      setDrag((current) => current && { ...current, target: next });
    };
    const move = (ev: PointerEvent) => {
      pointer.current = { x: ev.clientX, y: ev.clientY };
      if (!dragging) {
        if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) <= DRAG_START) return;
        dragging = true;
        document.body.classList.add("select-none");
        window.getSelection()?.removeAllRanges();
        setDrag({ bookmark, count, target: null });
        animation = requestAnimationFrame(scroll);
      }
      place();
      aim();
    };
    const up = (ev: PointerEvent) => {
      const was = dragging;
      const dropped = was ? targetAt(ev.clientX, ev.clientY) : null;
      end();
      if (!was) return;
      swallowClick();
      if (dropped) latest.current(dropped, { x: ev.clientX, y: ev.clientY });
    };
    const key = (ev: KeyboardEvent) => {
      if (!dragging || ev.key !== "Escape") return;
      // Esc cancels the drag only: the selection and everything else stay.
      ev.preventDefault();
      ev.stopImmediatePropagation();
      end();
      // The button is still down: releasing it over the card must not open it.
      window.addEventListener("pointerup", swallowClick, { once: true });
    };
    const end = () => {
      cancelAnimationFrame(animation);
      document.body.classList.remove("select-none");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", key, { capture: true });
      window.removeEventListener("blur", end);
      if (dragging) setDrag(null);
      dragging = false;
      stop.current = () => {};
    };
    stop.current = end;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", key, { capture: true });
    window.addEventListener("blur", end);
  }, []);

  useEffect(() => () => stop.current(), []);
  /** For the stack: put it under the pointer before it paints. */
  return { drag, start, stack, place };
}
