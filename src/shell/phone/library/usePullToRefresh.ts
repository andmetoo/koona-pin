import { type RefObject, useEffect, useRef, useState } from "react";
import { selection } from "../../../platform/haptics";

/** How far the finger pulls (after resistance) before a release refreshes. */
export const ARM_PX = 64;
/** The indicator stops here however far the finger goes. */
const MAX_PX = 96;
/** The finger moves twice as far as the indicator. */
const RESISTANCE = 0.5;
/** A refresh shows its spinner at least this long, so a quick one is still seen to happen. */
const MIN_SPIN_MS = 450;

/**
 * Pull to refresh on a screen that scrolls (L1): a pull down while the screen is at its top brings
 * the indicator down with the finger; past {@link ARM_PX} it arms with a `selection()` tick, and a
 * release then runs `onRefresh` while the indicator spins. A pull that goes sideways first (the
 * chips) or starts scrolled is left to the browser. Touch only: a mouse has the scroll wheel.
 *
 * The indicator is moved directly, not through React state, so a pull redraws nothing else; it
 * gets `data-pull` "pulling", "armed" or "refreshing" for its look.
 */
export function usePullToRefresh(scroller: HTMLElement | null, indicator: RefObject<HTMLElement | null>, onRefresh: () => Promise<unknown>, enabled = true) {
  const [refreshing, setRefreshing] = useState(false);
  const run = useRef(onRefresh);
  run.current = onRefresh;
  const busy = useRef(false);

  useEffect(() => {
    if (!scroller || !enabled) return;
    let start: { x: number; y: number } | null = null;
    /** Down, sideways or undecided: a pull decides once the finger has moved a little. */
    let direction: "down" | "other" | null = null;
    let pull = 0;
    let armed = false;
    const show = (px: number, state: "pulling" | "armed" | "refreshing" | null) => {
      const el = indicator.current;
      if (!el) return;
      el.style.transform = `translateY(${px}px)`;
      el.style.setProperty("--pull", String(Math.min(1, px / ARM_PX)));
      if (state) el.dataset.pull = state;
      else delete el.dataset.pull;
    };
    const settle = () => {
      const el = indicator.current;
      if (el) el.style.transition = "";
    };
    const onStart = (e: TouchEvent) => {
      if (busy.current || e.touches.length !== 1 || scroller.scrollTop > 0) return;
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      direction = null;
      pull = 0;
      armed = false;
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const dx = e.touches[0].clientX - start.x;
      const dy = e.touches[0].clientY - start.y;
      if (direction === null) {
        if (Math.hypot(dx, dy) < 8) return;
        direction = dy > 0 && dy > Math.abs(dx) && scroller.scrollTop <= 0 ? "down" : "other";
        if (direction === "down") {
          const el = indicator.current;
          if (el) el.style.transition = "none";
        }
      }
      if (direction !== "down") return;
      // The screen does not scroll or bounce under the pull.
      if (e.cancelable) e.preventDefault();
      pull = Math.max(0, Math.min(MAX_PX, dy * RESISTANCE));
      const now = pull >= ARM_PX;
      if (now && !armed) void selection();
      armed = now;
      show(pull, pull > 0 ? (armed ? "armed" : "pulling") : null);
    };
    const onEnd = () => {
      if (!start) return;
      start = null;
      if (direction !== "down") return;
      settle();
      if (!armed) return show(0, null);
      busy.current = true;
      setRefreshing(true);
      show(ARM_PX, "refreshing");
      const began = Date.now();
      void Promise.resolve()
        .then(() => run.current())
        .catch(() => {})
        .then(() => new Promise((done) => window.setTimeout(done, Math.max(0, MIN_SPIN_MS - (Date.now() - began)))))
        .then(() => {
          busy.current = false;
          setRefreshing(false);
          show(0, null);
        });
    };
    scroller.addEventListener("touchstart", onStart, { passive: true });
    scroller.addEventListener("touchmove", onMove, { passive: false });
    scroller.addEventListener("touchend", onEnd);
    scroller.addEventListener("touchcancel", onEnd);
    return () => {
      scroller.removeEventListener("touchstart", onStart);
      scroller.removeEventListener("touchmove", onMove);
      scroller.removeEventListener("touchend", onEnd);
      scroller.removeEventListener("touchcancel", onEnd);
    };
  }, [scroller, indicator, enabled]);

  return refreshing;
}
