import { useEffect, useRef } from "react";
import { isMobile, onBack, openPlace } from "../services/platform";

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
    return onBack(() => {
      latest.current();
      return true;
    }, openPlace());
  }, [open]);
}
