import { safeArea } from "../../platform/safeArea";

/** The part of the window a floating layer may take: 8 px in from its edges, and on a phone inside the safe area, not under the bars or the keyboard (NP-151). */
export function windowBox() {
  const safe = safeArea();
  return { left: safe.left + 8, right: innerWidth - safe.right - 8, top: safe.top + 8, bottom: innerHeight - safe.bottom - 8 };
}

/** Where a floating layer opened from `from` lives: in its modal dialog, whose top layer would cover the body, else in the body. */
export const layerFor = (from?: Element | null) => from?.closest<HTMLElement>("dialog[open]") ?? document.body;
