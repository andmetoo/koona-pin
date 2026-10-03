import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../services/api";
import { describeError } from "../services/errors";
import { isAfter, matchesBookmark, mergeBookmark } from "../services/library";
import {
  Bookmark,
  Collection,
  DomainCount,
  FilterState,
  LibraryCounts,
  PageCursor,
  Tag,
} from "../types";

/** The list is read in pages of 100 (NP-011); the next one loads on scroll. */
export function useLibrary(
  filters: FilterState,
  scrollRef: React.RefObject<HTMLDivElement | null>,
) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState<PageCursor | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [domains, setDomains] = useState<DomainCount[]>([]);
  const [counts, setCounts] = useState<LibraryCounts>({
    total: 0,
    favorites: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Record<number, Bookmark>>({});
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  /** Grows with every first-page request; a page of an older list is dropped. */
  const seq = useRef(0);
  const eventVersion = useRef(0);
  const revisions = useRef(new Map<number, number>());
  const alive = useRef(true);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const nextRef = useRef(next);
  nextRef.current = next;
  const loadingMoreRef = useRef(false);
  const catalogSeq = useRef(0);
  const totalSeq = useRef(0);
  const totalTimer = useRef(0);
  const remember = (rows: Bookmark[]) =>
    rows.forEach((b) =>
      revisions.current.set(
        b.id,
        Math.max(revisions.current.get(b.id) ?? 0, b.revision ?? 0),
      ),
    );
  /** Rows older than a change already applied are not shown again. */
  const current = (b: Bookmark) =>
    (revisions.current.get(b.id) ?? 0) <= (b.revision ?? 0);
  const refreshCatalog = useCallback(async () => {
    const id = ++catalogSeq.current;
    try {
      const [c, t, d, n] = await Promise.all([
        api.getCollections(),
        api.getTags(),
        api.getDomains(),
        api.getCounts(),
      ]);
      if (alive.current && id === catalogSeq.current) {
        setCollections(c);
        setTags(t);
        setDomains(d);
        setCounts(n);
      }
    } catch (err) {
      if (alive.current) setError(describeError(err));
    }
  }, []);
  const refresh = useCallback(async () => {
    const id = ++seq.current;
    const version = eventVersion.current;
    setLoading(true);
    try {
      const page = await api.getBookmarks(filtersRef.current);
      if (alive.current && id === seq.current) {
        if (version !== eventVersion.current) {
          void refresh();
          return;
        }
        remember(page.items);
        setBookmarks(page.items.filter((b) => !pendingRef.current[b.id]));
        setTotal(page.total);
        setNext(page.next);
        setError("");
        setLoading(false);
      }
    } catch (err) {
      if (alive.current && id === seq.current) {
        setError(describeError(err));
        setLoading(false);
      }
    }
  }, []);
  const loadMore = useCallback(async () => {
    const after = nextRef.current;
    if (!after || loadingMoreRef.current) return;
    const id = seq.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await api.getBookmarks(filtersRef.current, { after });
      if (alive.current && id === seq.current) {
        remember(page.items);
        setBookmarks((prev) => {
          const known = new Set(prev.map((b) => b.id));
          return [
            ...prev,
            ...page.items.filter(
              (b) => !known.has(b.id) && current(b) && !pendingRef.current[b.id],
            ),
          ];
        });
        setTotal(page.total);
        setNext(page.next);
      }
    } catch (err) {
      if (alive.current && id === seq.current) setError(describeError(err));
    } finally {
      loadingMoreRef.current = false;
      if (alive.current) setLoadingMore(false);
    }
  }, []);
  /** After a change only the total is asked again: the rows are merged locally. */
  const refreshTotal = useCallback(() => {
    window.clearTimeout(totalTimer.current);
    totalTimer.current = window.setTimeout(async () => {
      const id = ++totalSeq.current;
      const list = seq.current;
      try {
        const page = await api.getBookmarks(filtersRef.current, { limit: 1 });
        if (alive.current && id === totalSeq.current && list === seq.current)
          setTotal(page.total);
      } catch {
        /* The next refresh brings the total. */
      }
    }, 250);
  }, []);
  useEffect(() => {
    alive.current = true;
    void refreshCatalog();
    return () => {
      alive.current = false;
      seq.current++;
      catalogSeq.current++;
      window.clearTimeout(totalTimer.current);
    };
  }, [refreshCatalog]);
  useEffect(() => {
    setPending({});
    pendingRef.current = {};
    // The cursor belongs to the old list: no next page until the new one arrives.
    setNext(null);
    nextRef.current = null;
    seq.current++;
    const timeout = window.setTimeout(() => {
      void refresh();
    }, 150);
    return () => window.clearTimeout(timeout);
  }, [
    filters.search,
    filters.collectionId,
    filters.tag,
    filters.domain,
    filters.onlyFavorites,
    refresh,
  ]);
  useEffect(() => {
    const off = api.onBookmarkChanged((change) => {
      if ((revisions.current.get(change.id) ?? 0) >= change.revision) return;
      revisions.current.set(change.id, change.revision);
      eventVersion.current++;
      const b = change.bookmark;
      if (!b || !matchesBookmark(b, filtersRef.current)) {
        setBookmarks((prev) => prev.filter((row) => row.id !== change.id));
        const next = { ...pendingRef.current };
        delete next[change.id];
        pendingRef.current = next;
        setPending(next);
      } else if (isAfter(b, nextRef.current)) {
        // Its place is on a page not read yet; scrolling brings it there.
        setBookmarks((prev) => prev.filter((row) => row.id !== b.id));
      } else if (
        pendingRef.current[b.id] ||
        (change.kind === "created" && (scrollRef.current?.scrollTop ?? 0) > 20)
      ) {
        const next = { ...pendingRef.current, [b.id]: b };
        pendingRef.current = next;
        setPending(next);
      } else {
        setBookmarks((prev) => mergeBookmark(prev, b));
      }
      refreshTotal();
      void refreshCatalog();
    });
    const offInvalidate = api.onLibraryInvalidated(() => {
      eventVersion.current++;
      void refreshCatalog();
      void refresh();
    });
    return () => {
      off();
      offInvalidate();
    };
  }, [refresh, refreshCatalog, refreshTotal, scrollRef]);
  const reveal = () => {
    const incoming = Object.values(pendingRef.current);
    scrollRef.current?.scrollTo({ top: 0 });
    setBookmarks((prev) => incoming.reduce(mergeBookmark, prev));
    pendingRef.current = {};
    setPending({});
  };
  return {
    bookmarks,
    /** Every bookmark that matches, loaded or not. */
    total,
    hasMore: next !== null,
    loadingMore,
    loadMore,
    collections,
    tags,
    domains,
    counts,
    loading,
    error,
    pendingCount: Object.keys(pending).length,
    refresh,
    refreshCatalog,
    reveal,
  };
}
