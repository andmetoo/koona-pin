import { Bookmark, BookmarkChange, BookmarkSort, Collection, FilterState, PageCursor } from "../types";

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
 * The place of a bookmark in Reading (NP-121), as `db::READING_AT`: newest
 * first, the unread ones by when they were added above the read ones by when
 * they were read.
 */
export const readingPlace = (b: Pick<Bookmark, "reading_at" | "read_at">) =>
  b.read_at ? `0${b.read_at}` : `1${b.reading_at ?? ""}`;

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
    (filters.onlyReading && !b.reading_at) ||
    (filters.onlyOffline && !b.offline_at) ||
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

/**
 * How the list is ordered (NP-114): the chosen order and the interface's
 * language. The trash keeps its own order, newest deletion first.
 */
export type ListOrder = { sort: BookmarkSort; language: string; reading?: boolean };
export const NEWEST: ListOrder = { sort: "newest", language: "en" };
export const SORTS: BookmarkSort[] = ["newest", "oldest", "title", "site"];
/** The order a list is read in: the trash keeps its own. */
export const orderOf = (sort: BookmarkSort, trash: boolean): BookmarkSort => (trash ? "newest" : sort);
/** Orders by time keep the date groups; by title and by site the list is one run. */
export const byTime = (sort: BookmarkSort) => sort === "newest" || sort === "oldest";

/** What «Site A–Z» compares: the domain without `www.`, as `sorting::site` in Rust. */
export const siteOf = (domain: string) => domain.replace(/^www\./i, "");

type Sortable = Pick<
  Bookmark,
  "created_at" | "deleted_at" | "id" | "title" | "domain" | "title_key" | "site_key" | "reading_at" | "read_at"
>;
/**
 * A place in the order. `key` is the database's sort key in hex, which
 * compares as text exactly as the database orders (desktop); without it — the
 * demo — `text` is compared by the language's collator, as the keys are made.
 */
type Placed = { at: string; id: number; key?: string | null; text?: string };
const placed = (b: Sortable, { sort, reading }: ListOrder): Placed => ({
  at: reading ? readingPlace(b) : listTime(b),
  id: b.id,
  key: sort === "title" ? b.title_key : sort === "site" ? b.site_key : undefined,
  text: sort === "title" ? b.title : sort === "site" ? siteOf(b.domain) : undefined,
});

/** `at DESC, id DESC`, compared as SQLite compares text. */
function compareAt(a: Pick<Placed, "at" | "id">, b: Pick<Placed, "at" | "id">): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return b.id - a.id;
}

const textCollators = new Map<string, Intl.Collator>();
/** The database's comparison (`sorting.rs`): case aside, accents second, numbers by value. */
function textCollator(language: string): Intl.Collator {
  let collator = textCollators.get(language);
  if (!collator) textCollators.set(language, (collator = new Intl.Collator(language, { numeric: true, sensitivity: "accent" })));
  return collator;
}

function comparePlaced(a: Placed, b: Placed, order: ListOrder): number {
  switch (order.sort) {
    case "newest":
      return compareAt(a, b);
    case "oldest":
      return -compareAt(a, b);
    default: {
      const byKey =
        a.key && b.key
          ? a.key < b.key
            ? -1
            : a.key > b.key
              ? 1
              : 0
          : textCollator(order.language).compare(a.text ?? "", b.text ?? "");
      // Equal titles and the links of one site: newest first.
      return byKey || compareAt(a, b);
    }
  }
}

export function compareBookmarks(a: Sortable, b: Sortable, order: ListOrder = NEWEST): number {
  return comparePlaced(placed(a, order), placed(b, order), order);
}

/**
 * Whether `b` lies past `cursor`, on a page that has not been read yet. A
 * cursor of the orders by title and by site carries the key in hex; the
 * demo's carries the text instead (`demo.getBookmarks`).
 */
export function isAfter(b: Sortable, cursor: PageCursor | null, order: ListOrder = NEWEST): boolean {
  if (cursor === null) return false;
  const row = placed(b, order);
  const keyed = !!row.key;
  const mark: Placed = { at: cursor.at, id: cursor.id, key: keyed ? cursor.key : null, text: keyed ? undefined : (cursor.key ?? "") };
  return comparePlaced(row, mark, order) > 0;
}

/** The cursor after `b`: in the orders by title and by site, with its key (the demo: its text). */
export function cursorAt(b: Sortable, order: ListOrder): PageCursor {
  const row = placed(b, order);
  const key = row.key ?? row.text;
  return key === undefined ? { at: row.at, id: row.id } : { at: row.at, id: row.id, key };
}

/**
 * Collections by name, tags by use and then by name, in the order of the
 * interface's language (NP-089): the database sorts by code point, which puts
 * «Ä» after «Z» in German and «Č» after «Z» in Serbian.
 */
const collators = new Map<string, Intl.Collator>();

export function sortByName<T extends { name: string; count?: number | null }>(
  items: T[],
  language: string,
  byCount = false,
): T[] {
  let collator = collators.get(language);
  if (!collator) collators.set(language, (collator = new Intl.Collator(language, { numeric: true })));
  return [...items].sort(
    (a, b) => (byCount ? (b.count ?? 0) - (a.count ?? 0) : 0) || collator.compare(a.name, b.name),
  );
}

/**
 * Collections in the sidebar's order (NP-114): where the person put them,
 * then those never moved by name in the interface's language — the order of
 * `get_collections`, kept when the language changes.
 */
export function sortCollections<T extends Pick<Collection, "name" | "position">>(items: T[], language: string): T[] {
  const placed = items.filter((c) => c.position != null).sort((a, b) => a.position! - b.position!);
  const rest = sortByName(
    items.filter((c) => c.position == null),
    language,
  );
  return [...placed, ...rest];
}

/** The ids of `collections` with the one at `from` put at `to` (both in the sidebar's order). */
export function moveCollection(collections: Pick<Collection, "id">[], from: number, to: number): number[] {
  const ids = collections.map((c) => c.id);
  const [moved] = ids.splice(from, 1);
  ids.splice(Math.max(0, Math.min(to, ids.length)), 0, moved);
  return ids;
}

export function sortBookmarks(bookmarks: Bookmark[], order: ListOrder = NEWEST): Bookmark[] {
  return [...bookmarks].sort((a, b) => compareBookmarks(a, b, order));
}

/**
 * Whether a change event is news for the list. A newer revision always is; an
 * offline copy saved or removed (NP-126) changes `offline_at` without a new
 * revision, so the same revision counts when it carries another `offline_at`
 * than the row shown — or a copy, for a row not loaded (the «Offline» section).
 */
export function isNews(change: BookmarkChange, known: number | undefined, shown: Bookmark | undefined): boolean {
  if ((known ?? 0) < change.revision) return true;
  if ((known ?? 0) > change.revision || !change.bookmark) return false;
  return shown ? shown.offline_at !== change.bookmark.offline_at : change.bookmark.offline_at !== null;
}

/**
 * A changed or new bookmark into the loaded list. By time it takes its place;
 * by title and by site a row already there stays where it is (a title that
 * arrives later does not move the row under the pointer, NP-114) and takes
 * its place on the next read of the list.
 */
export function mergeBookmark(
  bookmarks: Bookmark[],
  bookmark: Bookmark,
  order: ListOrder = NEWEST,
): Bookmark[] {
  const at = bookmarks.findIndex((b) => b.id === bookmark.id);
  const previous = bookmarks[at];
  if (previous && (previous.revision ?? 0) > (bookmark.revision ?? 0))
    return bookmarks;
  if (previous && !byTime(order.sort)) return bookmarks.map((b, i) => (i === at ? bookmark : b));
  const rest = bookmarks.filter((b) => b.id !== bookmark.id);
  const place = rest.findIndex((b) => compareBookmarks(bookmark, b, order) < 0);
  return place === -1 ? [...rest, bookmark] : [...rest.slice(0, place), bookmark, ...rest.slice(place)];
}
