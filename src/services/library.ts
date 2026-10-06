import { Bookmark, FilterState, PageCursor } from "../types";

/** Lower case, «ё» as «е»: the demo's stand-in for the search index. */
export function foldText(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е");
}

/** The trash keeps a bookmark this long; NP-023 deletes it then. */
export const TRASH_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

/** Days, rounded up, until the trash deletes the bookmark for good; 0 once its time is up. */
export function daysLeft(deletedAt: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(deletedAt) + TRASH_DAYS * DAY - now) / DAY));
}

/**
 * When the list places a bookmark: deleted in the trash, saved everywhere
 * else (the library has no deleted bookmarks). The page cursor holds it.
 */
export const listTime = (b: Pick<Bookmark, "created_at" | "deleted_at">) => b.deleted_at ?? b.created_at;

/**
 * The exact filters: trash, inbox, favorites, collection, domain, tag. Whether search words
 * match is decided by the database (`get_bookmarks` with `id`), so the
 * interface keeps no second copy of the search rules.
 */
export function matchesFilters(
  b: Bookmark,
  filters: Partial<FilterState>,
): boolean {
  return !(
    !!filters.onlyTrash !== (b.deleted_at !== null) ||
    (filters.onlyInbox && b.triaged_at !== null) ||
    (filters.onlyFavorites && !b.is_favorite) ||
    (filters.collectionId != null &&
      b.collection_id !== filters.collectionId) ||
    (filters.domain && b.domain !== filters.domain) ||
    (filters.tag && !b.tags?.includes(filters.tag))
  );
}

/** The demo adapter's search: every word of the query, in any field and order. */
export function matchesBookmark(
  b: Bookmark,
  filters: Partial<FilterState>,
): boolean {
  if (!matchesFilters(b, filters)) return false;
  const words = foldText(filters.search ?? "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = foldText(
    [b.title, b.url, b.domain, b.notes, b.description, ...(b.tags ?? [])].join(
      " ",
    ),
  );
  return words.every((word) => text.includes(word));
}

type Placed = { at: string; id: number };
const placed = (b: Pick<Bookmark, "created_at" | "deleted_at" | "id">): Placed => ({ at: listTime(b), id: b.id });

/** The list order `at DESC, id DESC`, compared as SQLite compares text. */
function compareAt(a: Placed, b: Placed): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return b.id - a.id;
}

export function compareBookmarks(
  a: Pick<Bookmark, "created_at" | "deleted_at" | "id">,
  b: Pick<Bookmark, "created_at" | "deleted_at" | "id">,
): number {
  return compareAt(placed(a), placed(b));
}

/** Whether `b` lies past `cursor`, on a page that has not been read yet. */
export function isAfter(b: Bookmark, cursor: PageCursor | null): boolean {
  return cursor !== null && compareAt(placed(b), cursor) > 0;
}

/**
 * Collections by name, tags by use and then by name, in the order of the
 * interface's language (NP-089): the database sorts by code point, which puts
 * «Ä» after «Z» in German and «Č» after «Z» in Serbian.
 */
export function sortByName<T extends { name: string; count?: number | null }>(
  items: T[],
  language: string,
  byCount = false,
): T[] {
  const collator = new Intl.Collator(language, { numeric: true });
  return [...items].sort(
    (a, b) => (byCount ? (b.count ?? 0) - (a.count ?? 0) : 0) || collator.compare(a.name, b.name),
  );
}

export function sortBookmarks(bookmarks: Bookmark[]): Bookmark[] {
  return [...bookmarks].sort(compareBookmarks);
}
export function mergeBookmark(
  bookmarks: Bookmark[],
  bookmark: Bookmark,
): Bookmark[] {
  const previous = bookmarks.find((b) => b.id === bookmark.id);
  if (previous && (previous.revision ?? 0) > (bookmark.revision ?? 0))
    return bookmarks;
  return sortBookmarks([
    ...bookmarks.filter((b) => b.id !== bookmark.id),
    bookmark,
  ]);
}
