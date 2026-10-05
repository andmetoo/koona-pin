import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../services/api";
import { describeError } from "../services/errors";
import { isAfter, listTime, matchesFilters, mergeBookmark } from "../services/library";
import { dayStarts, groupSizes, untilMidnight } from "../services/dateGroups";
import {
  Bookmark,
  BookmarkChange,
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
  /** The day boundaries of the list's date groups and the matches since each. */
  const [starts, setStarts] = useState(dayStarts);
  const [sinceCounts, setSinceCounts] = useState<number[] | null>(null);
  const startsRef = useRef(starts);
  const [next, setNext] = useState<PageCursor | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** A next page failed: no more automatic attempts until a refresh. */
  const [moreFailed, setMoreFailed] = useState(false);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [domains, setDomains] = useState<DomainCount[]>([]);
  const [counts, setCounts] = useState<LibraryCounts>({
    total: 0,
    favorites: 0,
    inbox: 0,
    inbox_newest: null,
    inbox_imported: 0,
    trash: 0,
    duplicates: 0,
    links: 0,
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
  const bookmarksRef = useRef(bookmarks);
  bookmarksRef.current = bookmarks;
  /**
   * The newest version of changed bookmarks whose page has not been read
   * yet. A page requested before the change carries the old row; this one
   * replaces it.
   */
  const unread = useRef(new Map<number, Bookmark>());
  const loadingMoreRef = useRef(false);
  const moreFailedRef = useRef(false);
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
      const since = dayStarts();
      const page = await api.getBookmarks(filtersRef.current, { since });
      if (alive.current && id === seq.current) {
        if (version !== eventVersion.current) {
          void refresh();
          return;
        }
        remember(page.items);
        unread.current.clear();
        setBookmarks(page.items.filter((b) => !pendingRef.current[b.id]));
        setTotal(page.total ?? 0);
        startsRef.current = since;
        setStarts(since);
        setSinceCounts(page.since_counts);
        setNext(page.next);
        moreFailedRef.current = false;
        setMoreFailed(false);
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
    if (!after || loadingMoreRef.current || moreFailedRef.current) return;
    const id = seq.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await api.getBookmarks(filtersRef.current, { after });
      if (alive.current && id === seq.current) {
        remember(page.items);
        // A row older than a change applied meanwhile: the newer version if
        // it still belongs here, nothing if it was deleted or left the list.
        const rows = page.items.flatMap((b) => {
          const newer = unread.current.get(b.id);
          unread.current.delete(b.id);
          return current(b) ? [b] : newer ? [newer] : [];
        });
        setBookmarks((prev) => {
          const known = new Set(prev.map((b) => b.id));
          return [
            ...prev,
            ...rows.filter((b) => !known.has(b.id) && !pendingRef.current[b.id]),
          ];
        });
        setNext(page.next);
      }
    } catch (err) {
      if (alive.current && id === seq.current) {
        // The sentinel stays visible; retrying at once would loop. «Retry»
        // in the error banner starts over with a refresh.
        moreFailedRef.current = true;
        setMoreFailed(true);
        setError(describeError(err));
      }
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
        const since = startsRef.current;
        const page = await api.getBookmarks(filtersRef.current, { limit: 1, since });
        if (alive.current && id === totalSeq.current && list === seq.current) {
          setTotal(page.total ?? 0);
          setSinceCounts(page.since_counts);
        }
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
    filters.onlyInbox,
    filters.onlyTrash,
    refresh,
  ]);
  useEffect(() => {
    /**
     * `null`: whether the change moved the total is unknown, ask again. The
     * date-group counts move with the total when the bookmark's time is known.
     */
    const adjustTotal = (delta: number | null, createdAt?: string) => {
      if (delta === null || (delta !== 0 && createdAt === undefined)) return refreshTotal();
      if (delta === 0) return;
      setTotal((value) => Math.max(0, value + delta));
      setSinceCounts((counts) =>
        counts?.map((count, i) => (createdAt! >= startsRef.current[i] ? Math.max(0, count + delta) : count)) ?? null,
      );
    };
    /** One change into the list; `catalog` false when the caller refreshes the catalog once for many. */
    const apply = (change: BookmarkChange, matches: boolean, catalog = true) => {
      const b = change.bookmark;
      const known =
        bookmarksRef.current.find((row) => row.id === change.id) ??
        pendingRef.current[change.id];
      const shown = !!known;
      const unreadBefore = unread.current.has(change.id);
      // Where the list places it: the time the date groups count by.
      const placedAt = b ?? known ?? unread.current.get(change.id);
      const createdAt = placedAt && listTime(placedAt);
      const beyond = !!b && isAfter(b, nextRef.current);
      if (!b || !matches) {
        unread.current.delete(change.id);
        setBookmarks((prev) => prev.filter((row) => row.id !== change.id));
        const next = { ...pendingRef.current };
        delete next[change.id];
        pendingRef.current = next;
        setPending(next);
        // Counted before if it was shown or known on an unread page. Within
        // the read pages, a row that matched would have been shown.
        const counted = shown || unreadBefore;
        const certain = counted || nextRef.current === null || (!!b && !beyond);
        adjustTotal(counted ? -1 : certain ? 0 : null, createdAt);
      } else if (beyond) {
        // Its place is on a page not read yet; scrolling brings it there.
        unread.current.set(b.id, b);
        setBookmarks((prev) => prev.filter((row) => row.id !== b.id));
        adjustTotal(unreadBefore ? 0 : change.kind === "created" ? 1 : null, createdAt);
      } else {
        if (
          pendingRef.current[b.id] ||
          (change.kind === "created" && (scrollRef.current?.scrollTop ?? 0) > 20)
        ) {
          const next = { ...pendingRef.current, [b.id]: b };
          pendingRef.current = next;
          setPending(next);
        } else {
          setBookmarks((prev) => mergeBookmark(prev, b));
        }
        // Within the read pages: not shown means it did not match before.
        adjustTotal(shown ? 0 : 1, createdAt);
      }
      if (catalog) void refreshCatalog();
    };
    const off = api.onBookmarkChanged((change) => {
      if ((revisions.current.get(change.id) ?? 0) >= change.revision) return;
      revisions.current.set(change.id, change.revision);
      eventVersion.current++;
      const b = change.bookmark;
      const filters = filtersRef.current;
      if (!b || !matchesFilters(b, filters)) return apply(change, false);
      if (!filters.search.trim()) return apply(change, true);
      // Search words are matched by the database, the only copy of the rules.
      const list = seq.current;
      api.getBookmarks(filters, { id: b.id, limit: 1 }).then(
        (page) => {
          const latest = revisions.current.get(b.id) === change.revision;
          if (alive.current && list === seq.current && latest)
            apply(change, page.items.length > 0);
        },
        () => {
          if (alive.current && list === seq.current) void refresh();
        },
      );
    });
    /**
     * A bulk action or an undo of many (NP-029): each change goes through the
     * same `apply` as a single one, so the loaded pages and the scroll
     * position stay; under a search the database says once which of them
     * match, and the catalog is read once for all.
     */
    const offBatch = api.onBookmarksChanged(async (changes) => {
      const fresh = changes.filter((c) => (revisions.current.get(c.id) ?? 0) < c.revision);
      if (!fresh.length) return;
      for (const c of fresh) revisions.current.set(c.id, c.revision);
      eventVersion.current++;
      const filters = filtersRef.current;
      const list = seq.current;
      let found: Set<number> | null = null;
      if (filters.search.trim()) {
        try {
          found = new Set(await api.getBookmarkIds(filters));
        } catch {
          if (alive.current && list === seq.current) void refresh();
          return;
        }
        if (!alive.current || list !== seq.current) return;
      }
      for (const c of fresh) {
        const b = c.bookmark;
        apply(c, !!b && matchesFilters(b, filters) && (!found || found.has(b.id)), false);
      }
      void refreshCatalog();
    });
    const offInvalidate = api.onLibraryInvalidated(() => {
      // The library may have been replaced (a restore from a copy, NP-034):
      // its bookmarks keep their ids with older revisions, and new ones take
      // ids this list has already seen. What it remembers about them is void.
      revisions.current.clear();
      unread.current.clear();
      pendingRef.current = {};
      setPending({});
      eventVersion.current++;
      void refreshCatalog();
      void refresh();
    });
    return () => {
      off();
      offBatch();
      offInvalidate();
    };
  }, [refresh, refreshCatalog, refreshTotal, scrollRef]);
  // At midnight «today» becomes «yesterday»: read the list again.
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), untilMidnight() + 1000);
    return () => window.clearTimeout(timer);
  }, [starts, refresh]);
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
    /** Date groups of the list: boundaries and sizes over all pages, when known. */
    dateGroups: { starts, sizes: sinceCounts ? groupSizes(total, sinceCounts) : null },
    hasMore: next !== null && !moreFailed,
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
