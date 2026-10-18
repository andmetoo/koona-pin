import { useEffect, useState } from "react";
import { safeArea } from "./safeArea";

/**
 * Taller than any system bar: what is left of the screen's bottom beyond this is the keyboard.
 * Android's three-button bar is 48 dp, a Fold's taskbar about 60.
 */
const KEYBOARD_MIN = 120;

/**
 * The on-screen keyboard is up (NP-072b): Android passes it in the bottom safe area (the
 * koona-mobile plugin, `--safe-bottom`); iOS and a browser shrink the visual viewport instead.
 */
export function keyboardUp(safeBottom: number, layoutHeight: number, visualHeight: number | null): boolean {
  return safeBottom > KEYBOARD_MIN || (visualHeight !== null && layoutHeight - visualHeight > KEYBOARD_MIN);
}

const measure = () => keyboardUp(safeArea().bottom, window.innerHeight, window.visualViewport?.height ?? null);

/** {@link keyboardUp}, followed live: the nav pill hides meanwhile. */
export function useKeyboardUp(): boolean {
  const [up, setUp] = useState(measure);
  useEffect(() => {
    // After the safe area's own listeners have forgotten the old measure.
    const update = () => requestAnimationFrame(() => setUp(measure()));
    const viewport = window.visualViewport;
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    return () => {
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, []);
  return up;
}
