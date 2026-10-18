import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { initialFilters } from "../../../app/sections";
import { useLibrary } from "../../../hooks/useLibrary";
import { collectionColor } from "../../../services/collections";
import { describeError } from "../../../services/errors";
import { feedName, listFeedItems } from "../../../services/feeds";
import type { Bookmark, FeedItem } from "../../../types";
import { BookmarkRow, PostRow } from "../library/BookmarkTiles";
import { Empty } from "../library/Empty";
import { ShelfList } from "../library/ShelfList";
import { scaledSizes, shelfEntries } from "../library/shelfEntries";
import { useTextScale } from "../library/useTextScale";
import "../library/library.css";
import { usePhone } from "../PhoneContext";
import { Button } from "../ui/buttons";
import { SearchField, Segmented } from "../ui/controls";
import { Screen } from "../ui/Screen";

type Scope = "all" | "library" | "feeds";
/** A result: a bookmark, or a feed's post. */
type Result = { kind: "bookmark"; bookmark: Bookmark } | { kind: "post"; post: FeedItem };

/** Posts are read in pages of this many; typing waits this long before asking. */
const POSTS_PAGE = 50;
const POSTS_WAIT_MS = 200;

/**
 * Q1 Search (NP-072b): the field focused with the keyboard and Cancel (= Back) at the top, the scope
 * — All, Library, Feeds — the result count, the results on a shelf in the library's rows. The
 * library is searched across every section by its own paged list (the tab's list underneath keeps
 * its section and scroll); Feeds searches the feeds' posts (titles and excerpts). All shows the
 * bookmarks, then the posts. The nav pill is hidden: it is a pushed route.
 */
export function SearchScreen({ hidden }: { hidden: boolean }) {
  const { app, stack, sheets } = usePhone();
  const { t, i18n } = app;
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  // Not this screen: new links merge into the results at once instead of waiting behind "N new".
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const sizes = scaledSizes(useTextScale(probe));
  const trimmed = query.trim();

  // The whole library (no section), in the app's order; its own list, live like the tab's.
  const filters = useMemo(() => ({ ...initialFilters, search: query }), [query]);
  const library = useLibrary(filters, app.sort, scrollRef);
  const posts = usePosts(scope === "library" ? "" : trimmed);

  const bookmarks = scope === "feeds" || !trimmed ? [] : library.bookmarks;
  // Posts come after every bookmark is read: All's second shelf.
  const showPosts = scope === "feeds" || (scope === "all" && !library.hasMore && !library.loading);
  const results = useMemo<Result[]>(
    () => [
      ...bookmarks.map((bookmark) => ({ kind: "bookmark" as const, bookmark })),
      ...(showPosts ? posts.items.map((post) => ({ kind: "post" as const, post })) : []),
    ],
    [bookmarks, showPosts, posts.items],
  );
  const entries = useMemo(
    () =>
      shelfEntries(results, {
        groupOf: (r) => (scope === "all" && r.kind === "post" && bookmarks.length > 0 ? "posts" : "results"),
        keyOf: (r) => (r.kind === "bookmark" ? r.bookmark.id : `p${r.post.id}`),
        rowHeight: sizes.row,
        labelHeight: sizes.label,
      }),
    [results, scope, bookmarks.length, sizes.row, sizes.label],
  );
  const bookmarkCount = scope === "feeds" || !trimmed ? 0 : library.total;
  const postCount = scope === "library" ? 0 : posts.items.length;
  const more = scope !== "library" && posts.next !== null;
  const count = bookmarkCount + postCount;

  const collections = useMemo(() => new Set(app.library.collections.map((c) => c.id)), [app.library.collections]);
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const onOpen = useCallback((b: Bookmark) => stackRef.current.push({ name: "reader", bookmarkId: b.id }), []);
  const onMenu = useCallback((b: Bookmark) => sheets.open({ kind: "bookmarkMenu", props: { bookmarkId: b.id, bookmark: b } }), [sheets]);
  const onPost = useCallback((post: FeedItem) => stackRef.current.push({ name: "post", feedUid: post.feed_uid, itemId: post.id }), []);
  const feedNames = useMemo(() => new Map((app.feeds ?? []).map((f) => [f.uid, feedName(f)])), [app.feeds]);
  const favorite = t("phone.library.favorite");

  const loading = (scope !== "feeds" && library.loading) || (scope !== "library" && posts.loading);
  const onMore = scope === "feeds" || (showPosts && !library.hasMore) ? posts.loadMore : library.loadMore;
  const hasMore = scope === "feeds" ? more : library.hasMore || (showPosts && more);

  return (
    <Screen label={t("phone.search.title")} hidden={hidden} route scrollRef={setScroller} className="srch-screen">
      <span ref={probe} className="ph-meta lib-probe" aria-hidden="true">
        Ag
      </span>
      <div className="srch-top">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t("phone.library.search", { count: app.counts.total })}
          aria-label={t("phone.search.title")}
          autoFocus
          onKeyDown={(e) => {
            // The keyboard's Search: the results are there already; the keyboard goes down.
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        <Button compact onClick={stack.back}>
          {t("common.cancel")}
        </Button>
      </div>
      <Segmented
        className="lib-segmented srch-scope"
        label={t("phone.search.scope")}
        value={scope}
        options={[
          { value: "all", label: t("phone.search.all") },
          { value: "library", label: t("phone.search.library") },
          { value: "feeds", label: t("phone.search.feeds") },
        ]}
        onChange={setScope}
      />
      {!trimmed ? (
        <p className="srch-hint ph-subhead">{t("phone.search.hint")}</p>
      ) : results.length === 0 ? (
        loading ? (
          <p className="srch-hint ph-subhead" role="status">
            {t("phone.search.searching")}
          </p>
        ) : posts.error && scope === "feeds" ? (
          <Empty icon={Search} title={posts.error} />
        ) : (
          <Empty icon={Search} title={t("empty.noResultsFor", { query: trimmed })} text={t("empty.searchHint")} />
        )
      ) : (
        <ShelfList
          entries={entries}
          scrollElement={scroller}
          hasMore={hasMore}
          loadingMore={library.loadingMore || posts.loading}
          onMore={onMore}
          renderLabel={(group) => (
            <h2 className="lib-label">
              {group === "posts" ? t("phone.search.fromFeeds") : t(more ? "phone.search.resultsMore" : "phone.search.results", { count })}
            </h2>
          )}
          renderRow={(r, entry) =>
            r.kind === "bookmark" ? (
              <BookmarkRow
                bookmark={r.bookmark}
                dot={r.bookmark.collection_id !== null && collections.has(r.bookmark.collection_id) ? collectionColor(r.bookmark.collection_id) : null}
                language={i18n.language}
                favorite={favorite}
                onOpen={onOpen}
                onMenu={onMenu}
                first={entry.first}
                last={entry.last}
              />
            ) : (
              <PostRow
                post={r.post}
                source={feedNames.get(r.post.feed_uid) ?? ""}
                language={i18n.language}
                onOpen={onPost}
                first={entry.first}
                last={entry.last}
              />
            )
          }
        />
      )}
    </Screen>
  );
}

/**
 * The feeds' posts matching `query` (all feeds, read or not), newest first, page by page; nothing
 * for an empty query. A newer query drops the pages of an older one.
 */
function usePosts(query: string) {
  const [state, setState] = useState<{ query: string; items: FeedItem[]; next: string | null; loading: boolean; error: string }>({
    query: "",
    items: [],
    next: null,
    loading: false,
    error: "",
  });
  const latest = useRef(query);
  latest.current = query;

  useEffect(() => {
    if (!query) {
      setState({ query, items: [], next: null, loading: false, error: "" });
      return;
    }
    setState((now) => ({ ...now, loading: true }));
    const timer = window.setTimeout(() => {
      listFeedItems({ search: query, unread_only: false, limit: POSTS_PAGE }).then(
        (page) => latest.current === query && setState({ query, items: page.items, next: page.next, loading: false, error: "" }),
        (err) => latest.current === query && setState({ query, items: [], next: null, loading: false, error: describeError(err) }),
      );
    }, POSTS_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const loadMore = useCallback(() => {
    if (state.loading || !state.next || state.query !== latest.current) return;
    const { query: asked, next } = state;
    setState((now) => ({ ...now, loading: true }));
    listFeedItems({ search: asked, unread_only: false, limit: POSTS_PAGE, after: next }).then(
      (page) =>
        latest.current === asked &&
        setState((now) => {
          const known = new Set(now.items.map((p) => p.id));
          return { ...now, items: [...now.items, ...page.items.filter((p) => !known.has(p.id))], next: page.next, loading: false };
        }),
      (err) => latest.current === asked && setState((now) => ({ ...now, next: null, loading: false, error: describeError(err) })),
    );
  }, [state]);

  const current = state.query === query;
  return {
    items: current ? state.items : [],
    next: current ? state.next : null,
    loading: !!query && (!current || state.loading),
    error: current ? state.error : "",
    loadMore,
  };
}
