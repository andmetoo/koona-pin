import { KeyboardEvent, ReactNode, Ref, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CheckCheck, RotateCw, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Feed, FeedItem } from "../../types";
import { feedName } from "../../services/feeds";
import { dayGroups, dayLabel, postAge } from "../../services/feedsView";
import { usePicture } from "../../hooks/usePicture";
import { shiftShortcut, shortcut } from "../../services/keys";
import { Icon } from "../icons";
import { Hint } from "../ui/Hint";
import { FeedIcon } from "./FeedIcon";
import type { FeedShow } from "./FeedsPage";

/** The frame's rhythm (NP-132): rows 158 apart, a day label 22 high. */
export const ROW = 158;
const DAY = 22;
/**
 * What a picture adds to a row's guess before it is measured (2.17.0): 12 + 187 (16:9 of the
 * 332 px column) + 12 below the text, less the 23 px a row without one keeps under its excerpt.
 */
const PICTURE = 188;

export interface FeedListHandle {
  /** Brings the post's row into view; `focus` also moves the focus to it once drawn. */
  reveal: (id: number, focus: boolean) => void;
}

/**
 * The list column (NP-132, frame «RSS · Three columns»): the title, ✓✓ Mark all read, ↻ and the
 * search toggle; the status line and Unread | All (2.17.0); then the posts by day, virtualised
 * like the library list, each row measured since pictures make them taller.
 */
export function FeedList({
  feeds,
  items,
  loaded,
  hasMore,
  onMore,
  selected,
  onSelect,
  title,
  status,
  statusAlert,
  refreshing,
  onRefresh,
  searching,
  search,
  onSearching,
  onSearch,
  show,
  onShow,
  onMarkAll,
  listRef,
  empty,
  narrow,
}: {
  feeds: Feed[];
  items: FeedItem[];
  loaded: boolean;
  hasMore: boolean;
  onMore: () => void;
  selected: number | null;
  /** A click or Enter on a row: the post opens in the sheet. */
  onSelect: (item: FeedItem, focusArticle: boolean) => void;
  title: string;
  status: string;
  /** The status line says something is wrong: offline or not updating. */
  statusAlert: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  searching: boolean;
  search: string;
  onSearching: (on: boolean) => void;
  onSearch: (value: string) => void;
  show: FeedShow;
  onShow: (show: FeedShow) => void;
  /** Absent when nothing shown is unread. */
  onMarkAll?: () => void;
  listRef: Ref<FeedListHandle>;
  /** What the list says with no posts. */
  empty: ReactNode;
  narrow: boolean;
}) {
  const { t, i18n } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const entries = useMemo(() => dayGroups(items), [items]);
  const byUid = useMemo(() => new Map(feeds.map((f) => [f.uid, f])), [feeds]);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => {
      const entry = entries[index];
      return entry?.kind === "day" ? DAY : entry?.item.thumbnail_url ? ROW + PICTURE : ROW;
    },
    getItemKey: (index) => {
      const entry = entries[index];
      return entry?.kind === "day" ? `d-${entry.key}` : (entry?.item.id ?? index);
    },
    overscan: 6,
  });
  // Rows are measured as drawn (2.17.0: pictures make them taller) and kept by key, so a reload
  // after a read mark keeps them; no `measure()` that would set them all back to the guess.

  const focusing = useRef<number | null>(null);
  useImperativeHandle(listRef, () => ({
    reveal: (id, focus) => {
      const index = entries.findIndex((entry) => entry.kind === "post" && entry.item.id === id);
      if (index < 0) return;
      // A day label above the first post of its day comes into view with it.
      virtualizer.scrollToIndex(index > 0 && entries[index - 1].kind === "day" ? index - 1 : index, { align: "auto" });
      if (focus) focusing.current = id;
    },
  }));
  useEffect(() => {
    const id = focusing.current;
    const row = id === null ? null : scroller.current?.querySelector<HTMLElement>(`[data-feed-item="${id}"]`);
    if (!row) return;
    focusing.current = null;
    row.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (searching) searchField.current?.focus();
  }, [searching]);

  const virtual = virtualizer.getVirtualItems();
  const last = virtual.at(-1)?.index ?? -1;
  useEffect(() => {
    if (hasMore && entries.length > 0 && last >= entries.length - 6) onMore();
  }, [hasMore, entries.length, last, onMore]);

  const rowKeys = (item: FeedItem) => (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(item, true);
  };

  return (
    <section aria-label={title} data-feed-list className={`flex min-h-0 flex-col ${narrow ? "flex-1" : "w-[380px] shrink-0"}`}>
      <header data-drop-head className="mb-3 shrink-0 pt-[22px] pr-5 pl-[26px]">
        <div className="flex items-start gap-2">
          <h1 className="min-w-0 flex-1 truncate text-[26px] leading-[30px] font-bold tracking-[-0.01em]">{title}</h1>
          <div className="flex shrink-0 items-center gap-1">
            <Hint label={t("feeds.menu.markRead")} keys={shiftShortcut("A")}>
              <button
                type="button"
                aria-label={t("feeds.menu.markRead")}
                aria-keyshortcuts="Shift+A"
                onClick={onMarkAll}
                disabled={!onMarkAll}
                className="flex size-[30px] items-center justify-center rounded-full text-icon transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-45 disabled:hover:bg-transparent"
              >
                <Icon icon={CheckCheck} size={15} />
              </button>
            </Hint>
            <Hint label={t("feeds.refresh")} keys={shortcut("R")}>
              <button
                type="button"
                aria-label={t("feeds.refresh")}
                aria-keyshortcuts="Control+R Meta+R"
                onClick={onRefresh}
                disabled={refreshing}
                className="flex size-[30px] items-center justify-center rounded-full text-icon transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-60"
              >
                <Icon icon={RotateCw} size={15} className={refreshing ? "animate-spin" : ""} />
              </button>
            </Hint>
            <Hint label={t("feeds.search")} align="end">
              <button
                type="button"
                aria-label={t("feeds.search")}
                aria-pressed={searching}
                onClick={() => onSearching(!searching)}
                className={`flex size-[30px] items-center justify-center rounded-full transition-colors duration-150 hover:bg-hover hover:text-ink ${searching ? "bg-hover text-ink" : "text-icon"}`}
              >
                <Icon icon={Search} size={15} />
              </button>
            </Hint>
          </div>
        </div>
        <div className="mt-1 flex h-6 items-center gap-2">
          <p data-feed-status className={`min-w-0 flex-1 truncate text-xs leading-[15px] ${statusAlert ? "text-on-amber-soft dark:text-amber" : "text-subtle"}`}>
            {status}
          </p>
          {/* The library's view switch in small (2.17.0). */}
          <div role="group" aria-label={t("feeds.show")} className="flex shrink-0 gap-0.5 rounded-[9px] bg-well p-0.5">
            {(["unread", "all"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={show === value}
                onClick={() => onShow(value)}
                className={`h-5 rounded-[7px] px-2 text-xs font-medium transition-[background-color,color,box-shadow] duration-150 ${show === value ? "bg-raised text-ink shadow-segment" : "text-subtle hover:text-ink"}`}
              >
                {value === "unread" ? t("feeds.unread") : t("feeds.allPosts")}
              </button>
            ))}
          </div>
        </div>
      </header>
      {searching && (
        <div className="-mt-2.5 mb-3 shrink-0 px-[18px]">
          <div className="flex h-8 items-center gap-2 rounded-[9px] border border-border bg-card px-2.5">
            <Icon icon={Search} size={14} className="shrink-0 text-subtle" />
            <input
              ref={searchField}
              type="search"
              value={search}
              aria-label={t("feeds.search")}
              placeholder={t("feeds.searchPlaceholder")}
              onChange={(e) => onSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                e.stopPropagation();
                if (search) onSearch("");
                else onSearching(false);
              }}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle [&::-webkit-search-cancel-button]:hidden"
            />
            {search && (
              <button type="button" aria-label={t("feeds.clearSearch")} onClick={() => onSearch("")} className="text-subtle hover:text-ink">
                <Icon icon={X} size={13} />
              </button>
            )}
          </div>
        </div>
      )}
      <div ref={scroller} data-feed-scroller className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        {loaded && items.length === 0 ? (
          empty
        ) : (
          <div role="listbox" aria-label={title} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtual.map((row) => {
              const entry = entries[row.index];
              const style = { transform: `translateY(${row.start}px)` };
              if (entry.kind === "day")
                return (
                  <div key={row.key} ref={virtualizer.measureElement} data-index={row.index} role="presentation" className="absolute top-0 left-0 w-full" style={style}>
                    <h2 className="h-[22px] px-[18px] pt-1 text-2xs font-semibold tracking-[0.08em] uppercase text-subtle">{dayLabel(entry, t, i18n.language)}</h2>
                  </div>
                );
              const item = entry.item;
              const first = row.index > 0 && entries[row.index - 1].kind === "day";
              return (
                <div key={row.key} ref={virtualizer.measureElement} data-index={row.index} role="presentation" className="absolute top-0 left-0 w-full pb-2" style={style}>
                  <FeedItemRow
                    item={item}
                    feed={byUid.get(item.feed_uid)}
                    selected={item.id === selected}
                    hairline={!first && item.id !== selected}
                    language={i18n.language}
                    onClick={() => onSelect(item, false)}
                    onKeyDown={rowKeys(item)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * A post (NP-132): a round 34 px avatar, the feed in bold, the author and the age; the title
 * (2 lines) and excerpt (3 lines), then the picture across the row at 16:9 (2.17.0: a square
 * thumbnail cut off the words in pictures of text); none when the post has none or it fails. Unread has an ink dot left of the
 * avatar; read is muted. The selected row is raised; the others are split by hairlines that
 * start after the avatar.
 */
function FeedItemRow({
  item,
  feed,
  selected,
  hairline,
  language,
  onClick,
  onKeyDown,
}: {
  item: FeedItem;
  feed: Feed | undefined;
  selected: boolean;
  hairline: boolean;
  language: string;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
}) {
  const { t } = useTranslation();
  // The local copy, then the post's address (NP-146); none once both failed.
  const thumbnail = usePicture("post-thumb", item.id, item.thumbnail_url);
  const name = feed ? feedName(feed) : "";
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-feed-item={item.id}
      data-read={item.read || undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={`feed-row relative rounded-[14px] pt-3 pr-3 pl-3 ${thumbnail.src ? "pb-3" : "h-[150px]"} transition-[background-color,box-shadow] duration-150 ${selected ? "bg-raised shadow-[0_10px_24px_-16px_rgb(0_0_0/0.15),0_0_0_1px_var(--np-raised-edge)]" : "hover:bg-hover"}`}
    >
      {hairline && <span aria-hidden className="absolute -top-px right-3 left-14 h-px bg-line" />}
      {!item.read && <span aria-label={t("feeds.unread")} className="absolute top-[22px] left-1 size-1.5 rounded-full bg-ink" />}
      <div className="flex gap-2.5">
        {feed ? <FeedIcon feed={feed} size={34} round /> : <span className="size-[34px] shrink-0 rounded-full bg-well" />}
        <div className="min-w-0 flex-1">
          <div className="flex h-4 items-baseline gap-2 whitespace-nowrap">
            <span className={`min-w-0 shrink truncate text-sm leading-4 font-semibold ${item.read ? "text-muted" : "text-ink"}`}>{name}</span>
            {item.author && <span className="min-w-0 flex-1 truncate text-xs text-meta">{item.author}</span>}
            {!item.author && <span className="flex-1" />}
            <span className="shrink-0 text-[11.5px] text-subtle">
              {postAge(item.published_at ?? item.fetched_at, language)}
              {item.bookmark_id !== null && <span data-feed-saved> · {t("feeds.saved")}</span>}
            </span>
          </div>
          <div className="mt-1.5">
            <h3 className={`line-clamp-2 text-md leading-[19px] font-semibold [overflow-wrap:anywhere] ${item.read ? "text-muted" : "text-ink"}`}>{item.title}</h3>
            <p className={`mt-1 line-clamp-3 text-[12.5px] leading-[17px] [overflow-wrap:anywhere] ${item.read ? "text-subtle" : "text-muted"}`}>{item.excerpt}</p>
          </div>
        </div>
      </div>
      {thumbnail.src && (
        <img
          src={thumbnail.src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={thumbnail.onError}
          onLoad={thumbnail.onLoad}
          data-feed-picture
          className={`mt-3 aspect-video w-full rounded-[14px] bg-well object-cover ${item.read ? "opacity-70" : ""}`}
        />
      )}
    </div>
  );
}
