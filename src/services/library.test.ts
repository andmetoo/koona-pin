import { describe, it, expect } from "vitest";
import {
  daysLeft,
  isAfter,
  matchesBookmark,
  matchesFilters,
  mergeBookmark,
  sortBookmarks,
} from "./library";
import { Bookmark } from "../types";
const b: Bookmark = {
  id: 1,
  url: "https://example.com/",
  title: "Архитектура",
  description: null,
  image_url: null,
  favicon_url: null,
  notes: null,
  domain: "example.com",
  is_favorite: false,
  collection_id: 2,
  created_at: "2026-10-01",
  updated_at: "2026-10-01",
  revision: 1,
  tags: ["дизайн"],
  triaged_at: "2026-10-01",
  deleted_at: null,
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
