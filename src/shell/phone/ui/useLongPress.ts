import { type PointerEvent, useEffect, useRef } from "react";

/** How long a finger stays before a press is long (Android's default long-press timeout). */
export const LONG_PRESS_MS = 500;
/** A finger that moves farther is scrolling, not pressing (a swipe between filters starts past it). */
export const LONG_PRESS_SLOP = 10;

/**
 * A long press on an element (a nav pill slot names itself, a card opens its menu sheet): the
 * handlers to spread on it. `onLongPress` runs once the finger has stayed {@link LONG_PRESS_MS};
 * `onEnd` when it lifts after one. A click that follows a long press is swallowed.
 */
export function useLongPress(onLongPress: () => void, onEnd?: () => void) {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const callbacks = useRef({ onLongPress, onEnd });
  callbacks.current = { onLongPress, onEnd };

  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };
  useEffect(() => cancel, []);

  return {
    onPointerDown: (e: PointerEvent) => {
      fired.current = false;
      origin.current = { x: e.clientX, y: e.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        fired.current = true;
        callbacks.current.onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: PointerEvent) => {
      const from = origin.current;
      if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > LONG_PRESS_SLOP) cancel();
    },
    onPointerUp: () => {
      cancel();
      if (fired.current) callbacks.current.onEnd?.();
    },
    onPointerCancel: () => {
      cancel();
      if (fired.current) callbacks.current.onEnd?.();
    },
    // Something else took the pointer (a swipe between filters): no press any more.
    onLostPointerCapture: () => cancel(),
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
    onClickCapture: (e: { preventDefault: () => void; stopPropagation: () => void }) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}
