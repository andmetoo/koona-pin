import { RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bookmark } from "../types";
import { api } from "../services/api";

/** Every write of the progress is a change to sync (NP-121): at most this often while scrolling. */
const SAVE_EVERY = 2000;
/** Smaller moves are not worth a write. */
const SAVE_STEP = 0.01;
/** A write's own echo comes back in well under this; later, the same value is a change from outside. */
const ECHO_MS = 10_000;

/** How far the article can scroll and how far it is, in pixels; null when it does not scroll. */
function scrollOf(element: HTMLElement): { room: number; top: number } | null {
  const room = element.scrollHeight - element.clientHeight;
  return room <= 0 ? null : { room, top: element.scrollTop };
}

/** Where a measured scroll is, 0–1. The last pixels count as the end: a rounding scroll position
 *  never quite reaches it. */
function positionAt(at: { room: number; top: number }): number {
  return Math.min(1, at.top >= at.room - 2 ? 1 : at.top / at.room);
}

/** Where the article is scrolled, 0–1; null when it does not scroll. */
function positionOf(element: HTMLElement): number | null {
  const at = scrollOf(element);
  return at && positionAt(at);
}

/**
 * How far the article is read, 0–1, written through `set_reading_progress` at
 * most every two seconds and once more when the bookmark changes or the reader
 * closes. Only forward: scrolling back to look at something does not unread it.
 * The reading sheet (NP-123) and the reading mode (NP-122) share it.
 */
export function useReadingProgress(bookmark: Bookmark, scroller: RefObject<HTMLElement | null>, ready: boolean) {
  const [progress, setProgress] = useState(bookmark.reading_progress);
  // `sent`: the values written lately and when, so their echo is told apart from a change from
  // outside; one the server never sends back (an ignored write) stops counting after ECHO_MS.
  // `floor`: after a reset from outside, scrolling counts only past where the article was then.
  // `inReading`: whether the copy was in Reading, to tell a restart (sent back once read) apart.
  const fresh = () => ({
    id: bookmark.id,
    saved: bookmark.reading_progress,
    reached: bookmark.reading_progress,
    at: 0,
    timer: 0,
    sent: new Map<number, number>(),
    floor: 0,
    inReading: !!bookmark.reading_at,
  });
  const state = useRef<ReturnType<typeof fresh>>(undefined!);
  state.current ??= fresh();

  const save = useCallback(() => {
    const s = state.current;
    window.clearTimeout(s.timer);
    s.timer = 0;
    if (s.reached - s.saved < SAVE_STEP && !(s.reached >= 1 && s.saved < 1)) return;
    s.saved = s.reached;
    s.at = Date.now();
    for (const [value, at] of s.sent) if (s.at - at >= ECHO_MS) s.sent.delete(value);
    s.sent.set(s.reached, s.at);
    void api.setReadingProgress(s.id, s.reached).catch(() => {});
  }, []);

  // Another bookmark: the last one keeps what was read of it.
  useLayoutEffect(() => {
    state.current = fresh();
    setProgress(bookmark.reading_progress);
    return save;
    // The bookmark's own progress changes with every write; only another id starts anew.
  }, [bookmark.id, save]);

  // Changed from outside, not by a write of ours: an Undo, a finish elsewhere, a reset. A higher
  // or lower value is what was read, and what was read since still counts. A reset to 0 starts
  // over: sent to Reading again once read, the article goes back to its top; reset otherwise
  // (marked unread, an Undo to nothing read), it stays where it is and counts again only past
  // there, so the end it was left at does not read it to the end again on the next scroll.
  useEffect(() => {
    const s = state.current;
    if (s.id !== bookmark.id) return;
    const value = bookmark.reading_progress;
    const wasIn = s.inReading;
    s.inReading = !!bookmark.reading_at;
    if (value === s.saved) return;
    const sentAt = s.sent.get(value);
    if (sentAt !== undefined) {
      s.sent.delete(value);
      if (Date.now() - sentAt < ECHO_MS) return;
    }
    s.saved = value;
    if (value > 0) {
      s.reached = Math.max(s.reached, value);
      return;
    }
    window.clearTimeout(s.timer);
    s.timer = 0;
    s.reached = 0;
    const element = scroller.current;
    if (!wasIn && s.inReading) {
      s.floor = 0;
      setProgress(0);
      element?.scrollTo({ top: 0 });
    } else s.floor = (element && positionOf(element)) ?? 0;
  }, [bookmark.id, bookmark.reading_progress, bookmark.reading_at, scroller]);

  useEffect(() => {
    const element = scroller.current;
    if (!element || !ready) return;
    /** Counts where the article is; `forwardOnly`, only when it is further than read so far. */
    const count = (forwardOnly: boolean) => {
      const at = scrollOf(element);
      if (!at) return;
      const s = state.current;
      // Forward by more than a pixel past what was read (or, after a reset from outside, past where
      // the article was then), not by the end's 2 px of rounding: an article restored to just
      // short of its end (0.999) is not read to the end by being opened, though the browser rounds
      // the restore's scroll to a whole (device) pixel, either way.
      if (forwardOnly && at.top <= Math.max(s.reached, s.floor) * at.room + 1) return;
      const now = positionAt(at);
      setProgress(now);
      if (now <= s.reached || now <= s.floor) return;
      s.reached = now;
      const wait = s.at + SAVE_EVERY - Date.now();
      if (wait <= 0) save();
      else if (!s.timer) s.timer = window.setTimeout(save, wait);
    };
    const onScroll = () => count(false);
    element.addEventListener("scroll", onScroll, { passive: true });
    // Counted without a scroll too, only forward: a finished article opened at its top stays
    // finished, and one that grows as it lays out (images, the hero) is not unread.
    const forward = () => count(true);
    // A scroll made before the listener was there, while the reader was getting ready.
    forward();
    // An article that shrinks under a scroll that stays put. The scroller's own box keeps its
    // size, so its children are watched. An observer reports each element once as it starts
    // watching it (unless it has no size): only a height other than the one it was watched at
    // counts, so that first report is skipped and a hidden article that appears is not.
    const heights = new Map<Element, number>();
    const heightOf = (child: Element) => (child as HTMLElement).offsetHeight;
    const resized =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            let changed = false;
            for (const { target } of entries) {
              const height = heightOf(target);
              if (heights.get(target) !== height) changed = true;
              heights.set(target, height);
            }
            if (changed) forward();
          });
    // Watched anew when they are replaced (the next article in the queue), and counted then.
    const watch = () => {
      if (!resized) return;
      resized.disconnect();
      heights.clear();
      for (const child of Array.from(element.children)) {
        heights.set(child, heightOf(child));
        resized.observe(child);
      }
    };
    watch();
    const replaced =
      resized && typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            watch();
            forward();
          })
        : null;
    replaced?.observe(element, { childList: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
      resized?.disconnect();
      replaced?.disconnect();
    };
  }, [scroller, ready, save]);

  return progress;
}
