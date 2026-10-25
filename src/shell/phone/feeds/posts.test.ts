import { afterEach, describe, expect, it } from "vitest";
import type { FeedItem } from "../../../types";
import { forgetPosts, postOf, rememberPosts, updatePost } from "./posts";

const post = (id: number, hoursAgo: number, more: Partial<FeedItem> = {}): FeedItem => ({
  id,
  feed_uid: "f",
  url: `https://example.com/${id}`,
  title: `Post ${id}`,
  author: null,
  excerpt: "",
  thumbnail_url: null,
  published_at: new Date(Date.UTC(2026, 9, 18, 12) - hoursAgo * 3_600_000).toISOString(),
  fetched_at: "2026-10-18T12:00:00Z",
  read: false,
  bookmark_id: null,
  full: true,
  ...more,
});

describe("the posts' store", () => {
  afterEach(forgetPosts);

  it("takes what the post view did, and the list's next copy over it", () => {
    const item = post(1, 1);
    rememberPosts([item]);
    expect(postOf(1)).toBe(item);
    updatePost(1, { read: true, bookmark_id: 7 });
    expect(postOf(1)).toMatchObject({ id: 1, read: true, bookmark_id: 7 });
    const same = postOf(1);
    updatePost(1, { read: true });
    expect(postOf(1)).toBe(same);
    // A post the list never showed is not made up.
    updatePost(2, { read: true });
    expect(postOf(2)).toBeUndefined();
    // The list telling the same copy again does not undo it; a new copy from the list does.
    rememberPosts([item]);
    expect(postOf(1)).toBe(same);
    const fresh = post(1, 1, { read: true, bookmark_id: 8 });
    rememberPosts([fresh]);
    expect(postOf(1)).toBe(fresh);
  });
});
