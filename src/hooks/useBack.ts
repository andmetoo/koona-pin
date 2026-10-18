import { useEffect, useRef } from "react";
import { isMobile, onBack } from "../services/platform";

/**
 * While `active` (and on a phone), system Back and the iOS edge swipe call `close` (NP-151):
 * a dialog, a sheet or the editor closes, one level at a time, newest first.
 */
export function useBack(close: () => void, active = true) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!active || !isMobile) return;
    return onBack(() => {
      latest.current();
      return true;
    });
  }, [active]);
}
