import { useCallback, useEffect, useRef, useState } from "react";
import { RowDragItem } from "../services/drag";
import { bundleAt, outside, sidebarBox, sidebarDrag } from "./useRowDrag";

/** A press becomes a move after this many pixels, as a drag of the selection does (NP-030). */
const DRAG_START = 4;
/** Near the top or bottom of the sidebar the move scrolls it, faster the further in. */
const SCROLL_EDGE = 40;
const SCROLL_MAX = 16;
/** Above or below the list by more than this, releasing changes nothing. */
const OUTSIDE = 24;

export interface CollectionMove<T> {
  /** The moved collection's id. */
  from: number;
  /** Where it would land (2.19.0: a place in the tree); none outside the list or in its own place. */
  over: T | null;
  /** Outside the sidebar: the ghost is the one-row stack, and the bundle is the target (piece C). */
  outside: boolean;
  /** Over the bundle: releasing adds the collection. */
  bundle: boolean;
}

/** A collection taken out of the sidebar, to the bundle (share-bundle.md, piece C). */
export interface ToBundle {
  item: (from: number) => RowDragItem;
  onDrop: (from: number, at: { x: number; y: number }) => void;
}

/** Two places alike field by field (a place is a flat object), without a copy every frame. */
function samePlace<T>(a: T | null, b: T | null): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
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

/**
 * The row under the pointer among the rows of `list` (`[data-collection-row]`) and where on it:
 * `at` 0 is its top edge, 1 its bottom; above the first row and below the last the nearest one.
 * None outside the list (2.19.0).
 */
export function rowAt(list: HTMLElement, x: number, y: number): { index: number; at: number } | null {
  const sidebar = list.closest<HTMLElement>("aside")?.getBoundingClientRect() ?? list.getBoundingClientRect();
  const box = list.getBoundingClientRect();
  if (x < sidebar.left || x > sidebar.right || y < box.top - OUTSIDE || y > box.bottom + OUTSIDE) return null;
  const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-collection-row]"));
  if (!rows.length) return null;
  const below = rows.findIndex((row) => y < row.getBoundingClientRect().bottom);
  const index = below === -1 ? rows.length - 1 : below;
  const rect = rows[index].getBoundingClientRect();
  return { index, at: Math.min(1, Math.max(0, (y - rect.top) / rect.height)) };
}

/**
 * Moving a collection in the sidebar or the strip (NP-114, sheet 41). A press
 * on a collection becomes a move after 4 px; until then it is a click. The
 * ghost follows the pointer through `ghost` without re-rendering; only a new
 * place under it (`locate`) re-renders, and the sidebar draws it. Releasing
 * there calls `onMove(from, to)`; releasing where `locate` finds none
 * (outside the list, its own place, a place it may not go), or `Esc`,
 * changes nothing (2.19.0: places in the tree).
 * The click that ends a move is swallowed.
 *
 * Out of the sidebar the move becomes a drag to the bundle (share-bundle.md,
 * piece C): the ghost turns into the one-row stack, the capsule comes, and a
 * release over the bundle calls `toBundle.onDrop`. Back inside, it is a move.
 */
export function useCollectionReorder<T>(
  locate: (list: HTMLElement, from: number, x: number, y: number) => T | null,
  onMove: (from: number, to: T) => void,
  toBundle?: ToBundle,
) {
  const [move, setMove] = useState<CollectionMove<T> | null>(null);
  const locateRef = useRef(locate);
  locateRef.current = locate;
  const ghost = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const latest = useRef(onMove);
  latest.current = onMove;
  const bundleRef = useRef(toBundle);
  bundleRef.current = toBundle;
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
    let over: T | null = null;
    let away = false;
    let onBundle = false;
    /** The pointer has left the sidebar once: the capsule may come. */
    let shown = false;
    let item: RowDragItem | null = null;
    let animation = 0;
    /** The pointer moved, or the sidebar scrolled under it, since the last frame. */
    let dirty = false;
    const aside = sidebarBox(list);

    const aim = () => {
      const { x, y } = pointer.current;
      const next = locateRef.current(list, from, x, y);
      const out = !!bundleRef.current && outside(aside, x, y);
      const hit = out && bundleAt(x, y);
      if (out && !shown) {
        shown = true;
        item = bundleRef.current!.item(from);
      }
      if (item) sidebarDrag.set({ item, shown, over: hit });
      if (samePlace(next, over) && out === away && hit === onBundle) return;
      over = next;
      away = out;
      onBundle = hit;
      setMove((current) => current && { ...current, over: next, outside: out, bundle: hit });
    };
    // Once a frame: the reads first (the gap, the target, the sidebar's box), then the writes
    // (the scroll and the ghost). A scroll moves what is under the pointer: the next frame aims again.
    const frame = () => {
      animation = requestAnimationFrame(frame);
      const sidebar = list.closest<HTMLElement>("[data-drop-scroll]");
      const box = sidebar?.getBoundingClientRect();
      if (dirty) aim();
      dirty = false;
      place();
      if (!sidebar || !box) return;
      const { y } = pointer.current;
      const below = y - (box.bottom - SCROLL_EDGE);
      const above = box.top + SCROLL_EDGE - y;
      const before = sidebar.scrollTop;
      if (below > 0) sidebar.scrollTop += Math.min(SCROLL_MAX, Math.ceil(below / 3));
      else if (above > 0) sidebar.scrollTop -= Math.min(SCROLL_MAX, Math.ceil(above / 3));
      if (sidebar.scrollTop !== before) dirty = true;
    };
    const moved = (ev: PointerEvent) => {
      pointer.current = { x: ev.clientX, y: ev.clientY };
      if (!moving) {
        if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) <= DRAG_START) return;
        moving = true;
        document.body.classList.add("select-none");
        window.getSelection()?.removeAllRanges();
        setMove({ from, over: null, outside: false, bundle: false });
        animation = requestAnimationFrame(frame);
      }
      dirty = true;
    };
    const up = (ev: PointerEvent) => {
      const was = moving;
      // Where it is let go, even if the last frame has not caught up with the pointer.
      const to = was ? locateRef.current(list, from, ev.clientX, ev.clientY) : null;
      const dropped = was && !!bundleRef.current && outside(aside, ev.clientX, ev.clientY) && bundleAt(ev.clientX, ev.clientY);
      end();
      if (!was) return;
      swallowClick();
      if (dropped) return bundleRef.current!.onDrop(from, { x: ev.clientX, y: ev.clientY });
      if (to !== null) latest.current(from, to);
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
      if (item) sidebarDrag.set(null);
      moving = false;
      item = null;
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
