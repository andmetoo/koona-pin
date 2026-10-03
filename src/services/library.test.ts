import { describe, it, expect } from "vitest";
import { matchesBookmark, mergeBookmark, sortBookmarks } from "./library";
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
  it("uses id as a stable tie-breaker", () => {
    expect(sortBookmarks([b, { ...b, id: 2 }]).map((x) => x.id)).toEqual([
      2, 1,
    ]);
  });
});
