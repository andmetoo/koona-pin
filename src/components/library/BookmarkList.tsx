import { RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { Bookmark, Collection, ViewMode } from "../../types";
import { DateGroup, groupOf } from "../../services/dateGroups";
import { Arrow, arrowTarget } from "../../services/keys";
import { listTime } from "../../services/library";
import { BookmarkActions, BookmarkCard, BookmarkRow, CARD_TEXT_HEIGHT, DENSE_TEXT_HEIGHT, ROW_HEIGHT, SELECTED_NOTE } from "./Bookmarks";

/** Grid of frames 01 and 16: gaps 24 and 28 px, cards at least 240 px (190 px in a narrow window). */
const GRID = { gapX: 24, gapY: 28, wide: 240, narrow: 190, text: CARD_TEXT_HEIGHT };
/** The compact grid: gaps 16 and 22, cards at least 172 px (136 px in a narrow window, two columns down to ~300 px). */
const DENSE = { gapX: 16, gapY: 22, wide: 172, narrow: 136, text: DENSE_TEXT_HEIGHT };
/** List of frame 02: group header 31 px, rows 60 px, 2 px between them. */
const HEADER_HEIGHT = 31;
const LIST_GAP = 2;

/** What the selection bar and its hints cover at the bottom of the list (the scroll area's bottom padding). */
const SELECTION_BAR = 120;

/**
 * An arrow from the bookmark `from` (none: from nowhere): the bookmark it
 * reaches, scrolled into view and focused, or `null` at the edge.
 */
export type Arrows = (key: Arrow, from: number | null) => Bookmark | null;

type ListEntry = { kind: "header"; group: DateGroup; size: number } | { kind: "row"; bookmark: Bookmark };

/** The selection frame starts after this many pixels; a shorter press is a click. */
const DRAG_START = 4;
/** Near the edge of the scroll area the frame scrolls it, faster the further out. */
const SCROLL_EDGE = 48;
const SCROLL_MAX = 40;
/** Where a press does not start a frame: controls, menus. */
const INTERACTIVE = "button, a, input, textarea, select, [data-menu]";
/** Where a press on a selected bookmark does not start a drag: its shutter (NP-123), heart (NP-086), menus, fields. */
const NOT_DRAG = "[data-shutter], [data-favorite], [aria-haspopup], [data-menu], input, textarea, select";

type Rect = { left: number; top: number; right: number; bottom: number };
type Geometry = {
  grid: boolean;
  bookmarks: Bookmark[];
  entries: ListEntry[];
  columns: number;
  cardWidth: number;
  cardHeight: number;
  gapX: number;
  gapY: number;
  width: number;
};

/**
 * Bookmarks the frame touches, by the computed layout rather than the DOM:
 * the frame keeps selecting rows the virtualizer has already removed.
 */
function framed(g: Geometry, r: Rect): number[] {
  const hits: number[] = [];
  if (g.grid) {
    const rowStep = g.cardHeight + g.gapY;
    const columnStep = g.cardWidth + g.gapX;
    for (let row = Math.max(0, Math.floor(r.top / rowStep)); row <= Math.floor(r.bottom / rowStep); row++) {
      const y = row * rowStep;
      if (y >= r.bottom || y + g.cardHeight <= r.top) continue;
      for (let column = 0; column < g.columns; column++) {
        const b = g.bookmarks[row * g.columns + column];
        if (!b) break;
        const x = column * columnStep;
        if (x < r.right && x + g.cardWidth > r.left) hits.push(b.id);
      }
    }
    return hits;
  }
  let y = 0;
  for (const entry of g.entries) {
    if (y >= r.bottom) break;
    const height = entry.kind === "header" ? HEADER_HEIGHT : ROW_HEIGHT;
    if (entry.kind === "row" && y + height > r.top && r.right > 0 && r.left < g.width) hits.push(entry.bookmark.id);
    y += height + LIST_GAP;
  }
  return hits;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Selection by a frame (NP-028, frame 04): press on an empty place and drag.
 * Near the top or bottom edge the list scrolls, and the next page loads as
 * usual. Without a modifier the frame replaces the selection, with `Ctrl` or
 * `Shift` it adds. A click on an empty place clears the selection. A press on
 * a selected bookmark starts a drag instead (NP-030, Р-28): `onDrag`.
 */
function useSelectionFrame(
  scrollRef: RefObject<HTMLDivElement | null>,
  inner: RefObject<HTMLDivElement | null>,
  geometry: RefObject<Geometry>,
  selected: ReadonlySet<number>,
  onSelect: (ids: ReadonlySet<number>) => void,
  onClear: () => void,
  onDrag: ((e: PointerEvent, id: number) => void) | undefined,
) {
  const [frame, setFrame] = useState<Rect | null>(null);
  const latest = useRef({ selected, onSelect, onClear, onDrag });
  latest.current = { selected, onSelect, onClear, onDrag };
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let stop = () => {};
    const down = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (e.button !== 0 || e.pointerType === "touch" || !inner.current) return;
      const card = target.closest<HTMLElement>("[data-bookmark-id]");
      const drag = latest.current.onDrag;
      if (drag && card?.dataset.selected !== undefined && !(e.ctrlKey || e.metaKey || e.shiftKey) && !target.closest(NOT_DRAG)) {
        drag(e, Number(card.dataset.bookmarkId));
        return;
      }
      if (target.closest(INTERACTIVE)) return;
      // The scrollbar is part of the element but not of its content.
      const box = scroller.getBoundingClientRect();
      if (e.clientX >= box.left + scroller.clientLeft + scroller.clientWidth) return;
      const origin = () => inner.current!.getBoundingClientRect();
      const start = { x: e.clientX - origin().left, y: e.clientY - origin().top };
      const pointer = { x: e.clientX, y: e.clientY };
      const additive = e.ctrlKey || e.metaKey || e.shiftKey;
      const base: ReadonlySet<number> = additive ? latest.current.selected : new Set();
      const onCard = !!card;
      let dragging = false;
      let animation = 0;
      let last = "";
      const tick = () => {
        animation = requestAnimationFrame(tick);
        const view = scroller.getBoundingClientRect();
        const below = pointer.y - (view.bottom - SCROLL_EDGE);
        const above = view.top + SCROLL_EDGE - pointer.y;
        if (below > 0) scroller.scrollTop += Math.min(SCROLL_MAX, Math.ceil(below / 3));
        else if (above > 0) scroller.scrollTop -= Math.min(SCROLL_MAX, Math.ceil(above / 3));
        const g = geometry.current;
        const now = origin();
        const x = clamp(pointer.x - now.left, 0, g.width);
        const y = clamp(pointer.y - now.top, 0, inner.current?.offsetHeight ?? 0);
        const rect = {
          left: Math.min(start.x, x),
          top: Math.min(start.y, y),
          right: Math.max(start.x, x),
          bottom: Math.max(start.y, y),
        };
        setFrame((prev) =>
          prev && prev.left === rect.left && prev.top === rect.top && prev.right === rect.right && prev.bottom === rect.bottom ? prev : rect,
        );
        const hits = framed(g, rect);
        const key = hits.join(",");
        if (key === last) return;
        last = key;
        const next = new Set(base);
        for (const id of hits) next.add(id);
        latest.current.onSelect(next);
      };
      const move = (ev: PointerEvent) => {
        pointer.x = ev.clientX;
        pointer.y = ev.clientY;
        if (!dragging && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > DRAG_START) {
          dragging = true;
          document.body.classList.add("select-none");
          window.getSelection()?.removeAllRanges();
          tick();
        }
      };
      const up = () => {
        stop();
        if (!dragging && !onCard && !additive) latest.current.onClear();
      };
      stop = () => {
        cancelAnimationFrame(animation);
        document.body.classList.remove("select-none");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        setFrame(null);
        stop = () => {};
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    };
    // A preview image would start the browser's own drag and cancel the pointer.
    const native = (e: DragEvent) => e.preventDefault();
    scroller.addEventListener("pointerdown", down);
    scroller.addEventListener("dragstart", native);
    return () => {
      scroller.removeEventListener("pointerdown", down);
      scroller.removeEventListener("dragstart", native);
      stop();
    };
  }, [scrollRef, inner, geometry]);
  return frame;
}

function useWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * The library as a grid or a list (NP-012). Only the rows on screen and a
 * few around them are in the DOM; rows have fixed heights, so scrolling and
 * metadata arriving never move what is on screen. Reaching the end of the
 * loaded pages asks for the next one.
 */
export function BookmarkList({
  view,
  bookmarks,
  collections,
  actions,
  narrow,
  compact,
  scrollRef,
  dateGroups,
  grouped,
  hasMore,
  loadingMore,
  onMore,
  selected,
  onSelect,
  onClearSelection,
  onDragStart,
  dragging,
  arrowsRef,
  fresh = null,
}: {
  view: ViewMode;
  bookmarks: Bookmark[];
  collections: Collection[];
  actions: BookmarkActions;
  narrow: boolean;
  compact: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  dateGroups: { starts: string[]; sizes: Record<DateGroup, number> | null };
  /** Date groups in the orders by time; by title and by site the list is one run (NP-114). */
  grouped: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onMore: () => void;
  selected: ReadonlySet<number>;
  /** The selection the frame makes (NP-028). */
  onSelect: (ids: ReadonlySet<number>) => void;
  onClearSelection: () => void;
  /** A press on a selected bookmark (NP-030); without it the selection is not dragged (the trash). */
  onDragStart?: (e: PointerEvent, id: number) => void;
  /** The selection is being dragged: the selected fade to 45 % (frame 05). */
  dragging: boolean;
  /** Filled with `arrows`: App calls it for the arrow keys of the library (#319). */
  arrowsRef: RefObject<Arrows | null>;
  /** A link just saved (2026-10-16): its card lands with a spring and a fading ink ring. */
  fresh?: number | null;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const width = useWidth(box);

  const dense = view === "dense";
  const { gapX, gapY, text, ...min } = dense ? DENSE : GRID;
  const minCard = narrow ? min.narrow : min.wide;
  const columns = Math.max(1, Math.floor((width + gapX) / (minCard + gapX)));
  const cardWidth = (width - gapX * (columns - 1)) / columns;
  const cardHeight = Math.round((cardWidth * 10) / 16) + text;

  const entries = useMemo<ListEntry[]>(() => {
    if (view !== "list") return [];
    if (!grouped) return bookmarks.map((bookmark) => ({ kind: "row", bookmark }));
    const loaded = new Map<DateGroup, number>();
    // Grouped by when the list places them: saved, or deleted in the trash.
    for (const b of bookmarks) {
      const group = groupOf(listTime(b), dateGroups.starts);
      loaded.set(group, (loaded.get(group) ?? 0) + 1);
    }
    const result: ListEntry[] = [];
    let current: DateGroup | null = null;
    for (const bookmark of bookmarks) {
      const group = groupOf(listTime(bookmark), dateGroups.starts);
      if (group !== current) {
        current = group;
        // The size over every page when the database counted it.
        result.push({ kind: "header", group, size: dateGroups.sizes?.[group] ?? loaded.get(group) ?? 0 });
      }
      result.push({ kind: "row", bookmark });
    }
    return result;
  }, [view, bookmarks, dateGroups, grouped]);

  const grid = view !== "list";
  const count = grid ? Math.ceil(bookmarks.length / columns) : entries.length;
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    // The selection bar covers the bottom of the list: a card reached by an arrow stops above it.
    scrollPaddingEnd: selected.size ? SELECTION_BAR : 0,
    estimateSize: (index) =>
      grid ? cardHeight + gapY : (entries[index]?.kind === "header" ? HEADER_HEIGHT : ROW_HEIGHT) + LIST_GAP,
    getItemKey: (index) => {
      if (grid) return `r${index}`;
      const entry = entries[index];
      return entry?.kind === "header" ? `g-${entry.group}` : (entry?.bookmark.id ?? index);
    },
    overscan: grid ? 2 : 8,
  });
  // Sizes are computed, not measured: recompute when they change.
  useEffect(() => virtualizer.measure(), [virtualizer, grid, cardHeight, entries]);

  const geometry = useRef<Geometry>(null!);
  geometry.current = { grid, bookmarks, entries, columns, cardWidth, cardHeight, gapX, gapY, width };
  const frame = useSelectionFrame(scrollRef, inner, geometry, selected, onSelect, onClearSelection, onDragStart);

  /** The card or row an arrow chose, focused once the virtualizer has drawn it. */
  const focusing = useRef<number | null>(null);
  arrowsRef.current = (key, from) => {
    const g = geometry.current;
    const index = from === null ? -1 : g.bookmarks.findIndex((b) => b.id === from);
    const next = arrowTarget(index, key, g.bookmarks.length, g.grid ? g.columns : 1);
    if (next === null) return null;
    const b = g.bookmarks[next];
    const row = g.grid ? Math.floor(next / g.columns) : g.entries.findIndex((entry) => entry.kind === "row" && entry.bookmark.id === b.id);
    // A row header above the first of a group comes into view with it.
    virtualizer.scrollToIndex(!g.grid && row > 0 && g.entries[row - 1].kind === "header" && key === "ArrowUp" ? row - 1 : row, { align: "auto" });
    focusing.current = b.id;
    return b;
  };
  useEffect(() => () => void (arrowsRef.current = null), [arrowsRef]);
  useEffect(() => {
    const id = focusing.current;
    const element = id === null ? null : inner.current?.querySelector<HTMLElement>(`[data-bookmark-id="${id}"]`);
    if (!element) return;
    focusing.current = null;
    element.focus({ preventScroll: true });
  });

  const items = virtualizer.getVirtualItems();
  const last = items.at(-1)?.index ?? -1;
  const margin = grid ? 3 : 20;
  useEffect(() => {
    if (hasMore && !loadingMore && count > 0 && last >= count - 1 - margin) onMore();
  }, [hasMore, loadingMore, count, last, margin, onMore]);

  return (
    <div ref={box} data-view={view} data-loaded={bookmarks.length} data-dragging={dragging || undefined} data-has-selection={selected.size > 0 || undefined}>
      {/* What a selected card or row adds to its name for a screen reader (NP-123). */}
      <span id={SELECTED_NOTE} hidden>
        {t("card.selected")}
      </span>
      <div ref={inner} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {frame && (
          // Frame 04: accent fill 4 %, border accent 80 %.
          <div
            aria-hidden
            data-selection-frame
            className="pointer-events-none absolute z-10 border border-accent/80 bg-accent/4"
            style={{ left: frame.left, top: frame.top, width: frame.right - frame.left, height: frame.bottom - frame.top }}
          />
        )}
        {items.map((item) => {
          const style = { transform: `translateY(${item.start}px)` };
          if (grid) {
            const row = bookmarks.slice(item.index * columns, item.index * columns + columns);
            return (
              <div
                key={item.key}
                className="absolute top-0 left-0 grid w-full"
                style={{ ...style, height: cardHeight, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, columnGap: gapX }}
              >
                {row.map((b) => (
                  <BookmarkCard key={b.id} bookmark={b} collections={collections} actions={actions} selected={selected.has(b.id)} dense={dense} fresh={b.id === fresh} />
                ))}
              </div>
            );
          }
          const entry = entries[item.index];
          return (
            <div key={item.key} className="absolute top-0 left-0 w-full" style={style}>
              {entry.kind === "header" ? (
                <h3 className="flex h-[31px] items-center gap-2 pt-2.5 pr-2 pb-1.5 pl-2 text-xs">
                  <span className="font-semibold">{t(`groups.${entry.group}`)}</span>
                  <span className="text-subtle">{entry.size}</span>
                  <span aria-hidden className="h-px flex-1 bg-line" />
                </h3>
              ) : (
                <BookmarkRow
                  bookmark={entry.bookmark}
                  collections={collections}
                  actions={actions}
                  compact={compact}
                  selected={selected.has(entry.bookmark.id)}
                  fresh={entry.bookmark.id === fresh}
                />
              )}
            </div>
          );
        })}
      </div>
      {/* The list sits first in the scroll container, so it needs no scroll margin. */}
      <div className="flex h-12 items-center justify-center text-xs text-subtle">
        {loadingMore && <span role="status">{t("library.loadingMore")}</span>}
      </div>
    </div>
  );
}

