import { useCallback, useEffect, useRef, useState } from "react";
import i18n from "../i18n";
import { api } from "../services/api";
import { describeError } from "../services/errors";
import {
  byTime,
  isAfter,
  ListOrder,
  listTime,
  matchesFilters,
  mergeBookmark,
  orderOf,
  sortByName,
  sortCollections,
} from "../services/library";
import { dayStarts, groupSizes, untilMidnight } from "../services/dateGroups";
import { savePreference } from "../services/preferences";
import { starterLinks } from "../services/starter";
import {
  Bookmark,
  BookmarkChange,
  BookmarkSort,
  Collection,
  DomainCount,
  FilterState,
  LibraryCounts,
  PageCursor,
  Tag,
} from "../types";

/** Changes within this time share one read of the catalog. */
const CATALOG_MS = 150;

/**
 * «Title A–Z» and «Site A–Z» compare in the interface's language (NP-114):
 * the database writes its sort keys anew when the language is another than
 * theirs. Every call goes through here, the last one wins.
 */
function tellSortLanguage() {
  return api.setSortLanguage(i18n.language).catch(() => false);
}

/** The list is read in pages of 100 (NP-011) in `sort`; the next one loads on scroll. */
export function useLibrary(
  filters: FilterState,
  sort: BookmarkSort,
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
    reading: 0,
    reading_unread: 0,
  });
  const [loading, setLoading] = useState(true);
  /** This open made the starter set: the library is new (NP-117). */
  const [firstRun, setFirstRun] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Record<number, Bookmark>>({});
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const sortRef = useRef(sort);
  sortRef.current = sort;
  /** The order the current list is read in: the trash and Reading keep their own. */
  const order = (): ListOrder => {
    const { onlyTrash, onlyReading } = filtersRef.current;
    return { sort: orderOf(sortRef.current, onlyTrash || onlyReading), language: i18n.language, reading: onlyReading };
  };
  /** Date groups only in the orders by time (NP-114), and not in Reading. */
  const grouped = () => byTime(order().sort) && !filtersRef.current.onlyReading;
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
        setCollections(sortCollections(c, i18n.language));
        setTags(sortByName(t, i18n.language, true));
        setDomains(d);
        setCounts(n);
      }
    } catch (err) {
      if (alive.current) setError(describeError(err));
    }
  }, []);
  const catalogTimer = useRef(0);
  /**
   * The catalog after a change. Every read counts the whole library, so the
   * changes of a burst (triage keys, metadata arriving) share one: at most
   * one read per `CATALOG_MS`, the last change included.
   */
  const catalogSoon = useCallback(() => {
    if (catalogTimer.current) return;
    catalogTimer.current = window.setTimeout(() => {
      catalogTimer.current = 0;
      void refreshCatalog();
    }, CATALOG_MS);
  }, [refreshCatalog]);
  const refresh = useCallback(async () => {
    const id = ++seq.current;
    const version = eventVersion.current;
    setLoading(true);
    try {
      const since = dayStarts();
      const page = await api.getBookmarks(filtersRef.current, {
        since: grouped() ? since : undefined,
        sort: sortRef.current,
      });
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
        setSinceCounts(page.since_counts ?? null);
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
      const page = await api.getBookmarks(filtersRef.current, { after, sort: sortRef.current });
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
        const since = grouped() ? startsRef.current : undefined;
        const page = await api.getBookmarks(filtersRef.current, { limit: 1, since, sort: sortRef.current });
        if (alive.current && id === totalSeq.current && list === seq.current) {
          setTotal(page.total ?? 0);
          setSinceCounts(page.since_counts ?? null);
        }
      } catch {
        /* The next refresh brings the total. */
      }
    }, 250);
  }, []);
  useEffect(() => {
    alive.current = true;
    // A new library gets its first collections and the starter links in the
    // interface's language; the app makes them once, any later call gets
    // nothing (NP-085, NP-117). The first open also offers an import.
    const starters = ["starter.development", "starter.design", "starter.reading"] as const;
    void api
      .createStarterLibrary(
        starters.map((key) => i18n.t(key)),
        starterLinks(i18n.t),
      )
      .then((made) => {
        if (made.links.length > 0 && alive.current) {
          savePreference("importBanner", "show");
          setFirstRun(true);
        }
      })
      .catch(() => {})
      .then(tellSortLanguage)
      .then(() => refreshCatalog());
    return () => {
      alive.current = false;
      seq.current++;
      catalogSeq.current++;
      window.clearTimeout(totalTimer.current);
      window.clearTimeout(catalogTimer.current);
      catalogTimer.current = 0;
    };
  }, [refreshCatalog]);
  // Another language sorts names its own way (NP-089), and titles and sites
  // too: the database writes its keys anew, then the list is read again (NP-114).
  useEffect(() => {
    const resort = () => {
      setCollections((c) => sortCollections(c, i18n.language));
      setTags((t) => sortByName(t, i18n.language, true));
      void tellSortLanguage().then(() => {
        if (alive.current && !byTime(order().sort)) void refresh();
      });
    };
    i18n.on("languageChanged", resort);
    return () => i18n.off("languageChanged", resort);
  }, [refresh]);
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
    filters.onlyReading,
    sort,
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
      const listOrder = order();
      const beyond = !!b && isAfter(b, nextRef.current, listOrder);
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
        // Newest first a new bookmark lands on top, out of sight while the list
        // is scrolled: it waits behind «N new». In the other orders it takes
        // its place among the rows.
        if (
          pendingRef.current[b.id] ||
          (listOrder.sort === "newest" && change.kind === "created" && (scrollRef.current?.scrollTop ?? 0) > 20)
        ) {
          const next = { ...pendingRef.current, [b.id]: b };
          pendingRef.current = next;
          setPending(next);
        } else {
          setBookmarks((prev) => mergeBookmark(prev, b, listOrder));
        }
        // Within the read pages: not shown means it did not match before.
        adjustTotal(shown ? 0 : 1, createdAt);
      }
      if (catalog) catalogSoon();
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
      catalogSoon();
    });
    const offInvalidate = api.onLibraryInvalidated(() => {
      // The library may have been replaced (a restore from a copy, NP-034):
      // its bookmarks keep their ids with older revisions, and new ones take
      // ids this list has already seen. What it remembers about them is void;
      // the list is read anew. New bookmarks held back stay so: `replaced`.
      // The copy's sort keys may be in another language (NP-114).
      revisions.current.clear();
      unread.current.clear();
      eventVersion.current++;
      void tellSortLanguage().then(() => {
        void refreshCatalog();
        void refresh();
      });
    });
    // «Не дубликаты»: only the count of groups changes.
    const offDuplicates = api.onDuplicatesChanged(catalogSoon);
    return () => {
      off();
      offBatch();
      offInvalidate();
      offDuplicates();
    };
  }, [refresh, refreshCatalog, catalogSoon, refreshTotal, scrollRef]);
  // At midnight «today» becomes «yesterday»: read the list again.
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), untilMidnight() + 1000);
    return () => window.clearTimeout(timer);
  }, [starts, refresh]);
  const collectionsRef = useRef(collections);
  collectionsRef.current = collections;
  /**
   * The sidebar's order after a move (NP-114): shown at once and written
   * behind; a failure puts the old order back and is thrown to the caller.
   */
  const reorderCollections = useCallback(async (ids: number[]) => {
    const before = collectionsRef.current;
    const place = (c: Collection) => (ids.includes(c.id) ? ids.indexOf(c.id) : c.position);
    setCollections(sortCollections(before.map((c) => ({ ...c, position: place(c) })), i18n.language));
    try {
      await api.reorderCollections(ids);
    } catch (err) {
      if (alive.current) setCollections(before);
      throw err;
    }
  }, []);
  /** The library was replaced by a copy: new bookmarks held back belong to the old one. */
  const replaced = () => {
    pendingRef.current = {};
    setPending({});
  };
  const reveal = () => {
    const incoming = Object.values(pendingRef.current);
    scrollRef.current?.scrollTo({ top: 0 });
    const listOrder = order();
    setBookmarks((prev) => incoming.reduce((list, b) => mergeBookmark(list, b, listOrder), prev));
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
    reorderCollections,
    tags,
    domains,
    counts,
    loading,
    firstRun,
    error,
    pendingCount: Object.keys(pending).length,
    refresh,
    refreshCatalog,
    reveal,
    replaced,
  };
}
