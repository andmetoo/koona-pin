import { useEffect, useRef } from "react";
import { onBack, openPlace } from "./back";
import { isMobile } from "./platform";

/**
 * While `open` (and on a phone), system Back and the iOS edge swipe call `close` (NP-151): a dialog,
 * a sheet or the editor closes, one level at a time, the one opened last first. The place in that
 * order is taken when `open` turns true and kept while it stays true.
 */
export function useBack(close: () => void, open = true) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open || !isMobile) return;
    // Closed once already: a second Back before React re-renders goes to the layer below. One
    // that stayed open (busy, refusing) answers Back again a moment later.
    let closed = false;
    return onBack(() => {
      if (closed) return false;
      closed = true;
      window.setTimeout(() => (closed = false), 400);
      latest.current();
      return true;
    }, openPlace());
  }, [open]);
}
