import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../services/api";
import { matchesBookmark, mergeBookmark } from "../services/library";
import {
  Bookmark,
  Collection,
  DomainCount,
  FilterState,
  LibraryCounts,
  Tag,
} from "../types";

export function useLibrary(
  filters: FilterState,
  scrollRef: React.RefObject<HTMLDivElement | null>,
) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
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
  const seq = useRef(0);
  const eventVersion = useRef(0);
  const revisions = useRef(new Map<number, number>());
  const alive = useRef(true);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const catalogSeq = useRef(0);
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
      if (alive.current) setError(String(err));
    }
  }, []);
  const refresh = useCallback(async () => {
    const id = ++seq.current;
    const version = eventVersion.current;
    setLoading(true);
    try {
      const rows = await api.getBookmarks(filtersRef.current);
      if (alive.current && id === seq.current) {
        if (version !== eventVersion.current) {
          void refresh();
          return;
        }
        rows.forEach((b) =>
          revisions.current.set(
            b.id,
            Math.max(revisions.current.get(b.id) ?? 0, b.revision ?? 0),
          ),
        );
        setBookmarks(rows.filter((b) => !pendingRef.current[b.id]));
        setError("");
        setLoading(false);
      }
    } catch (err) {
      if (alive.current && id === seq.current) {
        setError(String(err));
        setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refreshCatalog();
    return () => {
      alive.current = false;
      seq.current++;
      catalogSeq.current++;
    };
  }, [refreshCatalog]);
  useEffect(() => {
    setPending({});
    pendingRef.current = {};
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
  }, [refresh, refreshCatalog, scrollRef]);
  const reveal = () => {
    const incoming = Object.values(pendingRef.current);
    scrollRef.current?.scrollTo({ top: 0 });
    setBookmarks((prev) => incoming.reduce(mergeBookmark, prev));
    pendingRef.current = {};
    setPending({});
  };
  return {
    bookmarks,
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
