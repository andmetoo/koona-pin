import { useCallback, useEffect, useRef, useState } from "react";
import type { Feed, FeedItem } from "../../types";
import { api } from "../../services/api";
import { listFeedItems, listFeeds, onFeedsChanged, onFeedsRefresh } from "../../services/feeds";

/**
 * The subscriptions and their counts, live (NP-132): `feeds-changed` after every fetch,
 * read mark, save or subscription change; `feeds-refresh` while a check runs. Null until
 * the first answer; a build without feeds answers an empty list.
 */
export function useFeeds() {
  const [feeds, setFeeds] = useState<Feed[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let alive = true;
    listFeeds().then(
      (list) => alive && setFeeds(list),
      () => alive && setFeeds([]),
    );
    const stopChanged = onFeedsChanged(({ feeds }) => setFeeds(feeds));
    const stopRefresh = onFeedsRefresh((progress) => setRefreshing(progress.running));
    return () => {
      alive = false;
      stopChanged();
      stopRefresh();
    };
  }, []);
  return { feeds, refreshing };
}

const PAGE = 50;
/** How long typing settles before the search asks. */
const SEARCH_MS = 250;

/**
 * The posts of one feed or of all (NP-132), newest first, a page at a time. Every change of
 * the feeds (`changed`) reads the loaded range again, so read marks and saves show at once.
 */
export function useFeedItems(feedUid: string | null, typed: string, changed: unknown) {
  // The search waits for typing to settle: a query per keystroke would reload the list each time.
  const [search, setSearch] = useState(typed);
  useEffect(() => {
    if (!typed) return setSearch("");
    const timer = window.setTimeout(() => setSearch(typed), SEARCH_MS);
    return () => window.clearTimeout(timer);
  }, [typed]);
  const key = `${feedUid ?? ""}\n${search}`;
  const [state, setState] = useState<{ key: string; items: FeedItem[]; next: string | null; loaded: boolean }>({
    key,
    items: [],
    next: null,
    loaded: false,
  });
  const loaded = useRef(PAGE);
  const loadingMore = useRef(false);
  // A saved post's bookmark trashed or deleted (Undo, the library) changes its «· saved»;
  // with no saved post in the list, a change elsewhere in the library changes nothing here.
  const [bookmarks, setBookmarks] = useState(0);
  const anySaved = useRef(false);
  useEffect(() => {
    const bump = () => anySaved.current && setBookmarks((n) => n + 1);
    const offs = [api.onBookmarkChanged(bump), api.onBookmarksChanged(bump)];
    return () => offs.forEach((off) => off());
  }, []);
  useEffect(() => {
    loaded.current = PAGE;
  }, [key]);
  useEffect(() => {
    let alive = true;
    listFeedItems({ feed_uid: feedUid ?? undefined, unread_only: false, search: search.trim() || undefined, limit: loaded.current }).then(
      (page) => alive && setState({ key, items: page.items, next: page.next, loaded: true }),
      () => alive && setState({ key, items: [], next: null, loaded: true }),
    );
    return () => {
      alive = false;
    };
  }, [key, changed, bookmarks]);
  const current = state.key === key ? state : { key, items: [], next: null, loaded: false };
  useEffect(() => {
    anySaved.current = state.items.some((item) => item.bookmark_id !== null);
  }, [state.items]);
  const loadMore = useCallback(() => {
    if (!current.next || loadingMore.current) return;
    loadingMore.current = true;
    const after = current.next;
    listFeedItems({ feed_uid: feedUid ?? undefined, unread_only: false, search: search.trim() || undefined, limit: PAGE, after })
      .then((page) => {
        loaded.current += PAGE;
        setState((prev) => (prev.key === key && prev.next === after ? { key, items: [...prev.items, ...page.items], next: page.next, loaded: true } : prev));
      })
      .catch(() => {})
      .finally(() => {
        loadingMore.current = false;
      });
  }, [current.next, key]);
  return { items: current.items, hasMore: !!current.next, loaded: current.loaded, loadMore };
}
