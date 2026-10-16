import { describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { Feed } from "../types";
import { feedNotifications } from "./feedNotifications";

const now = Date.parse("2026-10-16T12:00:00Z");
const feed = (over: Partial<Feed>): Feed => ({
  uid: "f",
  url: "https://example.com/feed.xml",
  title: null,
  feed_title: "Example",
  site_url: "https://example.com/",
  icon_url: null,
  destination: "notify",
  unread: 0,
  total: 10,
  fetched_at: "2026-10-16T11:00:00Z",
  newest_at: "2026-10-16T11:00:00Z",
  health: { state: "ok" },
  ...over,
});
const actions = () => ({ onRead: vi.fn(), onShow: vi.fn(), onUnfollow: vi.fn() });
const t = i18n.getFixedT("en");

// The feeds' notifications (NP-133, plan §6.6).
describe("feed notifications", () => {
  it("one notification for the feeds that notify: count, names, thumbnails, Read", () => {
    const feeds = [
      feed({ uid: "ars", feed_title: "Ars Technica", site_url: "https://arstechnica.com/", unread: 7, newest_at: "2026-10-16T11:58:00Z" }),
      feed({ uid: "verge", feed_title: "The Verge", site_url: "https://www.theverge.com/", unread: 3, newest_at: "2026-10-16T11:30:00Z" }),
      feed({ uid: "eats", feed_title: "Serious Eats", unread: 1, newest_at: "2026-10-16T09:00:00Z" }),
      feed({ uid: "kottke", feed_title: "kottke.org", unread: 1, newest_at: "2026-10-16T08:00:00Z" }),
      feed({ uid: "quiet", unread: 4, destination: "feeds" }),
      feed({ uid: "read", unread: 0 }),
    ];
    const act = actions();
    const [n, ...rest] = feedNotifications(feeds, act, t, now);
    expect(rest).toEqual([]);
    expect(n).toMatchObject({
      key: "feeds:2026-10-16T11:58:00Z",
      kind: "feeds",
      title: "12 new posts",
      text: "from Ars Technica, The Verge and 2 more",
      at: "2026-10-16T11:58:00Z",
    });
    expect(n.thumbs?.map((b) => b.domain)).toEqual(["arstechnica.com", "theverge.com", "example.com"]);
    expect(new Set(n.thumbs?.map((b) => b.id)).size).toBe(3);
    expect(n.action.label).toBe("Read");
    n.action.run();
    expect(act.onRead).toHaveBeenCalledWith(["ars", "verge", "eats", "kottke"]);
  });

  it("keeps its key when a check brings nothing new", () => {
    const before = feedNotifications([feed({ unread: 2 })], actions(), t, now)[0];
    const after = feedNotifications([feed({ unread: 2, fetched_at: "2026-10-16T11:59:00Z" })], actions(), t, now)[0];
    expect(after.key).toBe(before.key);
  });

  it("names one or two feeds in full; a new batch is a new key", () => {
    const one = feedNotifications([feed({ unread: 1 })], actions(), t, now)[0];
    expect([one.title, one.text]).toEqual(["1 new post", "from Example"]);
    const two = feedNotifications([feed({ unread: 2 }), feed({ uid: "b", feed_title: "Other", unread: 1, newest_at: "2026-10-16T11:50:00Z" })], actions(), t, now)[0];
    expect(two.text).toBe("from Other and Example");
    expect(two.key).not.toBe(one.key);
  });

  it("nothing when no feed that notifies has new posts", () => {
    expect(feedNotifications([feed({ unread: 0 }), feed({ destination: "inbox", unread: 5 })], actions(), t, now)).toEqual([]);
  });

  it("a feed failing for a week is a problem with Show and Unfollow; a day is not", () => {
    const act = actions();
    const list = feedNotifications(
      [
        feed({ uid: "ars", feed_title: "Ars Technica", destination: "feeds", health: { state: "failing", since: "2026-10-07T12:00:00Z", reason: "timeout" } }),
        feed({ uid: "new", destination: "feeds", health: { state: "failing", since: "2026-10-15T12:00:00Z", reason: "timeout" } }),
      ],
      act,
      t,
      now,
    );
    expect(list).toHaveLength(1);
    const [n] = list;
    expect(n).toMatchObject({ kind: "problem", title: "Ars Technica isn’t updating", key: "feed-failing:ars:2026-10-07T12:00:00Z" });
    expect(n.dismiss).toBeUndefined();
    n.action.run();
    n.secondary!.run();
    expect([n.action.label, n.secondary!.label]).toEqual(["Show", "Unfollow"]);
    expect(act.onShow).toHaveBeenCalledWith("ars");
    expect(act.onUnfollow).toHaveBeenCalledWith("ars");
  });
});
