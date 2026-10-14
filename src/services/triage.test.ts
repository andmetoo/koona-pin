import { describe, expect, it } from "vitest";
import { Bookmark } from "../types";
import { browserName, collectionKeys, nextWaiting, savedDay, Step, suggestFrom, summary, waiting } from "./triage";

const bookmark = (id: number, fields: Partial<Bookmark> = {}): Bookmark => ({
  id,
  url: `https://example.com/${id}`,
  title: `Закладка ${id}`,
  description: null,
  image_url: null,
  favicon_url: null,
  domain: "example.com",
  notes: null,
  is_favorite: false,
  collection_id: null,
  created_at: "2026-10-04T10:00:00.000Z",
  updated_at: "2026-10-04T10:00:00.000Z",
  tags: [],
  revision: 1,
  triaged_at: null,
  deleted_at: null,
  source: "chrome",
  reading_at: null,
  reading_progress: 0,
  read_at: null,
  ...fields,
});

describe("triage", () => {
  it("skips what was sorted or deleted elsewhere", () => {
    const items = {
      1: bookmark(1),
      2: bookmark(2, { triaged_at: "2026-10-04T11:00:00.000Z" }),
      3: bookmark(3, { deleted_at: "2026-10-04T11:00:00.000Z" }),
      4: bookmark(4),
    };
    const queue = [1, 2, 3, 4, 5];
    expect(nextWaiting(queue, items, 0)).toBe(0);
    expect(nextWaiting(queue, items, 1)).toBe(3);
    // Gone for good: not in the items at all.
    expect(nextWaiting(queue, items, 4)).toBe(5);
    expect(waiting(items[1])).toBe(true);
    expect(waiting(undefined)).toBe(false);
  });

  it("sums up decisions that moved on, not the star or a tag on the way", () => {
    const step = (kind: Step["kind"], collectionId: number | null = null, advanced = true): Step => ({
      id: 1,
      title: "",
      kind,
      collectionId,
      command: 1,
      advanced,
    });
    const steps = [
      step("keep"),
      step("favorite", null, false),
      step("tag", null, false),
      step("move", 3),
      step("edit", 2),
      step("edit"),
      step("trash"),
    ];
    expect(summary(steps)).toEqual({ count: 5, kept: 2, filed: 2, trashed: 1 });
  });

  it("suggests the collection most of the site lies in, as the database does", () => {
    const at = (id: number, domain: string, collection_id: number | null, deleted = false) =>
      bookmark(id, { domain, collection_id, deleted_at: deleted ? "2026-10-04T11:00:00.000Z" : null });
    const card = at(1, "trezor.io", null);
    const library = [card, at(2, "trezor.io", 7), at(3, "other.org", 7), at(4, "trezor.io", null)];
    expect(suggestFrom(library, card)).toBeNull();
    library.push(at(5, "trezor.io", 7));
    expect(suggestFrom(library, card)).toEqual({ collection_id: 7, count: 2, filed: 2 });
    library.push(at(6, "trezor.io", 8), at(7, "trezor.io", 8));
    expect(suggestFrom(library, card)).toBeNull();
    library.push(at(8, "trezor.io", 7), at(9, "trezor.io", 7, true));
    expect(suggestFrom(library, card)).toEqual({ collection_id: 7, count: 3, filed: 5 });
  });

  it("puts the suggestion under key 1 and the rest in sidebar order", () => {
    const collection = (id: number) => ({ id, name: `К${id}`, color: null, icon: null, count: 0, created_at: "" });
    const collections = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(collection);
    const ids = (suggestion: Parameters<typeof collectionKeys>[1]) => collectionKeys(collections, suggestion).map((c) => c.id);
    expect(ids(null)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(ids({ collection_id: 10, count: 2, filed: 2 })).toEqual([10, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ids({ collection_id: 3, count: 2, filed: 3 })).toEqual([3, 1, 2, 4, 5, 6, 7, 8, 9]);
    // A collection deleted since: no suggestion.
    expect(ids({ collection_id: 99, count: 2, filed: 2 })).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("names the day in local time and the browser", () => {
    const now = new Date(2026, 9, 4, 9, 0);
    expect(savedDay(new Date(2026, 9, 4, 0, 5).toISOString(), now)).toBe("today");
    expect(savedDay(new Date(2026, 9, 3, 23, 50).toISOString(), now)).toBe("yesterday");
    expect(savedDay(new Date(2026, 9, 1, 12, 0).toISOString(), now)).toBe("earlier");
    expect(browserName("firefox")).toBe("Firefox");
    expect(browserName("safari")).toBe("Safari");
    expect(browserName("app")).toBeNull();
    expect(browserName(null)).toBeNull();
  });
});
