import { describe, expect, it, vi } from "vitest";
import { feedName } from "./feeds";

// The preview keeps its state in localStorage and schedules with window's timers.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
});
vi.stubGlobal("window", globalThis);
const { demo } = await import("./demo");

// The browser preview answers every feeds method (NP-128), so the feeds page runs without the app.
describe("the preview's feeds", () => {
  it("follows five sample feeds with counts", async () => {
    const feeds = await demo.listFeeds();
    expect(feeds.map(feedName)).toEqual(["The Verge", "Serious Eats", "kottke.org", "Smashing Magazine", "Ars Technica"]);
    const total = feeds.reduce((sum, f) => sum + f.total, 0);
    expect(total).toBe(20);
    expect(feeds.every((f) => f.unread > 0 && f.unread < f.total)).toBe(true);
  });

  it("pages the posts newest first and filters them", async () => {
    const first = await demo.listFeedItems({ unread_only: false, limit: 8 });
    expect(first.items).toHaveLength(8);
    const second = await demo.listFeedItems({ unread_only: false, limit: 50, after: first.next! });
    expect(second.items).toHaveLength(12);
    expect(second.next).toBeNull();
    const all = [...first.items, ...second.items];
    expect(new Set(all.map((i) => i.id)).size).toBe(20);
    expect(all.map((i) => i.published_at)).toEqual([...all.map((i) => i.published_at)].sort().reverse());
    const unread = await demo.listFeedItems({ feed_uid: "demo-feed-ars", unread_only: true, limit: 50 });
    expect(unread.items.every((i) => i.feed_uid === "demo-feed-ars" && !i.read)).toBe(true);
    // The open post stays among the unread once read (2.17.0).
    const read = (await demo.listFeedItems({ feed_uid: "demo-feed-ars", unread_only: false, limit: 50 })).items.find((i) => i.read)!;
    const kept = await demo.listFeedItems({ feed_uid: "demo-feed-ars", unread_only: true, keep: read.id, limit: 50 });
    expect(kept.items.map((i) => i.id)).toContain(read.id);
    expect(kept.items).toHaveLength(unread.items.length + 1);
    const found = await demo.listFeedItems({ unread_only: false, search: "potatoes", limit: 50 });
    expect(found.items.map((i) => i.title)).toEqual(["Crisp roast potatoes, every time"]);
    const article = await demo.getFeedArticle(found.items[0].id);
    expect(article.html).toContain("<p>");
  });

  it("saves a post as a bookmark from the feed and marks it read", async () => {
    const [post] = (await demo.listFeedItems({ feed_uid: "demo-feed-eats", unread_only: true, limit: 1 })).items;
    const { bookmark, created } = await demo.saveFeedItem(post.id, "reading", true);
    expect(created).toBe(true);
    expect(bookmark).toMatchObject({ source: "feed", source_name: "Serious Eats", is_favorite: true, url: post.url });
    expect(bookmark.reading_at).not.toBeNull();
    const [saved] = (await demo.listFeedItems({ feed_uid: "demo-feed-eats", unread_only: false, search: post.title, limit: 1 })).items;
    expect(saved).toMatchObject({ read: true, bookmark_id: bookmark.id });
  });

  it("subscribes, renames, moves and unsubscribes, telling every listener", async () => {
    const heard: number[] = [];
    const stop = demo.onFeedsChanged(({ feeds }) => heard.push(feeds.length));
    const feed = await demo.subscribeFeed("https://notes.example.org/atom.xml", null, "feeds");
    expect(feedName(feed)).toBe("notes.example.org");
    const renamed = await demo.updateFeed(feed.uid, "Notes", "notify");
    expect(renamed).toMatchObject({ title: "Notes", destination: "notify" });
    await demo.unsubscribeFeed(feed.uid);
    stop();
    expect(heard).toEqual([6, 6, 5]);
    await expect(demo.subscribeFeed("http://192.168.1.1/rss", null, "feeds")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("previews a pasted link and its feed", async () => {
    const page = await demo.previewLink("https://www.seriouseats.com/some-recipe");
    expect(page.feeds.map((f) => f.url)).toEqual(["https://www.seriouseats.com/feeds/all"]);
    expect(page).toMatchObject({ is_feed: false, subscribed_uid: "demo-feed-eats" });
    const feed = await demo.previewFeed(page.feeds[0].url);
    expect(feed.title).toBe("Serious Eats");
    expect(feed.posts_per_day).toBeGreaterThan(0);
    expect((await demo.previewLink("https://example.com/feed.xml")).is_feed).toBe(true);
  });
});
