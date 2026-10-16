import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Rss } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Bookmark, Feed, FeedItem } from "../../types";
import { api } from "../../services/api";
import { describeError } from "../../services/errors";
import { composing } from "../../services/ime";
import { keyIs } from "../../services/keys";
import { markFeedRead, refreshFeeds, saveFeedItem, setFeedItemsRead } from "../../services/feeds";
import { headerLine, healthLine, listTitle } from "../../services/feedsView";
import { ReaderLook } from "../../services/readerLook";
import { Icon } from "../icons";
import { Button } from "../ui/Button";
import { relativeTime } from "../../services/relativeTime";
import { useFeedItems } from "./useFeeds";
import { FeedList, FeedListHandle } from "./FeedList";
import { AaProps, FeedArticleSheet } from "./FeedArticle";

/** Opening a post marks it read after this long (NP-132). */
const READ_AFTER_MS = 1000;

export interface FeedNotice {
  text: string;
  alert?: boolean;
  undo?: () => void;
  /** The glass notice of a link saved by hand: «Undo» takes the new bookmark away again. */
  glass?: boolean;
}

/**
 * The Feeds page (NP-132, Lunacy frame «RSS · Three columns · Light»): the list column 380 wide
 * and the article sheet beside it; in a narrow window one at a time. Its keys are its own window
 * listener with App's layer check: ↑/↓ J/K, Space or Enter, S R F O U, ⇧A and ⌘R.
 */
/** A bookmark this save made: from a feed, a moment ago (a link saved before keeps its own source and age). */
const madeJustNow = (bookmark: Bookmark) => bookmark.source === "feed" && Date.now() - Date.parse(bookmark.created_at) < 60_000;

export function FeedsPage({
  feeds,
  refreshing,
  feedUid,
  itemId,
  onFeed,
  onItem,
  narrow,
  blocked,
  look,
  aa,
  onOpen,
  onNotice,
  onUnsave,
  onUndo,
  onNewLink,
}: {
  feeds: Feed[];
  refreshing: boolean;
  feedUid: string | null;
  itemId: number | null;
  onFeed: (uid: string | null) => void;
  onItem: (id: number | null) => void;
  narrow: boolean;
  /** A dialog, the editor or another layer is over the page: its keys wait. */
  blocked: boolean;
  look: ReaderLook;
  aa: AaProps;
  onOpen: (url: string) => void;
  onNotice: (notice: FeedNotice) => void;
  /** «Undo» of a post saved just now: the new bookmark goes again. */
  onUnsave: (bookmarkId: number) => void;
  /** «Undo» of a journal command (Reading, Favorites). */
  onUndo: (command: number | null) => (() => void) | undefined;
  onNewLink: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState("");
  const { items, loaded, hasMore, loadMore } = useFeedItems(feedUid, searching ? search : "", feeds);
  const list = useRef<FeedListHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const selected = useMemo(() => items.find((item) => item.id === itemId) ?? null, [items, itemId]);
  const feed = useMemo(() => (selected ? feeds.find((f) => f.uid === selected.feed_uid) : undefined), [feeds, selected]);
  const shownFeed = feedUid ? feeds.find((f) => f.uid === feedUid) : undefined;

  // A new feed or search starts at the top, the open post stays open.
  useEffect(() => {
    setSearch("");
    setSearching(false);
  }, [feedUid]);

  // The saved post's bookmark: ✓, Reading and the heart of the toolbar follow it.
  const [bookmark, setBookmark] = useState<Bookmark | null>(null);
  const bookmarkId = selected?.bookmark_id ?? null;
  const loadBookmark = useCallback(() => {
    if (bookmarkId === null) return Promise.resolve(setBookmark(null));
    return api.getBookmarks({}, { id: bookmarkId, limit: 1 }).then(
      (page) => setBookmark(page.items[0] ?? null),
      () => setBookmark(null),
    );
  }, [bookmarkId]);
  useEffect(() => {
    void loadBookmark();
  }, [loadBookmark, feeds]);

  // Opening a post marks it read after a second; U takes it back.
  const latest = useRef(items);
  latest.current = items;
  useEffect(() => {
    if (itemId === null) return;
    const timer = window.setTimeout(() => {
      const item = latest.current.find((i) => i.id === itemId);
      if (item && !item.read) void setFeedItemsRead([item.id], true).catch(() => {});
    }, READ_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [itemId]);

  const failed = (err: unknown) => onNotice({ text: describeError(err), alert: true });
  const select = (item: FeedItem, focusArticle: boolean) => {
    onItem(item.id);
    if (focusArticle) requestAnimationFrame(() => scroller.current?.focus({ preventScroll: true }));
  };
  const move = (step: 1 | -1) => {
    if (!items.length) return;
    const index = selected ? items.indexOf(selected) : -1;
    const next = items[index < 0 ? (step > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, index + step))];
    if (!next || next.id === itemId) return;
    const fromList = document.activeElement instanceof HTMLElement && !!document.activeElement.closest("[data-feed-list]");
    onItem(next.id);
    list.current?.reveal(next.id, fromList);
    scroller.current?.scrollTo({ top: 0 });
  };
  const back = () => {
    if (narrow) onItem(null);
    else if (selected) list.current?.reveal(selected.id, true);
  };

  // S, R and F: the post becomes a bookmark (`saveFeedItem`); R and F again take a saved one out.
  const save = async (kind: "library" | "reading" | "favorite") => {
    const item = selected;
    if (!item) return;
    if (!item.url) return onNotice({ text: t("feeds.notice.noLink"), alert: true });
    try {
      if (kind === "library" && item.bookmark_id !== null) return onNotice({ text: t("feeds.notice.alreadySaved") });
      if (kind === "reading" && bookmark?.reading_at) {
        const { command } = await api.bulkUpdate([bookmark.id], { action: "reading", reading: false });
        await loadBookmark();
        return onNotice({ text: t("notice.fromReading"), undo: onUndo(command) });
      }
      if (kind === "favorite" && bookmark?.is_favorite) {
        const { command } = await api.bulkUpdate([bookmark.id], { action: "favorite", favorite: false });
        await loadBookmark();
        return onNotice({ text: t("feeds.notice.unfavorited"), undo: onUndo(command) });
      }
      const saved = await saveFeedItem(item.id, kind === "reading" ? "reading" : "library", kind === "favorite");
      // A link already in the library comes back as it was (saving never overwrites what
      // the person set), so R and F still do what they say, as undoable bulk actions.
      let command: number | null = null;
      if (kind === "reading" && !saved.reading_at)
        ({ command } = await api.bulkUpdate([saved.id], { action: "reading", reading: true }));
      else if (kind === "favorite" && !saved.is_favorite)
        ({ command } = await api.bulkUpdate([saved.id], { action: "favorite", favorite: true }));
      // «Undo» takes away only a bookmark this save made, never one that was there before.
      const fresh = item.bookmark_id === null && command === null && madeJustNow(saved);
      if (command === null) setBookmark(saved);
      else await loadBookmark();
      const text = kind === "reading" ? t("notice.toReading") : kind === "favorite" ? t("feeds.notice.favorited") : t("add.savedTo", { place: t("import.library") });
      onNotice({ text, undo: fresh ? () => onUnsave(saved.id) : command !== null ? onUndo(command) : undefined, glass: fresh });
    } catch (err) {
      failed(err);
    }
  };
  const toggleRead = () => {
    if (selected) void setFeedItemsRead([selected.id], !selected.read).catch(failed);
  };
  const markAll = () =>
    void markFeedRead(feedUid).then(
      (count) => onNotice({ text: count ? t("feeds.notice.markedRead", { count }) : t("feeds.notice.allRead") }),
      failed,
    );
  const refresh = () => void refreshFeeds(feedUid).catch(failed);

  const keys = useRef({ move, select, save, toggleRead, markAll, refresh, back, selected, items, onOpen, blocked });
  keys.current = { move, select, save, toggleRead, markAll, refresh, back, selected, items, onOpen, blocked };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const k = keys.current;
      // The same layer check as App's: a dialog or a menu over the page keeps its keys.
      if (composing(e) || k.blocked || document.querySelector("dialog[open], [data-menu]")) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const typing = !!target?.closest("input, textarea, select, [contenteditable=true]");
      // By the key's place too: J on a Russian layout types «о» (reading mode does the same).
      const is = (letter: string) => keyIs(e, letter);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && is("r")) {
        e.preventDefault();
        k.refresh();
        return;
      }
      if (typing || mod || e.altKey) return;
      const inArticle = !!target?.closest("[data-feed-scroll]");
      const own = !!target?.closest("button, a, [role=menuitem]");
      const run = (action: () => void) => {
        e.preventDefault();
        action();
      };
      if (e.shiftKey) {
        if (is("a")) run(k.markAll);
        return;
      }
      if (is("j") || (e.key === "ArrowDown" && !inArticle)) run(() => k.move(1));
      else if (is("k") || (e.key === "ArrowUp" && !inArticle)) run(() => k.move(-1));
      else if ((e.key === " " || e.key === "Enter") && !inArticle && !own)
        run(() => (k.selected ? scroller.current?.focus({ preventScroll: true }) : k.items[0] && k.select(k.items[0], true)));
      else if (e.key === "Escape" && inArticle) run(k.back);
      else if (is("s") && !e.repeat) run(() => void k.save("library"));
      else if (is("r") && !e.repeat) run(() => void k.save("reading"));
      else if (is("f") && !e.repeat) run(() => void k.save("favorite"));
      else if (is("o") && k.selected?.url) run(() => k.onOpen(k.selected!.url!));
      else if (is("u") && !e.repeat) run(k.toggleRead);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const failing = shownFeed ? !!healthLine(shownFeed, t, i18n.language) : false;
  const offline = (shownFeed ? [shownFeed] : feeds).some((f) => f.health.state === "offline");
  const status = headerLine(feeds, feedUid, { t, language: i18n.language, refreshing, ago: (iso) => relativeTime(iso, i18n.language) });
  const title = listTitle(feeds, feedUid, t);
  const empty =
    feeds.length === 0 ? (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-secondary text-icon">
          <Icon icon={Rss} size={20} />
        </span>
        <h2 className="text-xl font-semibold">{t("feeds.none.title")}</h2>
        <p className="text-sm text-muted">{t("feeds.none.text")}</p>
        <Button variant="primary" onClick={onNewLink} className="mt-1">
          <Icon icon={Plus} size={14} />
          {t("sidebar.newLink")}
        </Button>
      </div>
    ) : (
      <p className="px-[18px] py-10 text-center text-sm text-muted">
        {searching && search.trim() ? t("feeds.noMatch", { query: search.trim() }) : t("feeds.empty")}
      </p>
    );

  const showList = !narrow || !selected;
  const showSheet = !narrow || !!selected;
  return (
    <div data-feeds-page className="flex min-h-0 flex-1">
      {showList && (
        <FeedList
          feeds={feeds}
          items={items}
          loaded={loaded}
          hasMore={hasMore}
          onMore={loadMore}
          selected={itemId}
          onSelect={select}
          title={title}
          status={status}
          statusAlert={failing || offline}
          refreshing={refreshing}
          onRefresh={refresh}
          searching={searching}
          search={search}
          onSearching={(on) => {
            setSearching(on);
            if (!on) setSearch("");
          }}
          onSearch={setSearch}
          listRef={list}
          empty={empty}
          narrow={narrow}
        />
      )}
      {showSheet && (
        <FeedArticleSheet
          item={selected}
          feed={feed}
          bookmark={bookmark}
          look={look}
          aa={aa}
          narrow={narrow}
          scrollerRef={scroller}
          onBack={back}
          onSave={() => void save("library")}
          onReading={() => void save("reading")}
          onFavorite={() => void save("favorite")}
          onOpen={onOpen}
          onFeed={(uid) => onFeed(uid)}
        />
      )}
    </div>
  );
}
