import "./FeedsScreen.css";
import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { BookmarkCheck, Plus, RefreshCw, Rss } from "lucide-react";
import { usePhone } from "../PhoneContext";
import { rememberPosts, usePosts, withKept } from "../feeds/posts";
import { Button, CircleButton } from "../ui/buttons";
import { Chip, Segmented } from "../ui/controls";
import { PhIcon } from "../ui/icons";
import { Header, Screen } from "../ui/Screen";
import { useLongPress } from "../ui/useLongPress";
import { selection } from "../../../platform/haptics";
import { FeedIcon } from "../../../components/feeds/FeedIcon";
import { useFeedItems } from "../../../components/feeds/useFeeds";
import { usePicture } from "../../../hooks/usePicture";
import { describeError } from "../../../services/errors";
import { feedName, refreshFeeds } from "../../../services/feeds";
import { dayGroups, dayLabel, feedInitial, feedSite, feedTint, headerLine, postAge } from "../../../services/feedsView";
import { preference, savePreference } from "../../../services/preferences";
import { relativeTime } from "../../../services/relativeTime";
import type { Feed, FeedItem } from "../../../types";

type Scope = "unread" | "all";

/** A post's row before it is measured (F1: 144 with a two-line title), and a day's label with the gap above it. */
const ROW = 144;
const DAY = 50;

/**
 * F1 Feeds (NP-072b): the header with what is new and when the feeds were checked, a glass
 * refresh circle beside the account cluster; feed chips with round avatars and unread counts
 * ("All feeds" first, ink when on; a long press opens the feed's menu as a sheet); the day and an
 * Unread | All switch; the posts by day, each day on a shelf, virtualised and paged as the
 * desktop's list. A tap pushes the post view. The feed shown is the app's `feedPlace`.
 */
export function FeedsScreen({ hidden }: { hidden: boolean }) {
  const { app, stack, sheets } = usePhone();
  const { t, i18n } = app;
  const feeds = useMemo(() => app.feeds ?? [], [app.feeds]);
  const feedUid = app.feedPlace.feed;
  const [scope, setScopeState] = useState<Scope>(() => preference<Scope>("feedsScope", ["unread", "all"], "unread"));
  const setScope = (next: Scope) => {
    setScopeState(next);
    savePreference("feedsScope", next);
  };
  const { items, loaded, hasMore, loadMore } = useFeedItems(feedUid, "", app.feeds, scope === "unread");
  // Posts read from this list stay on Unread until the feed, the switch or a check changes it.
  const [kept, setKept] = useState<ReadonlySet<number>>(() => new Set());
  useEffect(() => setKept(new Set()), [feedUid, scope]);
  const keptPosts = usePosts(kept);
  const shown = useMemo(() => (scope === "unread" ? withKept(items, keptPosts) : items), [scope, items, keptPosts]);
  useEffect(() => rememberPosts(items), [items]);
  const byUid = useMemo(() => new Map(feeds.map((f) => [f.uid, f])), [feeds]);
  // The screen's element attaches after the list's first layout: the virtualiser gets it on the next render.
  const screen = useRef<HTMLElement | null>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setScroller(screen.current), []);

  const refresh = () => {
    setKept(new Set());
    void refreshFeeds(feedUid).catch((err) => app.say(describeError(err), true));
  };
  const openPost = (item: FeedItem) => {
    if (scope === "unread") setKept((now) => new Set(now).add(item.id));
    app.setFeedPlace((place) => ({ ...place, item: item.id }));
    stack.push({ name: "post", feedUid, itemId: item.id });
  };

  const entries = useMemo(() => dayGroups(shown), [shown]);
  const first = entries[0]?.kind === "day" ? entries[0] : null;
  const rows = useMemo(() => (entries[0]?.kind === "day" ? entries.slice(1) : entries), [entries]);
  const total = feeds.reduce((sum, f) => sum + f.unread, 0);
  const status = headerLine(feeds, feedUid, { t, language: i18n.language, refreshing: app.feedsRefreshing, ago: (iso) => relativeTime(iso, i18n.language) });

  return (
    <Screen label={t("phone.feeds.title")} hidden={hidden} className="fd-screen" scrollRef={screen}>
      <Header
        title={t("phone.feeds.title")}
        meta={app.feeds && feeds.length > 0 ? status : undefined}
        actions={
          <CircleButton
            icon={RefreshCw}
            label={t("feeds.refresh")}
            aria-busy={app.feedsRefreshing || undefined}
            data-spinning={app.feedsRefreshing || undefined}
            className="fd-refresh"
            onClick={refresh}
          />
        }
      />
      {app.feeds && feeds.length === 0 ? (
        <div className="fd-empty">
          <span className="fd-empty-icon">
            <PhIcon icon={Rss} />
          </span>
          <h2 className="ph-title1">{t("feeds.none.title")}</h2>
          <p className="ph-subhead">{t("feeds.none.text")}</p>
          <Button kind="ink" icon={Plus} onClick={() => sheets.open({ kind: "newLink", props: {} })}>
            {t("phone.nav.new")}
          </Button>
        </div>
      ) : (
        <>
          <div className="ph-chips fd-chips" role="toolbar" aria-label={t("phone.feeds.chips")}>
            <Chip active={feedUid === null} onClick={() => feedUid !== null && app.openFeeds(null)}>
              {t("feeds.all")}
              {total > 0 && <span className="fd-count">{total}</span>}
            </Chip>
            {feeds.map((feed) => (
              <FeedChip key={feed.uid} feed={feed} active={feed.uid === feedUid} />
            ))}
          </div>
          <div className="fd-dayrow">
            <h2 className="fd-day">{first ? dayLabel(first, t, i18n.language) : ""}</h2>
            <Segmented<Scope>
              label={t("phone.feeds.scope")}
              value={scope}
              className="fd-scope"
              options={[
                { value: "unread", label: t("feeds.unread") },
                { value: "all", label: t("phone.feeds.all") },
              ]}
              onChange={setScope}
            />
          </div>
          {loaded && shown.length === 0 ? (
            <div className="fd-none">
              <p className="ph-subhead">{scope === "unread" ? t("phone.feeds.noUnread") : t("feeds.empty")}</p>
              {scope === "unread" && (
                <Button kind="clear" compact onClick={() => setScope("all")}>
                  {t("phone.feeds.showAll")}
                </Button>
              )}
            </div>
          ) : (
            <PostList rows={rows} byUid={byUid} hasMore={hasMore} onMore={loadMore} onOpen={openPost} scroller={scroller} label={t("phone.feeds.title")} />
          )}
        </>
      )}
    </Screen>
  );
}

type Row = ReturnType<typeof dayGroups>[number];

/**
 * The posts after the first day's label, virtualised over the screen's own scroll: rows and the
 * day labels between days are measured as drawn; each day's shelf is one paper surface drawn
 * behind its rows (one shadow per day, not per row). The next page is asked for near the end.
 */
function PostList({
  rows,
  byUid,
  hasMore,
  onMore,
  onOpen,
  scroller,
  label,
}: {
  rows: Row[];
  byUid: Map<string, Feed>;
  hasMore: boolean;
  onMore: () => void;
  onOpen: (item: FeedItem) => void;
  scroller: HTMLElement | null;
  label: string;
}) {
  const { app } = usePhone();
  const { t, i18n } = app;
  const list = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const top = list.current?.offsetTop ?? 0;
    if (top !== margin) setMargin(top);
  });
  // Each row's day, and each day's first and last post.
  const { day, spans } = useMemo(() => {
    const day: number[] = [];
    const spans: { from: number; to: number }[] = [];
    let at = 0;
    rows.forEach((row, i) => {
      if (row.kind === "day") at++;
      day.push(at);
      if (row.kind === "post") {
        const span = spans[at];
        if (span) span.to = i;
        else spans[at] = { from: i, to: i };
      }
    });
    return { day, spans };
  }, [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller,
    estimateSize: (i) => (rows[i]?.kind === "day" ? DAY : ROW),
    getItemKey: (i) => {
      const row = rows[i];
      return row.kind === "day" ? `day:${row.key}` : row.item.id;
    },
    scrollMargin: margin,
    overscan: 6,
  });
  useEffect(() => virtualizer.measure(), [virtualizer, rows]);
  const virtual = virtualizer.getVirtualItems();
  const last = virtual.at(-1)?.index ?? -1;
  useEffect(() => {
    if (hasMore && last >= rows.length - 6) onMore();
  }, [hasMore, last, rows.length, onMore]);

  const measured = virtualizer.measurementsCache;
  const days = [...new Set(virtual.map((row) => day[row.index]))].filter((d) => spans[d]);
  return (
    <div ref={list} role="list" aria-label={label} className="fd-list" style={{ height: virtualizer.getTotalSize() }}>
      {days.map((d) => {
        const from = measured[spans[d].from];
        const to = measured[spans[d].to];
        if (!from || !to) return null;
        return <div key={`shelf:${d}`} aria-hidden="true" className="fd-shelf" style={{ top: from.start - margin, height: to.end - from.start }} />;
      })}
      {virtual.map((row) => {
        const entry = rows[row.index];
        const style = { transform: `translateY(${row.start - margin}px)` };
        if (entry.kind === "day")
          return (
            <div key={row.key} ref={virtualizer.measureElement} data-index={row.index} role="presentation" className="fd-row" style={style}>
              <h2 className="fd-day fd-day-gap">{dayLabel(entry, t, i18n.language)}</h2>
            </div>
          );
        const first = row.index === spans[day[row.index]]?.from;
        return (
          <div key={row.key} ref={virtualizer.measureElement} data-index={row.index} role="listitem" className="fd-row" style={style}>
            <PostRow item={entry.item} feed={byUid.get(entry.item.feed_uid)} first={first} onOpen={onOpen} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * A post on the shelf (F1): the feed's round avatar, "feed · author · age", an unread dot at the
 * shelf's left edge, the title (2 lines), the excerpt (2 lines), the picture 72 r 14 (the feed's
 * letter when the post has none), and "Saved" once it is a bookmark.
 */
function PostRow({ item, feed, first, onOpen }: { item: FeedItem; feed: Feed | undefined; first: boolean; onOpen: (item: FeedItem) => void }) {
  const { app } = usePhone();
  const { t, i18n } = app;
  const name = feed ? feedName(feed) : "";
  const meta = [name, item.author, postAge(item.published_at ?? item.fetched_at, i18n.language)].filter(Boolean).join(" · ");
  return (
    <button type="button" className="fd-post" data-feed-item-id={item.id} data-feed-uid={item.feed_uid} data-read={item.read || undefined} data-first={first || undefined} onClick={() => onOpen(item)}>
      {!item.read && (
        <span className="fd-dot">
          <span className="sr-only">{t("feeds.unread")}</span>
        </span>
      )}
      <span className="fd-head">
        {feed ? <FeedIcon feed={feed} size={20} round /> : <span className="fd-avatar-none" />}
        <span className="fd-meta">{meta}</span>
        {item.bookmark_id !== null && (
          <span className="fd-saved">
            <PhIcon icon={BookmarkCheck} size={14} strokeWidth={1.75} />
            {t("feeds.savedLabel")}
          </span>
        )}
      </span>
      <span className="fd-main">
        <span className="fd-text">
          <span className="fd-title">{item.title}</span>
          {item.excerpt && <span className="fd-excerpt">{item.excerpt}</span>}
        </span>
        <PostPicture item={item} feed={feed} name={name} />
      </span>
    </button>
  );
}

function PostPicture({ item, feed, name }: { item: FeedItem; feed: Feed | undefined; name: string }) {
  const picture = usePicture("post-thumb", item.id, item.thumbnail_url);
  if (picture.src)
    return <img className="fd-picture" src={picture.src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={picture.onError} onLoad={picture.onLoad} />;
  return (
    <span className="fd-picture fd-letter" aria-hidden="true" style={{ "--tint": feed ? feedTint(feedSite(feed)) : "var(--ph-faint)" } as CSSProperties}>
      {feedInitial(name || item.title)}
    </span>
  );
}

/** A feed's chip: its avatar, name and unread count; a tap shows it, a long press opens its menu. */
function FeedChip({ feed, active }: { feed: Feed; active: boolean }) {
  const { app, sheets } = usePhone();
  const press = useLongPress(() => {
    void selection();
    sheets.open({ kind: "feedMenu", props: { feedUid: feed.uid } });
  });
  return (
    <Chip active={active} className="fd-chip" data-feed-uid={feed.uid} onClick={() => !active && app.openFeeds(feed.uid)} {...press}>
      <FeedIcon feed={feed} size={22} round />
      {feedName(feed)}
      {feed.unread > 0 && <span className="fd-count">{feed.unread}</span>}
    </Chip>
  );
}
