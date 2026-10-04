import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../services/api";
import { FilterState } from "../types";

const NONE: ReadonlySet<number> = new Set();

/** What the section is: changing it clears the selection, search, tag and site do not (Р-27). */
const sectionOf = (f: FilterState) => `${f.collectionId}|${f.onlyFavorites}|${f.onlyInbox}|${f.onlyTrash}`;

/**
 * Selected bookmarks by id, not by DOM elements (NP-028): the list is
 * virtualized, so most of a large selection is never on screen.
 *
 * - Another section clears it; search, a tag or a site keep it, and those of
 *   the selected the list does not show are counted as `hidden`.
 * - A bookmark deleted elsewhere (to the trash, for good, or restored while
 *   the trash is open) leaves it silently; a changed one stays.
 * - `Ctrl A` adds every match, loaded pages or not.
 */
export function useSelection(filters: FilterState, active: boolean) {
  const [ids, setIds] = useState<ReadonlySet<number>>(NONE);
  /** The selected that the current list shows, when known; `null` until asked. */
  const [matching, setMatching] = useState<ReadonlySet<number> | null>(null);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  /** Where `Shift`+click ranges from: the last bookmark clicked or toggled. */
  const anchor = useRef<number | null>(null);
  /** Grows with every section; an answer for an older one is dropped. */
  const section = useRef(0);
  /** Grows with every change in the library: asks again which selected the list shows. */
  const [version, setVersion] = useState(0);

  const update = useCallback((next: ReadonlySet<number>) => {
    idsRef.current = next;
    setIds(next);
  }, []);
  const clear = useCallback(() => {
    anchor.current = null;
    if (idsRef.current.size) update(NONE);
  }, [update]);
  const toggle = useCallback(
    (id: number) => {
      const next = new Set(idsRef.current);
      if (!next.delete(id)) next.add(id);
      anchor.current = id;
      update(next);
    },
    [update],
  );
  /** From the anchor to `id` in list order, added to the selection. */
  const range = useCallback(
    (id: number, order: readonly number[]) => {
      const from = anchor.current === null ? -1 : order.indexOf(anchor.current);
      const to = order.indexOf(id);
      if (from < 0 || to < 0) return toggle(id);
      const next = new Set(idsRef.current);
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(order[i]);
      anchor.current = id;
      update(next);
    },
    [toggle, update],
  );
  const selectAll = useCallback(async () => {
    const asked = section.current;
    const all = await api.getBookmarkIds(filtersRef.current);
    if (asked !== section.current) return;
    const next = new Set(idsRef.current);
    for (const id of all) next.add(id);
    update(next);
  }, [update]);

  const sectionKey = sectionOf(filters);
  useEffect(() => {
    section.current++;
    clear();
  }, [sectionKey, active, clear]);

  useEffect(() => {
    const drop = (gone: (id: number) => boolean) => {
      const kept = [...idsRef.current].filter((id) => !gone(id));
      if (kept.length !== idsRef.current.size) update(new Set(kept));
    };
    const offChange = api.onBookmarkChanged((change) => {
      if (!idsRef.current.has(change.id)) return;
      const b = change.bookmark;
      if (!b || (b.deleted_at !== null) !== filtersRef.current.onlyTrash) drop((id) => id === change.id);
      setVersion((v) => v + 1);
    });
    // An import, emptying the trash or an undo of many: ask which still live where the section does.
    const offInvalidate = api.onLibraryInvalidated(() => {
      if (!idsRef.current.size) return;
      const asked = section.current;
      void api.getBookmarkIds({ onlyTrash: filtersRef.current.onlyTrash }).then((live) => {
        if (asked !== section.current) return;
        const alive = new Set(live);
        drop((id) => !alive.has(id));
      }, () => {});
      setVersion((v) => v + 1);
    });
    return () => {
      offChange();
      offInvalidate();
    };
  }, [update]);

  // Which selected the list shows: asked when the filters or the library change.
  const selecting = ids.size > 0;
  useEffect(() => {
    if (!selecting) return setMatching(null);
    let current = true;
    const timer = window.setTimeout(() => {
      api.getBookmarkIds(filtersRef.current).then(
        (shown) => current && setMatching(new Set(shown)),
        () => current && setMatching(null),
      );
    }, 150);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [selecting, version, filters.search, filters.tag, filters.domain, sectionKey]);

  let hidden = 0;
  if (matching) for (const id of ids) if (!matching.has(id)) hidden++;
  return { ids, hidden, update, clear, toggle, range, selectAll };
}
