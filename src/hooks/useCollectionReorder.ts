import { useCallback, useEffect, useRef, useState } from "react";

/** A press becomes a move after this many pixels, as a drag of the selection does (NP-030). */
const DRAG_START = 4;
/** Near the top or bottom of the sidebar the move scrolls it, faster the further in. */
const SCROLL_EDGE = 40;
const SCROLL_MAX = 16;
/** Above or below the list by more than this, releasing changes nothing. */
const OUTSIDE = 24;

export interface CollectionMove {
  /** Where the moved collection is in the sidebar's order. */
  from: number;
  /** The gap it would land in: 0 before the first, `count` after the last; none outside the list. */
  over: number | null;
}

/** The click that follows the end of a move would open the collection it ended on. */
function swallowClick() {
  const swallow = (click: MouseEvent) => {
    click.preventDefault();
    click.stopPropagation();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

/** The gap under the pointer among the rows of `list` (`[data-collection-row]`), or none outside it. */
function gapAt(list: HTMLElement, x: number, y: number): number | null {
  const sidebar = list.closest<HTMLElement>("aside")?.getBoundingClientRect() ?? list.getBoundingClientRect();
  const box = list.getBoundingClientRect();
  if (x < sidebar.left || x > sidebar.right || y < box.top - OUTSIDE || y > box.bottom + OUTSIDE) return null;
  const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-collection-row]"));
  const below = rows.findIndex((row) => {
    const rect = row.getBoundingClientRect();
    return y < rect.top + rect.height / 2;
  });
  return below === -1 ? rows.length : below;
}

/**
 * Moving a collection in the sidebar or the strip (NP-114, sheet 41). A press
 * on a collection becomes a move after 4 px; until then it is a click. The
 * ghost follows the pointer through `ghost` without re-rendering; only a new
 * gap under it re-renders, and the sidebar draws its line there. Releasing in
 * another gap calls `onMove(from, to)`, `to` being the place in the order;
 * releasing outside the list or in its own place, or `Esc`, changes nothing.
 * The click that ends a move is swallowed.
 */
export function useCollectionReorder(onMove: (from: number, to: number) => void) {
  const [move, setMove] = useState<CollectionMove | null>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const latest = useRef(onMove);
  latest.current = onMove;
  const stop = useRef(() => {});

  const place = () => {
    const { x, y } = pointer.current;
    // Beside the pointer, so the line between the rows stays in sight.
    if (ghost.current) ghost.current.style.transform = `translate(${x + 14}px, ${y + 6}px)`;
  };

  const start = useCallback((e: { clientX: number; clientY: number }, from: number, list: HTMLElement | null) => {
    if (!list) return;
    stop.current();
    const origin = { x: e.clientX, y: e.clientY };
    pointer.current = origin;
    let moving = false;
    let over: number | null = null;
    let animation = 0;

    const aim = () => {
      const next = gapAt(list, pointer.current.x, pointer.current.y);
      if (next === over) return;
      over = next;
      setMove((current) => current && { ...current, over: next });
    };
    const scroll = () => {
      animation = requestAnimationFrame(scroll);
      const sidebar = list.closest<HTMLElement>("[data-drop-scroll]");
      if (!sidebar) return;
      const box = sidebar.getBoundingClientRect();
      const { y } = pointer.current;
      const below = y - (box.bottom - SCROLL_EDGE);
      const above = box.top + SCROLL_EDGE - y;
      const before = sidebar.scrollTop;
      if (below > 0) sidebar.scrollTop += Math.min(SCROLL_MAX, Math.ceil(below / 3));
      else if (above > 0) sidebar.scrollTop -= Math.min(SCROLL_MAX, Math.ceil(above / 3));
      if (sidebar.scrollTop !== before) aim();
    };
    const moved = (ev: PointerEvent) => {
      pointer.current = { x: ev.clientX, y: ev.clientY };
      if (!moving) {
        if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) <= DRAG_START) return;
        moving = true;
        document.body.classList.add("select-none");
        window.getSelection()?.removeAllRanges();
        setMove({ from, over: null });
        animation = requestAnimationFrame(scroll);
      }
      place();
      aim();
    };
    const up = () => {
      const was = moving;
      const to = over;
      end();
      if (!was) return;
      swallowClick();
      // The gaps on both sides of the row are its own place.
      if (to === null || to === from || to === from + 1) return;
      latest.current(from, to > from ? to - 1 : to);
    };
    const key = (ev: KeyboardEvent) => {
      if (!moving || ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      end();
      // The button is still down: releasing it over a collection must not open it.
      window.addEventListener("pointerup", swallowClick, { once: true });
    };
    const end = () => {
      cancelAnimationFrame(animation);
      document.body.classList.remove("select-none");
      window.removeEventListener("pointermove", moved);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", key, { capture: true });
      window.removeEventListener("blur", end);
      if (moving) setMove(null);
      moving = false;
      stop.current = () => {};
    };
    stop.current = end;
    window.addEventListener("pointermove", moved);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", key, { capture: true });
    window.addEventListener("blur", end);
  }, []);

  useEffect(() => () => stop.current(), []);
  return { move, start, ghost, place };
}
