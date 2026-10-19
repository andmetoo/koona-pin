import { useEffect, useRef } from "react";
import { onBack, openPlace } from "./back";
import { isMobile } from "./platform";

/**
 * While `open` (and on a phone), system Back and the iOS edge swipe call `close` (NP-151): a dialog,
 * a sheet or the editor closes, one level at a time, the one opened last first. The place in that
 * order is taken when `open` turns true and kept while it stays true. A layer that cannot close now
 * (a locked dialog, busy) returns false from `close`: Back then closes nothing, here or below.
 */
export function useBack(close: () => void | boolean, open = true) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open || !isMobile) return;
    // Closed once already: a second Back before React re-renders goes to the layer below.
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onBack(() => {
      if (closed) return false;
      if (latest.current() === false) return true;
      closed = true;
      // Still open a moment later (its close only started something): it answers Back again.
      timer = setTimeout(() => (closed = false), 400);
      return true;
    }, openPlace());
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [open]);
}
