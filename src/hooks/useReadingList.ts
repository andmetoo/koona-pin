import { useEffect, useState } from "react";
import { Bookmark, PageCursor } from "../types";
import { api } from "../services/api";

/** Reading is read whole, in pages of this many; a list longer than `READING_MAX` is cut. */
const READING_PAGE = 200;
const READING_MAX = 1000;
/** Changes come in bursts (a bulk action, progress of every bookmark): one read after them. */
const REFRESH_MS = 250;

/**
 * Every bookmark in Reading in the list's own order (NP-121: unread newest
 * first, then the read), read again after any change of the library while
 * `active`. `null` until the first answer; a failed read keeps the last list.
 */
export function useReadingList(active: boolean) {
  const [items, setItems] = useState<Bookmark[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer = 0;
    let request = 0;
    const load = async () => {
      const mine = ++request;
      try {
        const all: Bookmark[] = [];
        let after: PageCursor | undefined;
        do {
          const page = await api.getBookmarks({ onlyReading: true }, { after, limit: READING_PAGE });
          all.push(...page.items);
          after = page.next ?? undefined;
        } while (after && all.length < READING_MAX);
        // A newer read started meanwhile: its answer wins.
        if (!alive || mine !== request) return;
        setItems(all);
        setFailed(false);
      } catch {
        if (alive && mine === request) setFailed(true);
      }
    };
    const later = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), REFRESH_MS);
    };
    void load();
    const offs = [api.onBookmarkChanged(later), api.onBookmarksChanged(later), api.onLibraryInvalidated(later)];
    return () => {
      alive = false;
      window.clearTimeout(timer);
      for (const off of offs) off();
    };
  }, [active]);
  return { items, failed };
}
