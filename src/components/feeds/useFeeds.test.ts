import { describe, expect, it } from "vitest";
import type { FeedItem } from "../../types";
import { keepOpen } from "./useFeeds";

const post = (id: number, read = false) => ({ id, read }) as FeedItem;
const ids = (items: FeedItem[]) => items.map((item) => item.id);

describe("keepOpen", () => {
  it("puts the open post a reload left out back before the next one that stayed, read", () => {
    const before = [post(1), post(2), post(3), post(4)];
    const after = [post(1), post(3), post(4)];
    const kept = keepOpen(before, after, 2);
    expect(ids(kept)).toEqual([1, 2, 3, 4]);
    expect(kept[1].read).toBe(true);
  });

  it("puts it last when nothing after it stayed", () => {
    expect(ids(keepOpen([post(1), post(2)], [post(1)], 2))).toEqual([1, 2]);
  });

  it("changes nothing when the post is still there, was never shown or nothing is open", () => {
    const after = [post(1), post(2)];
    expect(keepOpen([post(1), post(2)], after, 2)).toBe(after);
    expect(keepOpen([post(1)], after, 9)).toBe(after);
    expect(keepOpen([post(1), post(3)], after, null)).toBe(after);
  });
});
