import { describe, expect, it } from "vitest";
import { Bookmark } from "../types";
import { browserName, nextWaiting, savedDay, Step, summary, waiting } from "./triage";

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

  it("names the day in local time and the browser", () => {
    const now = new Date(2026, 9, 4, 9, 0);
    expect(savedDay(new Date(2026, 9, 4, 0, 5).toISOString(), now)).toBe("today");
    expect(savedDay(new Date(2026, 9, 3, 23, 50).toISOString(), now)).toBe("yesterday");
    expect(savedDay(new Date(2026, 9, 1, 12, 0).toISOString(), now)).toBe("earlier");
    expect(browserName("firefox")).toBe("Firefox");
    expect(browserName("app")).toBeNull();
    expect(browserName(null)).toBeNull();
  });
});
