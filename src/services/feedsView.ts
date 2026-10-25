// What the Feeds page shows of the cache (NP-132): ages, day groups, the header line, the
// caption under a post's picture and the cached article, sanitised as reading mode's is.
import type { TFunction } from "i18next";
import type { Feed, FeedArticle, FeedItem } from "../types";
import { feedName } from "./feeds";
import { pictureAddress, preparePictures, restorePictures } from "./articlePictures";
import { Article, countWords, sanitize } from "./reader";

/** «3h», «2d»: the age in the list's first line, short as the frame has it; a week on, the date. */
export function postAge(iso: string | null, language: string, now = Date.now()): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  const unit = (value: number, unit: "minute" | "hour" | "day") =>
    new Intl.NumberFormat(language, { style: "unit", unit, unitDisplay: "narrow" }).format(value).replace(/\s+/g, "");
  if (minutes < 60) return unit(Math.max(1, minutes), "minute");
  if (minutes < 24 * 60) return unit(Math.floor(minutes / 60), "hour");
  if (minutes < 7 * 24 * 60) return unit(Math.floor(minutes / (24 * 60)), "day");
  return new Date(time).toLocaleDateString(language, { day: "numeric", month: "short" });
}

export type FeedDay = "today" | "yesterday" | "date";
export type FeedEntry = { kind: "day"; day: FeedDay; key: string; date: string } | { kind: "post"; item: FeedItem };

const midnight = (date: Date, offset = 0) => new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset).getTime();

/** The list in day groups (TODAY, YESTERDAY, then dates), newest first as the cache lists it. */
export function dayGroups(items: FeedItem[], now = new Date()): FeedEntry[] {
  const today = midnight(now);
  const yesterday = midnight(now, 1);
  const entries: FeedEntry[] = [];
  let last: string | null = null;
  for (const item of items) {
    const at = new Date(item.published_at ?? item.fetched_at);
    const time = at.getTime();
    const day: FeedDay = time >= today ? "today" : time >= yesterday ? "yesterday" : "date";
    const key = day === "date" ? `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}` : day;
    if (key !== last) {
      entries.push({ kind: "day", day, key, date: at.toISOString() });
      last = key;
    }
    entries.push({ kind: "post", item });
  }
  return entries;
}

export function dayLabel(entry: Extract<FeedEntry, { kind: "day" }>, t: TFunction, language: string): string {
  if (entry.day !== "date") return t(`groups.${entry.day}`);
  const date = new Date(entry.date);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(language, { weekday: "long", day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }) });
}

/** «Today at 9:12», «Yesterday at 18:40», «Oct 3 at 7:05» above the article. */
export function publishedLine(iso: string | null, t: TFunction, language: string, now = new Date()): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const time = at.toLocaleTimeString(language, { hour: "numeric", minute: "2-digit" });
  if (at.getTime() >= midnight(now)) return t("feeds.todayAt", { time });
  if (at.getTime() >= midnight(now, 1)) return t("feeds.yesterdayAt", { time });
  const sameYear = at.getFullYear() === now.getFullYear();
  return t("feeds.dateAt", { date: at.toLocaleDateString(language, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }), time });
}

const letters = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Text of HTML without running or loading anything of it. */
function textOf(html: string): string {
  return new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
}

/**
 * The excerpt as the italic caption under the picture, unless the body opens with the same
 * words: a summary-only post would say it twice (NP-132).
 */
export function captionOf(excerpt: string, html: string): string | null {
  const caption = excerpt.replace(/\s+/g, " ").trim();
  if (!caption) return null;
  const head = letters(caption.replace(/(\.\.\.|…)$/, "")).slice(0, 60);
  return head && letters(textOf(html)).startsWith(head) ? null : caption;
}

/** The content opens with its own picture: the post's thumbnail is not shown over it. */
export function startsWithPicture(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT: the first picture or words, in reading order.
  const walker = doc.createTreeWalker(doc.body, 0x1 | 0x4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 3) {
      if ((node.textContent ?? "").trim()) return false;
    } else if ((node as Element).tagName === "IMG") return true;
  }
  return false;
}

/** A picture address the sheet and the list may load: https (plain http upgraded), or one a feed or the preview inlines. */
export function pictureUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (/^data:image\/(png|jpeg|gif|webp|avif|svg\+xml)[;,]/i.test(raw)) return raw;
  return pictureAddress(raw);
}

/**
 * The cached post as reading mode's `Article` (NP-132): links made absolute against the
 * post's address and opened in the browser, pictures as reading mode prepares them, then the same
 * `sanitize()` — no scripts, frames, forms, SVG or media reach the sheet.
 */
export function articleOfPost(post: FeedArticle, site: string | null): Article {
  const doc = new DOMParser().parseFromString(post.html, "text/html");
  const base = post.url ?? "about:blank";
  for (const a of Array.from(doc.querySelectorAll("a"))) {
    const raw = a.getAttribute("href")?.trim();
    for (const name of ["target", "ping", "download"]) a.removeAttribute(name);
    if (!raw || raw.startsWith("#")) {
      if (!raw) a.removeAttribute("href");
      else a.setAttribute("href", `#user-content-${raw.slice(1)}`);
      continue;
    }
    try {
      const href = new URL(raw, base);
      if (["http:", "https:", "mailto:"].includes(href.protocol)) {
        a.setAttribute("href", href.href);
        a.setAttribute("rel", "noopener noreferrer");
      } else a.removeAttribute("href");
    } catch {
      a.removeAttribute("href");
    }
  }
  restorePictures(doc);
  preparePictures(doc, base);
  const html = sanitize(doc.body.innerHTML);
  return {
    url: post.url ?? "",
    title: post.title,
    author: post.author,
    site,
    published: post.published_at,
    description: null,
    // The feed names it; the post's HTML is a fragment with no <html lang> of its own.
    language: post.language ?? null,
    html,
    words: countWords(textOf(html), null),
    linkDensity: 0,
    onTopic: true,
  };
}

/** A feed's site, for its letter tile's colour and «Open site». */
export function feedSite(feed: Pick<Feed, "site_url" | "url">): string {
  try {
    return new URL(feed.site_url ?? feed.url).hostname.replace(/^www\./, "");
  } catch {
    return feed.url;
  }
}

const TINTS = ["terracotta", "green", "ochre", "blue", "lilac"] as const;
/** The letter tile's colour, from the domain so it stays the same everywhere: a token of the palette. */
export function feedTint(domain: string): string {
  let hash = 0;
  for (const c of domain) hash = (hash * 31 + c.codePointAt(0)!) >>> 0;
  return `var(--np-${TINTS[hash % TINTS.length]})`;
}

/** The tile's letter: the name's first letter or digit. */
export const feedInitial = (name: string) => (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "·").toUpperCase();

/** What a feed's row and the list's header say about fetching; none when all is well. */
export function healthLine(feed: Pick<Feed, "health">, t: TFunction, language: string): string | null {
  const health = feed.health;
  switch (health.state) {
    case "failing":
      return health.reason === "blocked"
        ? t("feeds.blocked")
        : t("feeds.notUpdating", { date: new Date(health.since).toLocaleDateString(language, { day: "numeric", month: "short" }) });
    case "gone":
      return t("feeds.gone");
    case "moved":
      return t("feeds.moved");
    default:
      return null;
  }
}

/** The list's header line: «6 new · updated 2 min ago», «Offline · updated …», «Not updating since …». */
export function headerLine(
  feeds: Feed[],
  feedUid: string | null,
  { t, language, refreshing, ago }: { t: TFunction; language: string; refreshing: boolean; ago: (iso: string) => string | null },
): string {
  const shown = feedUid ? feeds.filter((f) => f.uid === feedUid) : feeds;
  if (refreshing) return t("feeds.checking");
  const one = feedUid ? shown[0] : null;
  const problem = one && healthLine(one, t, language);
  if (problem) return problem;
  const fetched = shown.map((f) => f.fetched_at).filter((at): at is string => !!at).sort().at(-1);
  const updated = fetched ? ago(fetched) : null;
  const offline = shown.length > 0 && shown.every((f) => f.health.state === "offline");
  const first = offline ? t("feeds.offline") : t("feeds.newCount", { count: shown.reduce((sum, f) => sum + f.unread, 0) });
  return updated ? `${first} · ${t("feeds.updated", { when: updated })}` : first;
}

/** The name of what the list shows: one feed's, or «All feeds». */
export const listTitle = (feeds: Feed[], feedUid: string | null, t: TFunction) => {
  const feed = feedUid ? feeds.find((f) => f.uid === feedUid) : null;
  return feed ? feedName(feed) : t("feeds.all");
};

/** The remembered place on the page: `koonapin.feeds.last`. */
export interface FeedsPlace {
  feed: string | null;
  item: number | null;
}
export function parsePlace(raw: string | null): FeedsPlace {
  try {
    const value = JSON.parse(raw ?? "null") as Partial<FeedsPlace> | null;
    return {
      feed: typeof value?.feed === "string" ? value.feed : null,
      item: typeof value?.item === "number" ? value.item : null,
    };
  } catch {
    return { feed: null, item: null };
  }
}
