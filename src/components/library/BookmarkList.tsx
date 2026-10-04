import { RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { Bookmark, Collection, ViewMode } from "../../types";
import { DateGroup, groupOf } from "../../services/dateGroups";
import { listTime } from "../../services/library";
import { BookmarkActions, BookmarkCard, BookmarkRow, CARD_TEXT_HEIGHT, ROW_HEIGHT } from "./Bookmarks";

/** Grid of frames 01 and 16: gaps 24 and 28 px, cards at least 240 px (190 px in a narrow window). */
const GAP_X = 24;
const GAP_Y = 28;
const MIN_CARD = { wide: 240, narrow: 190 };
/** List of frame 02: group header 31 px, rows 60 px, 2 px between them. */
const HEADER_HEIGHT = 31;
const LIST_GAP = 2;

type ListEntry = { kind: "header"; group: DateGroup; size: number } | { kind: "row"; bookmark: Bookmark };

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
  hasMore,
  loadingMore,
  onMore,
}: {
  view: ViewMode;
  bookmarks: Bookmark[];
  collections: Collection[];
  actions: BookmarkActions;
  narrow: boolean;
  compact: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  dateGroups: { starts: string[]; sizes: Record<DateGroup, number> | null };
  hasMore: boolean;
  loadingMore: boolean;
  onMore: () => void;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);

  const minCard = narrow ? MIN_CARD.narrow : MIN_CARD.wide;
  const columns = Math.max(1, Math.floor((width + GAP_X) / (minCard + GAP_X)));
  const cardWidth = (width - GAP_X * (columns - 1)) / columns;
  const cardHeight = Math.round((cardWidth * 10) / 16) + CARD_TEXT_HEIGHT;

  const entries = useMemo<ListEntry[]>(() => {
    if (view !== "list") return [];
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
  }, [view, bookmarks, dateGroups]);

  const grid = view === "grid";
  const count = grid ? Math.ceil(bookmarks.length / columns) : entries.length;
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      grid ? cardHeight + GAP_Y : (entries[index]?.kind === "header" ? HEADER_HEIGHT : ROW_HEIGHT) + LIST_GAP,
    getItemKey: (index) => {
      if (grid) return `r${index}`;
      const entry = entries[index];
      return entry?.kind === "header" ? `g-${entry.group}` : (entry?.bookmark.id ?? index);
    },
    overscan: grid ? 2 : 8,
  });
  // Sizes are computed, not measured: recompute when they change.
  useEffect(() => virtualizer.measure(), [virtualizer, grid, cardHeight, entries]);

  const items = virtualizer.getVirtualItems();
  const last = items.at(-1)?.index ?? -1;
  const margin = grid ? 3 : 20;
  useEffect(() => {
    if (hasMore && !loadingMore && count > 0 && last >= count - 1 - margin) onMore();
  }, [hasMore, loadingMore, count, last, margin, onMore]);

  return (
    <div ref={box} data-view={view} data-loaded={bookmarks.length}>
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const style = { transform: `translateY(${item.start}px)` };
          if (grid) {
            const row = bookmarks.slice(item.index * columns, item.index * columns + columns);
            return (
              <div
                key={item.key}
                className="absolute top-0 left-0 grid w-full"
                style={{ ...style, height: cardHeight, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, columnGap: GAP_X }}
              >
                {row.map((b) => (
                  <BookmarkCard key={b.id} bookmark={b} collections={collections} actions={actions} />
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
                <BookmarkRow bookmark={entry.bookmark} collections={collections} actions={actions} compact={compact} />
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

