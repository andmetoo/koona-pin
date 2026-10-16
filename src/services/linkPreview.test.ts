import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedPreview, LinkPreview } from "../types";
import { Answer, createPreviewer, feedOffer, feedRate, LINK_PREVIEW_MS, primaryAction } from "./linkPreview";

const page = (over: Partial<LinkPreview> = {}): LinkPreview => ({
  url: "https://fieldnotes.example.com/",
  metadata: { title: "Field Notes", description: null, image_url: null, favicon_url: null, site_name: "Field Notes", domain: "fieldnotes.example.com" },
  feeds: [{ url: "https://fieldnotes.example.com/feed.xml", title: "Field Notes", kind: "rss" }],
  is_feed: false,
  subscribed_uid: null,
  ...over,
});
const stats: FeedPreview = { title: "Field Notes", site_url: null, icon_url: null, posts_per_day: 4.2, last_post_at: null };
const done = { state: "done" as const, page: page() };
const idle = { state: "idle" as const };

// The link preview (NP-133, plan §4.2): one request per address, after it settles.
describe("the previewer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (fetch = vi.fn(async (url: string) => `answer for ${url}`)) => {
    const seen: Answer<string>[] = [];
    const previewer = createPreviewer(fetch, (a) => seen.push(a), LINK_PREVIEW_MS);
    return { fetch, seen, previewer };
  };

  it("asks once, 0.4 s after the address stops changing", async () => {
    const { fetch, seen, previewer } = setup();
    previewer.set("https://a.example/");
    await vi.advanceTimersByTimeAsync(200);
    previewer.set("https://a.example/page");
    await vi.advanceTimersByTimeAsync(399);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://a.example/page");
    expect(seen.at(-1)).toEqual({ key: "https://a.example/page", state: "done", value: "answer for https://a.example/page" });
  });

  it("keeps the answer: the same address again makes no second request", async () => {
    const { fetch, seen, previewer } = setup();
    previewer.set("https://a.example/");
    await vi.advanceTimersByTimeAsync(LINK_PREVIEW_MS);
    previewer.set(null);
    previewer.set("https://a.example/");
    await vi.advanceTimersByTimeAsync(LINK_PREVIEW_MS);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(seen.map((a) => a.state)).toEqual(["looking", "done", "idle", "done"]);
  });

  it("ignores an answer that comes after the address changed", async () => {
    let resolve!: (value: string) => void;
    const fetch = vi.fn((url: string) => (url.includes("slow") ? new Promise<string>((r) => (resolve = r)) : Promise.resolve("fast")));
    const { seen, previewer } = setup(fetch);
    previewer.set("https://slow.example/");
    await vi.advanceTimersByTimeAsync(LINK_PREVIEW_MS);
    previewer.set("https://fast.example/");
    resolve("slow");
    await vi.advanceTimersByTimeAsync(LINK_PREVIEW_MS);
    expect(seen.filter((a) => a.state === "done")).toEqual([{ key: "https://fast.example/", state: "done", value: "fast" }]);
  });

  it("fails silently and asks again next time", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    const { seen, previewer } = setup(fetch);
    previewer.set("https://a.example/");
    await vi.advanceTimersByTimeAsync(LINK_PREVIEW_MS);
    expect(seen.at(-1)?.state).toBe("failed");
    previewer.set(null);
    previewer.set("https://a.example/");
    await vi.advanceTimersByTimeAsync(LINK_PREVIEW_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports nothing after it stops", async () => {
    const { fetch, seen, previewer } = setup();
    previewer.set("https://a.example/");
    previewer.stop();
    await vi.advanceTimersByTimeAsync(LINK_PREVIEW_MS);
    expect(fetch).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
  });
});

// The feed offer (plan §6.5).
describe("the feed offer", () => {
  it("is nothing while looking, on error, or for a page without a feed", () => {
    expect(feedOffer({ state: "looking" }, 0, false, idle)).toEqual({ kind: "none" });
    expect(feedOffer({ state: "failed" }, 0, false, idle)).toEqual({ kind: "none" });
    expect(feedOffer({ state: "done", page: page({ feeds: [] }) }, 0, false, idle)).toEqual({ kind: "none" });
  });

  it("offers the feed with the toggle off: no feed request, «Save link»", () => {
    const offer = feedOffer(done, 0, false, idle);
    expect(offer).toMatchObject({ kind: "offer", site: "Field Notes", status: "off" });
    expect(primaryAction(offer)).toBe("save");
  });

  it("turned on: looking, then the feed's numbers and «Save and follow»", () => {
    expect(feedOffer(done, 0, true, { state: "looking" })).toMatchObject({ status: "looking" });
    const ready = feedOffer(done, 0, true, { state: "done", preview: stats });
    expect(ready).toMatchObject({ status: "ready", preview: stats });
    expect(primaryAction(ready)).toBe("saveFollow");
  });

  it("a feed that can't be read falls back to «Save link»", () => {
    const offer = feedOffer(done, 0, true, { state: "failed" });
    expect(offer).toMatchObject({ status: "unreadable" });
    expect(primaryAction(offer)).toBe("save");
  });

  it("several feeds: the first, or the one chosen", () => {
    const two = page({ feeds: [...page().feeds, { url: "https://fieldnotes.example.com/comments.xml", title: "Comments", kind: "rss" }] });
    expect(feedOffer({ state: "done", page: two }, 0, false, idle)).toMatchObject({ candidate: { title: "Field Notes" } });
    expect(feedOffer({ state: "done", page: two }, 1, false, idle)).toMatchObject({ candidate: { title: "Comments" } });
    expect(feedOffer({ state: "done", page: two }, 5, false, idle)).toMatchObject({ candidate: { title: "Comments" } });
  });

  it("an address already followed says so", () => {
    expect(feedOffer({ state: "done", page: page({ subscribed_uid: "f1" }) }, 0, false, idle)).toEqual({ kind: "followed", uid: "f1", site: "Field Notes" });
  });

  it("a bare feed is «Follow <title>», and «Save link» when it can't be read", () => {
    const bare = { state: "done" as const, page: page({ is_feed: true, url: "https://fieldnotes.example.com/feed.xml" }) };
    const offer = feedOffer(bare, 0, false, { state: "done", preview: { ...stats, title: "Field Notes — all posts" } });
    expect(offer).toMatchObject({ kind: "feed", title: "Field Notes — all posts", status: "ready" });
    expect(primaryAction(offer)).toBe("follow");
    expect(primaryAction(feedOffer(bare, 0, false, { state: "failed" }))).toBe("save");
  });
});

describe("the feed's rate", () => {
  it("rounds posts a day, and counts a week for a quiet feed", () => {
    expect(feedRate(stats)).toEqual({ key: "add.feedPerDay", count: 4 });
    expect(feedRate({ ...stats, posts_per_day: 0.3 })).toEqual({ key: "add.feedPerWeek", count: 2 });
    expect(feedRate({ ...stats, posts_per_day: 0.01 })).toEqual({ key: "add.feedPerWeek", count: 1 });
    expect(feedRate({ ...stats, posts_per_day: null })).toBeNull();
  });
});
