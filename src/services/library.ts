import { Bookmark, FilterState } from "../types";

export function matchesBookmark(
  b: Bookmark,
  filters: Partial<FilterState>,
): boolean {
  if (
    (filters.onlyFavorites && !b.is_favorite) ||
    (filters.collectionId != null &&
      b.collection_id !== filters.collectionId) ||
    (filters.domain && b.domain !== filters.domain) ||
    (filters.tag && !b.tags?.includes(filters.tag))
  )
    return false;
  const query = filters.search?.trim().toLocaleLowerCase("ru");
  return (
    !query ||
    [b.title, b.url, b.domain, b.notes, b.description, ...(b.tags ?? [])]
      .join(" ")
      .toLocaleLowerCase("ru")
      .includes(query)
  );
}
export function sortBookmarks(bookmarks: Bookmark[]): Bookmark[] {
  return [...bookmarks].sort(
    (a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id,
  );
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
