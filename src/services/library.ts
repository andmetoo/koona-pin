import { Bookmark, FilterState, PageCursor } from "../types";

/** Lower case, «ё» as «е»: the demo's stand-in for the search index. */
export function foldText(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е");
}

/**
 * The exact filters: inbox, favorites, collection, domain, tag. Whether search words
 * match is decided by the database (`get_bookmarks` with `id`), so the
 * interface keeps no second copy of the search rules.
 */
export function matchesFilters(
  b: Bookmark,
  filters: Partial<FilterState>,
): boolean {
  return !(
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

/** The list order `created_at DESC, id DESC`, compared as SQLite compares text. */
export function compareBookmarks(
  a: Pick<Bookmark, "created_at" | "id">,
  b: Pick<Bookmark, "created_at" | "id">,
): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return b.id - a.id;
}

/** Whether `b` lies past `cursor`, on a page that has not been read yet. */
export function isAfter(b: Bookmark, cursor: PageCursor | null): boolean {
  return cursor !== null && compareBookmarks(b, cursor) > 0;
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
