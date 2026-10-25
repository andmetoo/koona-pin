// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { Feed, FeedItem } from "../types";
import { articleOfPost, captionOf, dayGroups, headerLine, parsePlace, pictureUrl, postAge, startsWithPicture } from "./feedsView";

const t = ((key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key)) as unknown as TFunction;
const now = new Date(2026, 9, 16, 12, 0).getTime();
const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

const item = (id: number, published: string): FeedItem => ({
  id,
  feed_uid: "f",
  url: `https://example.com/${id}`,
  title: `Post ${id}`,
  author: null,
  excerpt: "",
  thumbnail_url: null,
  published_at: published,
  fetched_at: published,
  read: false,
  bookmark_id: null,
  full: true,
});

const feed = (patch: Partial<Feed> = {}): Feed => ({
  uid: "f",
  url: "https://example.com/feed",
  title: null,
  feed_title: "Example",
  site_url: "https://example.com/",
  icon_url: null,
  destination: "feeds",
  unread: 3,
  total: 5,
  fetched_at: hoursAgo(0.05),
  newest_at: null,
  health: { state: "ok" },
  ...patch,
});

describe("postAge", () => {
  it("is short, as the list's first line has it", () => {
    expect(postAge(hoursAgo(0.4), "en", now)).toBe("24m");
    expect(postAge(hoursAgo(3), "en", now)).toBe("3h");
    expect(postAge(hoursAgo(50), "en", now)).toBe("2d");
    expect(postAge(hoursAgo(0), "en", now)).toBe("1m");
  });
  it("gives the date after a week, and nothing for no date", () => {
    expect(postAge(hoursAgo(24 * 10), "en", now)).toBe("Oct 6");
    expect(postAge(null, "en", now)).toBe("");
    expect(postAge("not a date", "en", now)).toBe("");
  });
});

describe("dayGroups", () => {
  it("puts a label before each day: today, yesterday, then dates", () => {
    const entries = dayGroups([item(1, hoursAgo(1)), item(2, hoursAgo(5)), item(3, hoursAgo(20)), item(4, hoursAgo(40)), item(5, hoursAgo(41))], new Date(now));
    expect(entries.map((e) => (e.kind === "day" ? e.day : e.item.id))).toEqual(["today", 1, 2, "yesterday", 3, "date", 4, 5]);
  });
  it("has no label for an empty list", () => {
    expect(dayGroups([], new Date(now))).toEqual([]);
  });
});

describe("the caption under the picture", () => {
  it("is the excerpt, unless the body opens with it", () => {
    expect(captionOf("A pot of beans and one trick.", "<p>Something else first.</p>")).toBe("A pot of beans and one trick.");
    expect(captionOf("A pot of beans and one trick…", "<p>A pot of beans and one trick with the liquid.</p>")).toBeNull();
    expect(captionOf("  ", "<p>Body</p>")).toBeNull();
  });
  it("knows a body that opens with its own picture", () => {
    expect(startsWithPicture('<figure><img src="https://x.org/a.jpg"></figure><p>Text</p>')).toBe(true);
    expect(startsWithPicture('<p><a href="#"><img src="https://x.org/a.jpg"></a> Text</p>')).toBe(true);
    expect(startsWithPicture('<p>Text <img src="https://x.org/a.jpg"></p>')).toBe(false);
  });
  it("loads pictures over https, plain http upgraded, or inline", () => {
    expect(pictureUrl("https://x.org/a.jpg")).toBe("https://x.org/a.jpg");
    expect(pictureUrl("http://x.org/a.jpg")).toBe("https://x.org/a.jpg");
    expect(pictureUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(pictureUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("the cached article", () => {
  const post = (html: string) => ({ id: 1, url: "https://blog.example.org/2026/post", title: "Title", author: "Ann", published_at: hoursAgo(1), html, full: true });

  it("never keeps a script, a frame, a form, SVG, styles or handlers of a hostile post", () => {
    const article = articleOfPost(
      post(`
        <p onclick="alert(1)">Hello <b>world</b></p>
        <script>window.owned = true</script>
        <iframe src="https://evil.example/"></iframe>
        <object data="x.swf"></object><embed src="x.swf">
        <form action="https://evil.example/"><input name="q"><button>Go</button></form>
        <svg><script>alert(1)</script></svg>
        <style>body { display: none }</style>
        <img src="x" onerror="alert(1)">
        <a href="javascript:alert(1)">bad</a>
        <a href="data:text/html,<script>alert(1)</script>">data</a>
        <video src="https://x.org/v.mp4"></video>
        <p style="position:fixed" class="x" id="root">styled</p>`),
      "Example",
    );
    const body = new DOMParser().parseFromString(article.html, "text/html").body;
    expect(body.querySelectorAll("script, iframe, object, embed, form, input, button, svg, style, video")).toHaveLength(0);
    expect(article.html).not.toMatch(/on(click|error)=|javascript:|data:text|style=|class=/i);
    expect(body.querySelector("#root")).toBeNull();
    expect(body.textContent).toContain("Hello world");
    expect((window as unknown as { owned?: boolean }).owned).toBeUndefined();
  });

  it("makes links absolute and pictures https, as reading mode does", () => {
    const article = articleOfPost(
      post('<p><a href="/about" target="_blank">About</a> <a href="#notes">notes</a></p><img src="/a.jpg"><img src="http://plain.example/b.jpg">'),
      "Example",
    );
    const body = new DOMParser().parseFromString(article.html, "text/html").body;
    const [about, notes] = Array.from(body.querySelectorAll("a"));
    expect(about.getAttribute("href")).toBe("https://blog.example.org/about");
    expect(about.getAttribute("target")).toBeNull();
    expect(notes.getAttribute("href")).toBe("#user-content-notes");
    const images = Array.from(body.querySelectorAll("img"));
    expect(images.map((img) => img.getAttribute("src"))).toEqual(["https://blog.example.org/a.jpg", "https://plain.example/b.jpg"]);
    expect(images[0].getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(article).toMatchObject({ title: "Title", author: "Ann", site: "Example", url: "https://blog.example.org/2026/post", description: null });
    expect(article.words).toBe(2);
  });
});

describe("the list's header line", () => {
  const ago = () => "2 min. ago";
  it("counts what is new and says when", () => {
    expect(headerLine([feed(), feed({ uid: "g", unread: 2 })], null, { t, language: "en", refreshing: false, ago })).toBe(
      'feeds.newCount {"count":5} · feeds.updated {"when":"2 min. ago"}',
    );
  });
  it("says offline, a failing feed and a check under way", () => {
    expect(headerLine([feed({ health: { state: "offline" } })], null, { t, language: "en", refreshing: false, ago })).toBe(
      'feeds.offline · feeds.updated {"when":"2 min. ago"}',
    );
    const failing = feed({ health: { state: "failing", since: new Date(2026, 9, 7).toISOString(), reason: "timeout" } });
    expect(headerLine([failing], "f", { t, language: "en", refreshing: false, ago })).toBe('feeds.notUpdating {"date":"Oct 7"}');
    const blocked = feed({ health: { state: "failing", since: hoursAgo(200), reason: "blocked" } });
    expect(headerLine([blocked], "f", { t, language: "en", refreshing: false, ago })).toBe("feeds.blocked");
    expect(headerLine([feed()], null, { t, language: "en", refreshing: true, ago })).toBe("feeds.checking");
  });
});

it("remembers the place on the page, and ignores a broken one", () => {
  expect(parsePlace('{"feed":"a","item":3}')).toEqual({ feed: "a", item: 3 });
  expect(parsePlace("{oops")).toEqual({ feed: null, item: null });
  expect(parsePlace(null)).toEqual({ feed: null, item: null });
});
