import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { entryStarts, type ShelfEntry, shelvesOf } from "./shelfEntries";

/** How far below the screen rows are drawn ahead, in rows; the grid's rows are taller. */
const OVERSCAN = { list: 6, grid: 2 };
/** The next page is asked for this many entries before the end (the desktop's margins). */
const MORE_MARGIN = { list: 20, grid: 3 };

/**
 * A virtualized list of shelves inside a phone screen (NP-072b): only the entries near the screen
 * are in the DOM, at fixed sizes ({@link ShelfEntry}); each section's shelf is one paper with one
 * shadow drawn under its rows, not one per row. It scrolls with the screen (`scrollElement`) below
 * whatever the screen shows above it. Reaching the end asks for the next page (`onMore`).
 */
export function ShelfList<T>({
  entries,
  scrollElement,
  renderLabel,
  renderRow,
  renderCards,
  hasMore = false,
  loadingMore = false,
  onMore,
  footer,
}: {
  entries: ShelfEntry<T>[];
  scrollElement: HTMLElement | null;
  renderLabel: (group: string) => ReactNode;
  renderRow: (item: T, entry: Extract<ShelfEntry<T>, { kind: "row" }>) => ReactNode;
  renderCards?: (entry: Extract<ShelfEntry<T>, { kind: "cards" }>) => ReactNode;
  hasMore?: boolean;
  loadingMore?: boolean;
  onMore?: () => void;
  /** Under the last entry: "Loading more…". */
  footer?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const margin = useScrollMargin(box, scrollElement);
  const starts = useMemo(() => entryStarts(entries), [entries]);
  const shelves = useMemo(() => shelvesOf(entries as ShelfEntry<unknown>[], starts), [entries, starts]);
  const grid = entries.some((e) => e.kind === "cards");

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollElement,
    estimateSize: (i) => entries[i]?.size ?? 0,
    getItemKey: (i) => entries[i]?.key ?? i,
    scrollMargin: margin,
    overscan: grid ? OVERSCAN.grid : OVERSCAN.list,
  });
  // Sizes are computed, not measured: lay out again when they change.
  useEffect(() => virtualizer.measure(), [virtualizer, entries]);

  const items = virtualizer.getVirtualItems();
  const last = items.at(-1)?.index ?? -1;
  const ahead = grid ? MORE_MARGIN.grid : MORE_MARGIN.list;
  useEffect(() => {
    if (onMore && hasMore && !loadingMore && entries.length > 0 && last >= entries.length - 1 - ahead) onMore();
  }, [onMore, hasMore, loadingMore, entries.length, last, ahead]);

  const total = starts.length ? starts[starts.length - 1] + entries[entries.length - 1].size : 0;
  const top = items.length ? items[0].start - margin : 0;
  const bottom = items.length ? items[items.length - 1].end - margin : 0;
  return (
    <div ref={box} className="lib-list" data-entries={entries.length}>
      <div className="lib-list-inner" style={{ height: total }}>
        {shelves
          .filter((s) => s.top < bottom && s.top + s.height > top)
          .map((s) => (
            <div key={`s${s.section}`} className="lib-shelf" aria-hidden="true" style={{ transform: `translateY(${s.top}px)`, height: s.height }} />
          ))}
        {items.map((item) => {
          const entry = entries[item.index];
          if (!entry) return null;
          return (
            <div key={item.key} className="lib-entry" data-kind={entry.kind} style={{ transform: `translateY(${item.start - margin}px)`, height: entry.size }}>
              {entry.kind === "label"
                ? entry.label && renderLabel(entry.group)
                : entry.kind === "row"
                  ? renderRow(entry.item, entry)
                  : renderCards?.(entry)}
            </div>
          );
        })}
      </div>
      {footer}
    </div>
  );
}

/**
 * Where the list starts in its scrolling screen: the header, the search row and the chips are
 * above it, and grow with the text size and the fonts.
 */
function useScrollMargin(box: React.RefObject<HTMLDivElement | null>, scrollElement: HTMLElement | null) {
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !scrollElement) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop;
      setMargin((now) => (Math.abs(now - top) < 0.5 ? now : top));
    };
    measure();
    // What is above the list changes its place; the list itself changes nothing above it.
    const observer = new ResizeObserver(measure);
    for (let sibling = el.previousElementSibling; sibling; sibling = sibling.previousElementSibling) observer.observe(sibling);
    return () => observer.disconnect();
  }, [box, scrollElement]);
  return margin;
}
