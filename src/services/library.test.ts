import { describe, it, expect } from "vitest";
import {
  byTime,
  cursorAt,
  daysLeft,
  isAfter,
  isNews,
  ListOrder,
  matchesBookmark,
  matchesFilters,
  mergeBookmark,
  moveCollection,
  orderOf,
  siteOf,
  sortBookmarks,
  sortCollections,
  SORTS,
} from "./library";
import { Bookmark } from "../types";
const b: Bookmark = {
  id: 1,
  url: "https://example.com/",
  title: "Архитектура",
  description: null,
  image_url: null,
  favicon_url: null,
  site_name: null,
  notes: null,
  domain: "example.com",
  is_favorite: false,
  reading_at: null,
  reading_progress: 0,
  read_at: null,
  offline_at: null,
  collection_id: 2,
  created_at: "2026-10-01",
  updated_at: "2026-10-01",
  revision: 1,
  tags: ["дизайн"],
  triaged_at: "2026-10-01",
  deleted_at: null,
  source: "app",
};
describe("library reconciliation", () => {
  it("updates metadata in place and rejects stale revisions", () => {
    const older = { ...b, id: 2, created_at: "2026-09-01" };
    const updated = { ...older, description: "Fetched", revision: 2 };
    const list = mergeBookmark([b, older], updated);
    expect(list.map((x) => x.id)).toEqual([1, 2]);
    expect(mergeBookmark(list, older)[1].revision).toBe(2);
    expect(mergeBookmark(list, updated)).toHaveLength(2);
  });
  it("matches all filters and Unicode search", () => {
    expect(
      matchesBookmark(b, {
        search: "АРХИТЕКТУРА",
        collectionId: 2,
        tag: "дизайн",
      }),
    ).toBe(true);
    expect(matchesBookmark(b, { onlyFavorites: true })).toBe(false);
    expect(matchesBookmark(b, { collectionId: 3 })).toBe(false);
  });
  it("searches every word in any field and folds ё like the index", () => {
    const tagged = { ...b, title: "Новогодняя Ёлка", notes: "игрушки" };
    expect(matchesBookmark(tagged, { search: "елка" })).toBe(true);
    expect(matchesBookmark(tagged, { search: "ЁЛКА дизайн" })).toBe(true);
    expect(matchesBookmark(tagged, { search: "  игрушки   ёлка " })).toBe(true);
    expect(matchesBookmark(tagged, { search: "ёлка rust" })).toBe(false);
  });
  it("leaves search words to the database outside the demo", () => {
    expect(matchesFilters(b, { search: "nothing like it", tag: "дизайн" })).toBe(true);
    expect(matchesFilters(b, { domain: "other.org" })).toBe(false);
  });
  it("keeps the trash apart from every other section", () => {
    const trashed = { ...b, deleted_at: "2026-10-02T10:00:00.000Z" };
    expect(matchesFilters(trashed, {})).toBe(false);
    expect(matchesFilters(trashed, { onlyFavorites: false, collectionId: 2 })).toBe(false);
    expect(matchesFilters(trashed, { onlyTrash: true })).toBe(true);
    expect(matchesFilters(b, { onlyTrash: true })).toBe(false);
  });
  it("places the trash by deletion time", () => {
    const early = { ...b, id: 1, created_at: "2026-10-05", deleted_at: "2026-10-06" };
    const late = { ...b, id: 2, created_at: "2026-09-01", deleted_at: "2026-10-07" };
    expect(sortBookmarks([early, late]).map((x) => x.id)).toEqual([2, 1]);
    expect(isAfter(early, { at: "2026-10-07", id: 2 })).toBe(true);
    expect(isAfter(late, { at: "2026-10-06", id: 1 })).toBe(false);
  });
  it("counts the days the trash still keeps a bookmark", () => {
    const deleted = "2026-10-01T12:00:00.000Z";
    const at = (iso: string) => daysLeft(deleted, Date.parse(iso));
    expect(at("2026-10-01T12:00:00.000Z")).toBe(30);
    expect(at("2026-10-02T13:00:00.000Z")).toBe(29);
    expect(at("2026-10-31T11:00:00.000Z")).toBe(1);
    expect(at("2026-10-31T12:00:00.000Z")).toBe(0);
    expect(at("2026-11-20T12:00:00.000Z")).toBe(0);
  });
  it("keeps only unsorted bookmarks in the inbox", () => {
    expect(matchesFilters(b, { onlyInbox: true })).toBe(false);
    expect(matchesFilters({ ...b, triaged_at: null }, { onlyInbox: true })).toBe(true);
    expect(matchesFilters({ ...b, triaged_at: null }, {})).toBe(true);
  });
  it("knows which bookmarks lie on pages not read yet", () => {
    const cursor = { at: "2026-10-01", id: 5 };
    expect(isAfter({ ...b, created_at: "2026-09-30", id: 9 }, cursor)).toBe(true);
    expect(isAfter({ ...b, created_at: "2026-10-01", id: 4 }, cursor)).toBe(true);
    expect(isAfter({ ...b, created_at: "2026-10-01", id: 6 }, cursor)).toBe(false);
    expect(isAfter({ ...b, created_at: "2026-10-02", id: 1 }, null)).toBe(false);
  });
  it("uses id as a stable tie-breaker", () => {
    expect(sortBookmarks([b, { ...b, id: 2 }]).map((x) => x.id)).toEqual([
      2, 1,
    ]);
  });
});

describe("the orders of NP-114", () => {
  const row = (id: number, title: string, created: string, extra: Partial<Bookmark> = {}): Bookmark => ({
    ...b,
    id,
    title,
    created_at: created,
    ...extra,
  });
  const ids = (list: Bookmark[]) => list.map((x) => x.id);
  const en = (sort: ListOrder["sort"]): ListOrder => ({ sort, language: "en" });

  it("orders by time both ways and by title or site as the database does", () => {
    const list = [
      row(1, "Zebra", "2026-10-01", { domain: "www.b.example" }),
      row(2, "äpfel", "2026-10-02", { domain: "a.example" }),
      row(3, "Apfel", "2026-10-03", { domain: "c.example" }),
      row(4, "Chapter 10", "2026-10-04", { domain: "B.example" }),
      row(5, "Chapter 9", "2026-10-05", { domain: "a.example" }),
    ];
    expect(ids(sortBookmarks(list, en("newest")))).toEqual([5, 4, 3, 2, 1]);
    expect(ids(sortBookmarks(list, en("oldest")))).toEqual([1, 2, 3, 4, 5]);
    // Without keys (the demo): the collator, case aside, numbers by value.
    expect(ids(sortBookmarks(list, en("title")))).toEqual([3, 2, 5, 4, 1]);
    // «www.» left out; equal sites newest first.
    expect(ids(sortBookmarks(list, en("site")))).toEqual([5, 2, 4, 1, 3]);
    expect(siteOf("WWW.Example.com")).toBe("Example.com");
  });

  it("compares the database's keys as text when the rows have them", () => {
    // Keys win over the text: the database knows the language's order.
    const keyed = [row(1, "B", "2026-10-01", { title_key: "0A" }), row(2, "A", "2026-10-02", { title_key: "0B" }), row(3, "C", "2026-10-03", { title_key: "0A" })];
    expect(ids(sortBookmarks(keyed, en("title")))).toEqual([3, 1, 2]);
    const cursor = cursorAt(keyed[0], en("title"));
    expect(cursor).toEqual({ at: "2026-10-01", id: 1, key: "0A" });
    expect(isAfter(keyed[1], cursor, en("title"))).toBe(true);
    expect(isAfter(keyed[2], cursor, en("title"))).toBe(false);
  });

  it("finds the next page of the demo by the cursor's text", () => {
    const list = [row(1, "Apfel", "2026-10-01"), row(2, "Bär", "2026-10-02"), row(3, "Chapter", "2026-10-03")];
    const cursor = cursorAt(list[1], en("title"));
    expect(cursor.key).toBe("Bär");
    expect(list.filter((x) => isAfter(x, cursor, en("title"))).map((x) => x.id)).toEqual([3]);
    expect(cursorAt(list[1], en("newest"))).toEqual({ at: "2026-10-02", id: 2 });
  });

  it("keeps a row in place by title and puts a new one where it belongs", () => {
    const list = sortBookmarks([row(1, "Apfel", "2026-10-01"), row(2, "Chapter", "2026-10-02")], en("title"));
    const renamed = { ...list[0], title: "Zebra", revision: 2 };
    expect(ids(mergeBookmark(list, renamed, en("title")))).toEqual([1, 2]);
    expect(mergeBookmark(list, renamed, en("title"))[0].title).toBe("Zebra");
    expect(ids(mergeBookmark(list, row(3, "Bär", "2026-10-03"), en("title")))).toEqual([1, 3, 2]);
    // By time a new one takes its place too: the oldest last.
    const byDate = sortBookmarks(list, en("oldest"));
    expect(ids(mergeBookmark(byDate, row(3, "Bär", "2026-09-01"), en("oldest")))).toEqual([3, 1, 2]);
  });

  it("keeps the trash newest deletion first and the date groups for time only", () => {
    expect(orderOf("title", true)).toBe("newest");
    expect(orderOf("title", false)).toBe("title");
    expect(SORTS.filter(byTime)).toEqual(["newest", "oldest"]);
  });

  it("orders Reading as the database does: unread newest added first, then the read ones", () => {
    const reading: ListOrder = { sort: "newest", language: "en", reading: true };
    const item = (id: number, added: string, read: string | null = null): Bookmark => ({ ...b, id, reading_at: added, read_at: read });
    const list = [item(1, "2026-10-01"), item(2, "2026-10-05", "2026-10-06"), item(3, "2026-10-03"), item(4, "2026-09-01", "2026-10-08")];
    const ids = (rows: Bookmark[]) => rows.map((r) => r.id);
    expect(ids(sortBookmarks(list, reading))).toEqual([3, 1, 4, 2]);
    expect(matchesFilters(item(5, "2026-10-01"), { onlyReading: true })).toBe(true);
    expect(matchesFilters(b, { onlyReading: true })).toBe(false);
    // «Offline» (NP-126): only those with a copy.
    expect(matchesFilters({ ...b, offline_at: "2026-10-03" }, { onlyOffline: true })).toBe(true);
    expect(matchesFilters(b, { onlyOffline: true })).toBe(false);
    // A page cursor after the last unread one: the read ones lie beyond it.
    const cursor = cursorAt(list[0], reading);
    expect(cursor).toEqual({ at: "12026-10-01", id: 1 });
    expect(isAfter(list[1], cursor, reading)).toBe(true);
    expect(isAfter(list[2], cursor, reading)).toBe(false);
    // Marked read, it moves to the bottom.
    expect(ids(mergeBookmark(sortBookmarks(list, reading), item(3, "2026-10-03", "2026-10-09"), reading))).toEqual([1, 3, 4, 2]);
  });

  it("takes a copy saved or removed as news without a new revision (NP-126)", () => {
    const saved = { ...b, offline_at: "2026-10-03" };
    const change = (bookmark: Bookmark) => ({ kind: "updated" as const, id: bookmark.id, revision: bookmark.revision, bookmark });
    expect(isNews(change(saved), 1, b)).toBe(true);
    expect(isNews(change(b), 1, saved)).toBe(true);
    expect(isNews(change(b), 1, b)).toBe(false);
    // Not loaded: a copy may bring it into «Offline»; an older revision never counts.
    expect(isNews(change(saved), 1, undefined)).toBe(true);
    expect(isNews(change(b), 1, undefined)).toBe(false);
    expect(isNews(change(saved), 2, b)).toBe(false);
    expect(isNews(change({ ...b, revision: 2 }), 1, b)).toBe(true);
  });

  it("puts moved collections first in their places, the others by name", () => {
    const collections: { id: number; name: string; position?: number }[] = [
      { id: 1, name: "Работа" },
      { id: 2, name: "Ärger", position: 1 },
      { id: 3, name: "Zeit", position: 0 },
      { id: 4, name: "Bücher" },
    ];
    expect(sortCollections(collections, "de").map((c) => c.id)).toEqual([3, 2, 4, 1]);
    expect(moveCollection(sortCollections(collections, "de"), 3, 0)).toEqual([1, 3, 2, 4]);
    expect(moveCollection(collections, 0, 9)).toEqual([2, 3, 4, 1]);
  });
});
