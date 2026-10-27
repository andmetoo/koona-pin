import { RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bookmark } from "../types";
import { api } from "../services/api";

/** Every write of the progress is a change to sync (NP-121): at most this often while scrolling. */
const SAVE_EVERY = 2000;
/** Smaller moves are not worth a write. */
const SAVE_STEP = 0.01;
/** A write's own echo comes back in well under this; later, the same value is a change from outside. */
const ECHO_MS = 10_000;

/** Where the article is scrolled, 0–1; null when it does not scroll. */
function positionOf(element: HTMLElement): number | null {
  const room = element.scrollHeight - element.clientHeight;
  if (room <= 0) return null;
  // The last pixels count as the end: a rounding scroll position never quite reaches it.
  return Math.min(1, element.scrollTop >= room - 2 ? 1 : element.scrollTop / room);
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
    const onScroll = () => {
      const now = positionOf(element);
      if (now === null) return;
      setProgress(now);
      const s = state.current;
      if (now <= s.reached || now <= s.floor) return;
      s.reached = now;
      const wait = s.at + SAVE_EVERY - Date.now();
      if (wait <= 0) save();
      else if (!s.timer) s.timer = window.setTimeout(save, wait);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [scroller, ready, save]);

  return progress;
}
