import { ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CheckCheck, Plus, Rss, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Bookmark, Feed, FeedItem } from "../../types";
import { api } from "../../services/api";
import { describeError } from "../../services/errors";
import { composing } from "../../services/ime";
import { keyIs } from "../../services/keys";
import { markFeedRead, refreshFeeds, saveFeedItem, setFeedItemsRead } from "../../services/feeds";
import { headerLine, healthLine, listTitle } from "../../services/feedsView";
import { ReaderLook } from "../../services/readerLook";
import { preference, savePreference } from "../../services/preferences";
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
 * listener with App's layer check: ↑/↓ J/K, Space or Enter, S R F O U, E (the card over the list),
 * ⇧A and ⌘R.
 */
/**
 * When the newest post of the feed shown (or of all feeds) arrived, as the page last
 * heard: «Mark all read» stops there. From the feeds, not the list, which a search
 * narrows and paging cuts short.
 */
const newestOf = (feeds: Feed[], feedUid: string | null) =>
  feeds
    .filter((f) => feedUid === null || f.uid === feedUid)
    .reduce<string | null>((max, f) => (f.newest_at && (max === null || f.newest_at > max) ? f.newest_at : max), null);

export type FeedShow = "unread" | "all";

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
  // Unread or All posts (2.17.0), kept like the library's view.
  const [show, setShow] = useState<FeedShow>(() => preference("feeds.show", ["unread", "all"], "all"));
  useEffect(() => savePreference("feeds.show", show), [show]);
  const { items, loaded, hasMore, loadMore } = useFeedItems(feedUid, searching ? search : "", feeds, show === "unread", itemId);
  const list = useRef<FeedListHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const sheetEl = useRef<HTMLElement>(null);
  const leavingEl = useRef<HTMLElement>(null);
  // The card laid over the list (E), and the card of the post just left while it flies off.
  const [expanded, setExpanded] = useState(false);
  // `previous`/`hasNext`: where the card left stood, so its ⌃ ⌄ stay as they were while it flies.
  const [leaving, setLeaving] = useState<{
    item: FeedItem;
    feed: Feed | undefined;
    bookmark: Bookmark | null;
    shift: number;
    previous: boolean;
    hasNext: boolean;
  } | null>(null);
  const selected = useMemo(() => items.find((item) => item.id === itemId) ?? null, [items, itemId]);
  const feed = useMemo(() => (selected ? feeds.find((f) => f.uid === selected.feed_uid) : undefined), [feeds, selected]);
  const shownFeed = feedUid ? feeds.find((f) => f.uid === feedUid) : undefined;

  // A new feed or search starts at the top, the open post stays open.
  useEffect(() => {
    setSearch("");
    setSearching(false);
  }, [feedUid]);

  // The saved post's bookmark: ✓, Reading and the heart of the toolbar follow it. It is kept
  // with the post it belongs to: another post open shows (and changes) nothing of it.
  const [held, setHeld] = useState<{ item: number; bookmark: Bookmark | null } | null>(null);
  const selectedId = selected?.id ?? null;
  const bookmark = held && held.item === selectedId ? held.bookmark : null;
  const bookmarkId = selected?.bookmark_id ?? null;
  const shownId = useRef(selectedId);
  shownId.current = selectedId;
  /**
   * Every read or save of the open post's bookmark gets a turn: an older answer arriving later
   * is dropped. One for a post no longer open takes no turn, or the open post's would be lost.
   */
  const bookmarkTurn = useRef(0);
  const holdBookmark = useCallback((item: number, found: Bookmark | null) => {
    if (shownId.current !== item) return;
    bookmarkTurn.current++;
    setHeld({ item, bookmark: found });
  }, []);
  const loadBookmark = useCallback(async (item: number, id: number | null) => {
    if (shownId.current !== item) return;
    const turn = ++bookmarkTurn.current;
    const found = id === null ? null : await api.getBookmarks({}, { id, limit: 1 }).then((page) => page.items[0] ?? null, () => null);
    if (turn === bookmarkTurn.current && shownId.current === item) setHeld({ item, bookmark: found });
  }, []);
  useEffect(() => {
    if (selectedId !== null) void loadBookmark(selectedId, bookmarkId);
  }, [loadBookmark, selectedId, bookmarkId, feeds]);

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
  // ⌄ or J on the last post loaded: the next page comes first, then the move (2.17.0).
  const moveOn = useRef(false);
  useEffect(() => {
    moveOn.current = false;
  }, [itemId, feedUid]);
  const move = (step: 1 | -1) => {
    if (!items.length) return;
    const index = selected ? items.indexOf(selected) : -1;
    if (step > 0 && index === items.length - 1 && hasMore) {
      moveOn.current = true;
      return loadMore();
    }
    const next = items[index < 0 ? (step > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, index + step))];
    if (!next || next.id === itemId) return;
    const fromList = document.activeElement instanceof HTMLElement && !!document.activeElement.closest("[data-feed-list]");
    // The card of the open post flies off and the next one takes its place: up when going on,
    // from where its card peeked below the end when it did; down when going back.
    const sheet = sheetEl.current;
    if (selected && sheet && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const box = sheet.getBoundingClientRect();
      const peek = sheet.querySelector("[data-feed-peek]")?.getBoundingClientRect();
      const shift = step > 0 && peek && peek.top < box.bottom ? peek.top - box.top - 1 : (box.height + 24) * step;
      setLeaving({ item: selected, feed, bookmark, shift, previous: index > 0, hasNext: index < items.length - 1 || hasMore });
    }
    onItem(next.id);
    list.current?.reveal(next.id, fromList);
  };
  useEffect(() => {
    if (!moveOn.current || !selected || items.indexOf(selected) >= items.length - 1) return;
    moveOn.current = false;
    move(1);
  }, [items]);
  const back = () => {
    if (narrow) onItem(null);
    else if (expanded) setExpanded(false);
    else if (selected) list.current?.reveal(selected.id, true);
  };

  // S, R and F: the post becomes a bookmark (`saveFeedItem`); R and F again take a saved one out.
  const save = async (kind: "library" | "reading" | "favorite") => {
    const item = selected;
    if (!item) return;
    if (!item.url) return onNotice({ text: t("feeds.notice.noLink"), alert: true });
    try {
      if (kind === "library" && item.bookmark_id !== null) return onNotice({ text: t("feeds.notice.alreadySaved") });
      // Only the bookmark of this very post: never one still held from the post open before.
      const own = held && held.item === item.id ? held.bookmark : null;
      if (kind === "reading" && own?.reading_at) {
        const { command } = await api.bulkUpdate([own.id], { action: "reading", reading: false });
        await loadBookmark(item.id, own.id);
        return onNotice({ text: t("notice.fromReading"), undo: onUndo(command) });
      }
      if (kind === "favorite" && own?.is_favorite) {
        const { command } = await api.bulkUpdate([own.id], { action: "favorite", favorite: false });
        await loadBookmark(item.id, own.id);
        return onNotice({ text: t("feeds.notice.unfavorited"), undo: onUndo(command) });
      }
      const result = await saveFeedItem(item.id, kind === "reading" ? "reading" : "library", kind === "favorite");
      const saved = result.bookmark;
      // A link already in the library comes back as it was (saving never overwrites what
      // the person set), so R and F still do what they say, as undoable bulk actions.
      let command = result.command;
      let topped = false;
      if (kind === "reading" && !saved.reading_at) {
        ({ command } = await api.bulkUpdate([saved.id], { action: "reading", reading: true }));
        topped = true;
      } else if (kind === "favorite" && !saved.is_favorite) {
        ({ command } = await api.bulkUpdate([saved.id], { action: "favorite", favorite: true }));
        topped = true;
      }
      if (topped) await loadBookmark(item.id, saved.id);
      else holdBookmark(item.id, saved);
      // «Undo» of a bookmark this save made takes it away; of a link brought back from the
      // Trash, or one moved to Reading or Favorites, it is the journal's; else there is none.
      const undo = result.created && !topped ? () => onUnsave(saved.id) : command !== null ? onUndo(command) : undefined;
      // A link that was in the library already, live, stays where it is: the notice says so.
      const there = !result.created && result.command === null && !topped;
      const text = there
        ? t("feeds.notice.alreadySaved")
        : kind === "reading"
          ? t("notice.toReading")
          : kind === "favorite"
            ? t("feeds.notice.favorited")
            : t("add.savedTo", { place: t("import.library") });
      onNotice({ text, undo, glass: result.created });
    } catch (err) {
      failed(err);
    }
  };
  const toggleRead = () => {
    if (selected) void setFeedItemsRead([selected.id], !selected.read).catch(failed);
  };
  // Up to the newest post the page knew of: one a check brought since stays new.
  const markAll = () =>
    void markFeedRead(feedUid, newestOf(feeds, feedUid)).then(
      (count) => onNotice({ text: count ? t("feeds.notice.markedRead", { count }) : t("feeds.notice.allRead") }),
      failed,
    );
  const refresh = () => void refreshFeeds(feedUid).catch(failed);

  const expand = () => {
    if (!narrow && selected) setExpanded(!expanded);
  };
  const keys = useRef({ move, select, save, toggleRead, markAll, refresh, back, expand, selected, items, onOpen, blocked });
  keys.current = { move, select, save, toggleRead, markAll, refresh, back, expand, selected, items, onOpen, blocked };
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
      else if (is("e") && !e.repeat) run(k.expand);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const failing = shownFeed ? !!healthLine(shownFeed, t, i18n.language) : false;
  const offline = (shownFeed ? [shownFeed] : feeds).some((f) => f.health.state === "offline");
  const status = headerLine(feeds, feedUid, { t, language: i18n.language, refreshing, ago: (iso) => relativeTime(iso, i18n.language) });
  const title = listTitle(feeds, feedUid, t);
  const shown = feeds.filter((f) => feedUid === null || f.uid === feedUid);
  const unread = shown.reduce((sum, f) => sum + f.unread, 0);
  // «Everything is read» only where there are posts: a feed not fetched yet has none to read.
  const allRead = show === "unread" && !(searching && search.trim()) && shown.some((f) => f.total > 0);
  const empty =
    feeds.length === 0 ? (
      <EmptyState icon={Rss} title={t("feeds.none.title")} text={t("feeds.none.text")}>
        <Button variant="primary" onClick={onNewLink} className="mt-1">
          <Icon icon={Plus} size={14} />
          {t("sidebar.newLink")}
        </Button>
      </EmptyState>
    ) : allRead ? (
      <EmptyState icon={CheckCheck} title={t("feeds.notice.allRead")} data-feed-all-read>
        <Button onClick={() => setShow("all")} className="mt-1">
          {t("feeds.showAll")}
        </Button>
      </EmptyState>
    ) : (
      <p className="px-[18px] py-10 text-center text-sm text-muted">
        {searching && search.trim() ? t("feeds.noMatch", { query: search.trim() }) : t("feeds.empty")}
      </p>
    );

  const showList = !narrow || !selected;
  const showSheet = !narrow || !!selected;
  const index = selected ? items.indexOf(selected) : -1;
  const next = index >= 0 ? (items[index + 1] ?? null) : null;
  const wide = expanded && !narrow && !!selected;
  const sheetProps = {
    look,
    aa,
    narrow,
    expanded: wide,
    nextFeed: next ? feeds.find((f) => f.uid === next.feed_uid) : undefined,
    onBack: back,
    onExpand: expand,
    onNext: () => move(1),
    onSave: () => void save("library"),
    onReading: () => void save("reading"),
    onFavorite: () => void save("favorite"),
    onOpen,
    onFeed: (uid: string) => onFeed(uid),
  };

  // The swap: the card left flies up by where the next one peeked (or a whole card), the new one
  // rises from there; reduced motion swaps at once.
  useLayoutEffect(() => {
    if (!leaving) return;
    const old = leavingEl.current;
    const now = sheetEl.current;
    if (!old || !now) return setLeaving(null);
    const timing: KeyframeAnimationOptions = { duration: 460, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };
    old.animate([{ transform: "none" }, { transform: `translateY(${-leaving.shift}px)` }], { ...timing, fill: "forwards" });
    const rise = now.animate([{ transform: `translateY(${leaving.shift}px)` }, { transform: "none" }], timing);
    rise.onfinish = () => setLeaving(null);
    return () => rise.cancel();
  }, [leaving]);
  return (
    <div data-feeds-page data-drop-area className="flex min-h-0 flex-1">
      {showList && (
        <div
          data-feed-slot
          className={`flex min-h-0 overflow-hidden transition-[width] duration-300 ease-[var(--ease-standard)] motion-reduce:transition-none ${narrow ? "flex-1" : wide ? "w-0" : "w-[380px] shrink-0"}`}
        >
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
          show={show}
          onShow={setShow}
          onMarkAll={unread > 0 ? markAll : undefined}
          listRef={list}
          empty={empty}
          narrow={narrow}
        />
        </div>
      )}
      {showSheet && (
        // One card per post, keyed by it: the card just left keeps its place in the text while it flies off.
        <div data-feed-stage className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {leaving && leaving.item.id !== selected?.id && (
            <FeedArticleSheet
              key={leaving.item.id}
              {...sheetProps}
              item={leaving.item}
              feed={leaving.feed}
              bookmark={leaving.bookmark}
              next={selected}
              nextFeed={feed}
              onPrevious={leaving.previous ? () => {} : undefined}
              hasNext={leaving.hasNext}
              sheetRef={leavingEl}
              className="pointer-events-none absolute inset-0"
            />
          )}
          {/* Over the card left: it rises with its own toolbar where that card's peek was. */}
          <FeedArticleSheet
            key={selected?.id ?? "none"}
            {...sheetProps}
            item={selected}
            feed={feed}
            bookmark={bookmark}
            next={next}
            onPrevious={index > 0 ? () => move(-1) : undefined}
            hasNext={index >= 0 && (index < items.length - 1 || hasMore)}
            scrollerRef={scroller}
            sheetRef={sheetEl}
            className="relative z-10"
          />
        </div>
      )}
    </div>
  );
}

/** What the list says with no posts: an icon in a circle, a title, a line and an action. */
function EmptyState({
  icon,
  title,
  text,
  children,
  ...rest
}: { icon: LucideIcon; title: string; text?: string; children: ReactNode } & { "data-feed-all-read"?: boolean }) {
  return (
    <div {...rest} className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-secondary text-icon">
        <Icon icon={icon} size={20} />
      </span>
      <h2 className="text-xl font-semibold">{title}</h2>
      {text && <p className="text-sm text-muted">{text}</p>}
      {children}
    </div>
  );
}
