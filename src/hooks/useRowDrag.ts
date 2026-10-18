import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { parseDrop, placeStack, RowDragItem } from "../services/drag";

/** A press becomes a drag after this many pixels, as a drag of the selection does (NP-030). */
const DRAG_START = 4;

/**
 * A sidebar row on its way to the bundle, for the capsule (share-bundle.md, piece C). `shown`: the
 * pointer has left the sidebar once in this drag, and the capsule may come; `over`: it is over the
 * bundle now. Both the collection reorder and the row drag write it; nothing else does.
 */
export interface SidebarDrag {
  item: RowDragItem;
  shown: boolean;
  over: boolean;
}

function createSidebarDrag() {
  let state: SidebarDrag | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next: SidebarDrag | null) {
      if (next === state || (next && state && next.item === state.item && next.shown === state.shown && next.over === state.over)) return;
      state = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export const sidebarDrag = createSidebarDrag();

/** The sidebar row dragged to the bundle, as React sees it. */
export const useSidebarDrag = () => useSyncExternalStore(sidebarDrag.subscribe, sidebarDrag.get);

/** The pointer is over the bundle: the capsule or the open panel (the stack lets the pointer through). */
export const bundleAt = (x: number, y: number) =>
  parseDrop(document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]")?.dataset.drop)?.kind === "bundle";

/** The box of the sidebar (or the strip) that `from` sits in, taken once when a drag starts. */
export const sidebarBox = (from: Element) => from.closest("aside")?.getBoundingClientRect() ?? null;

/** The pointer is outside that box. */
export const outside = (box: DOMRect | null, x: number, y: number) => !box || x < box.left || x > box.right || y < box.top || y > box.bottom;

/** The click that follows the end of a drag would open the row it started on. */
function swallowClick() {
  const swallow = (click: MouseEvent) => {
    click.preventDefault();
    click.stopPropagation();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

export interface RowDrag {
  item: RowDragItem;
  over: boolean;
}

/**
 * Dragging a tag chip, a feed row or All feeds to the bundle (share-bundle.md, piece C). A press
 * becomes a drag after 4 px; until then it is a click. The one-row stack follows the pointer
 * through `stack` without re-rendering. The bundle is the only target: releasing over it calls
 * `onDrop(item, at)`; releasing anywhere else, or `Esc`, changes nothing. The click that ends a
 * drag is swallowed, so the row does not open.
 */
export function useRowDrag(onDrop: (item: RowDragItem, at: { x: number; y: number }) => void) {
  const [drag, setDrag] = useState<RowDrag | null>(null);
  const stack = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const latest = useRef(onDrop);
  latest.current = onDrop;
  const stop = useRef(() => {});

  const place = () => {
    const { x, y } = pointer.current;
    if (stack.current) placeStack(stack.current, x, y);
  };

  const start = useCallback((e: { clientX: number; clientY: number; currentTarget: Element }, item: RowDragItem) => {
    stop.current();
    const box = sidebarBox(e.currentTarget);
    const origin = { x: e.clientX, y: e.clientY };
    pointer.current = origin;
    let dragging = false;
    let shown = false;
    let over = false;
    let frame = 0;

    // Once a frame: what is under the pointer first (reads), then the stack moves (a write).
    const tick = () => {
      frame = 0;
      const { x, y } = pointer.current;
      shown ||= outside(box, x, y);
      const next = shown && bundleAt(x, y);
      if (next !== over) {
        over = next;
        setDrag({ item, over });
      }
      sidebarDrag.set({ item, shown, over });
      place();
    };
    const move = (ev: PointerEvent) => {
      pointer.current = { x: ev.clientX, y: ev.clientY };
      if (!dragging) {
        if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) <= DRAG_START) return;
        dragging = true;
        document.body.classList.add("select-none");
        window.getSelection()?.removeAllRanges();
        setDrag({ item, over: false });
      }
      frame ||= requestAnimationFrame(tick);
    };
    const up = (ev: PointerEvent) => {
      const was = dragging;
      const dropped = was && bundleAt(ev.clientX, ev.clientY);
      end();
      if (!was) return;
      swallowClick();
      if (dropped) latest.current(item, { x: ev.clientX, y: ev.clientY });
    };
    const key = (ev: KeyboardEvent) => {
      if (!dragging || ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      end();
      // The button is still down: releasing it over a row must not open it.
      window.addEventListener("pointerup", swallowClick, { once: true });
    };
    const end = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      document.body.classList.remove("select-none");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", key, { capture: true });
      window.removeEventListener("blur", end);
      if (dragging) {
        setDrag(null);
        sidebarDrag.set(null);
      }
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
  return { drag, start, stack, place };
}
