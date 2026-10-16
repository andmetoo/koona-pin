// The link preview and the feed offer of «New link» (NP-133, plan §4.2 and §6.5): one
// request to the pasted page once the address settles, and one to its feed only when
// the person turns «Follow» on. The machine is plain code so vitest can drive it.
import { useEffect, useRef, useState } from "react";
import type { FeedCandidate, FeedPreview, LinkPreview } from "../types";
import { previewFeed, previewLink } from "./feeds";

export type PreviewState = "idle" | "looking" | "done" | "failed";
export interface Answer<T> {
  /** What the answer is for: a stale one is never shown for another address. */
  key: string | null;
  state: PreviewState;
  value?: T;
}

/** The address has to stop changing for this long before the page is asked (plan §4.2). */
export const LINK_PREVIEW_MS = 400;

/**
 * Asks once per key, after `delay` without a new key. An answer is kept, so the same
 * address again (or Save after the preview) never makes a second request; an answer
 * that arrives after the key changed is kept but not reported. A failure is not kept:
 * offline now may be online on the next paste.
 */
export function createPreviewer<T>(fetch: (key: string) => Promise<T>, report: (answer: Answer<T>) => void, delay = 0) {
  const answers = new Map<string, T>();
  const asking = new Map<string, Promise<T>>();
  let current: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const ask = (key: string) => {
    let request = asking.get(key);
    if (!request) {
      request = fetch(key);
      asking.set(key, request);
    }
    request.then(
      (value) => {
        answers.set(key, value);
        asking.delete(key);
        if (current === key) report({ key, state: "done", value });
      },
      () => {
        asking.delete(key);
        if (current === key) report({ key, state: "failed" });
      },
    );
  };

  return {
    set(key: string | null) {
      if (key === current) return;
      clearTimeout(timer);
      current = key;
      if (key === null) return report({ key, state: "idle" });
      const known = answers.get(key);
      if (known !== undefined) return report({ key, state: "done", value: known });
      report({ key, state: "looking" });
      if (delay > 0) timer = setTimeout(() => ask(key), delay);
      else ask(key);
    },
    /** Nothing more is reported: the sheet closed. */
    stop() {
      clearTimeout(timer);
      current = null;
    },
  };
}

function usePreviewer<T>(key: string | null, fetch: (key: string) => Promise<T>, delay: number): Answer<T> {
  const [answer, setAnswer] = useState<Answer<T>>({ key: null, state: "idle" });
  const previewer = useRef<ReturnType<typeof createPreviewer<T>> | null>(null);
  previewer.current ??= createPreviewer(fetch, setAnswer, delay);
  useEffect(() => {
    previewer.current!.set(key);
  }, [key]);
  useEffect(() => () => previewer.current?.stop(), []);
  // Until the effect runs, an answer for another key reads as looking.
  return answer.key === key ? answer : { key, state: key === null ? "idle" : "looking" };
}

/** `previewLink` 0.4 s after a web link stops changing; the answer is the page's real title, picture and feeds. */
export function useLinkPreview(url: URL | null): { state: PreviewState; page?: LinkPreview } {
  const answer = usePreviewer(url?.href ?? null, previewLink, LINK_PREVIEW_MS);
  return { state: answer.state, page: answer.value };
}

/** `previewFeed` only while the «Follow» toggle is on (plan §4.2). */
export function useFeedPreview(candidate: FeedCandidate | null, on: boolean): { state: PreviewState; preview?: FeedPreview } {
  const answer = usePreviewer(on && candidate ? candidate.url : null, previewFeed, 0);
  return { state: answer.state, preview: answer.value };
}

/** What the sheet offers about feeds, from the two answers and the toggle. */
export type FeedOffer =
  | { kind: "none" }
  /** «You follow this site», with «Show». */
  | { kind: "followed"; uid: string; site: string }
  /** «<Site> has a feed» and the «Follow» toggle; `status` is the feed's own preview. */
  | { kind: "offer"; site: string; candidate: FeedCandidate; candidates: FeedCandidate[]; status: FeedStatus; preview?: FeedPreview }
  /** The address is a feed: «Follow <title>», no bookmark. */
  | { kind: "feed"; title: string; candidate: FeedCandidate; status: FeedStatus; preview?: FeedPreview };
export type FeedStatus = "off" | "looking" | "ready" | "unreadable";
/** The primary button: «Save link», «Save and follow» or «Follow». */
export type PrimaryAction = "save" | "saveFollow" | "follow";

const feedStatus = (on: boolean, feed: { state: PreviewState }): FeedStatus =>
  !on ? "off" : feed.state === "done" ? "ready" : feed.state === "failed" ? "unreadable" : "looking";

/** The site's own name, else its domain. */
export const siteOf = (page: LinkPreview) => page.metadata.site_name || page.metadata.domain;

/**
 * The offer for a page. Offline or on any error there is none, silently (plan §4.2).
 * `chosen` picks among several candidates; `on` is the toggle (always on for a bare feed).
 */
export function feedOffer(
  link: { state: PreviewState; page?: LinkPreview },
  chosen: number,
  on: boolean,
  feed: { state: PreviewState; preview?: FeedPreview },
): FeedOffer {
  const page = link.state === "done" ? link.page : undefined;
  if (!page) return { kind: "none" };
  if (page.is_feed) {
    if (page.subscribed_uid) return { kind: "followed", uid: page.subscribed_uid, site: siteOf(page) };
    const candidate = page.feeds[0] ?? { url: page.url, title: page.metadata.title, kind: "rss" };
    const preview = feed.state === "done" ? feed.preview : undefined;
    const title = preview?.title || candidate.title || page.metadata.title || page.metadata.domain;
    return { kind: "feed", title, candidate, status: feedStatus(true, feed), preview };
  }
  if (!page.feeds.length) return { kind: "none" };
  if (page.subscribed_uid) return { kind: "followed", uid: page.subscribed_uid, site: siteOf(page) };
  const candidate = page.feeds[Math.min(Math.max(chosen, 0), page.feeds.length - 1)];
  const status = feedStatus(on, feed);
  return { kind: "offer", site: siteOf(page), candidate, candidates: page.feeds, status, preview: status === "ready" ? feed.preview : undefined };
}

/** A feed that can't be read falls back to «Save link»: the page is still worth keeping. */
export function primaryAction(offer: FeedOffer): PrimaryAction {
  if (offer.kind === "feed") return offer.status === "unreadable" ? "save" : "follow";
  if (offer.kind === "offer") return offer.status === "off" || offer.status === "unreadable" ? "save" : "saveFollow";
  return "save";
}

/** «About 4 new posts a day», or a week for a quiet feed; none when the feed doesn't say. */
export function feedRate(preview: FeedPreview): { key: "add.feedPerDay" | "add.feedPerWeek"; count: number } | null {
  const perDay = preview.posts_per_day;
  if (perDay === null || !(perDay > 0)) return null;
  if (perDay >= 1) return { key: "add.feedPerDay", count: Math.round(perDay) };
  return { key: "add.feedPerWeek", count: Math.max(1, Math.round(perDay * 7)) };
}
