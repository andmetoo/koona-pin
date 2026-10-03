import { describe, it, expect } from "vitest";
import {
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
  it("knows which bookmarks lie on pages not read yet", () => {
    const cursor = { created_at: "2026-10-01", id: 5 };
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
