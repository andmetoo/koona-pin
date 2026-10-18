import { useSyncExternalStore } from "react";

/**
 * What the system says about how a phone's interface should draw (NP-072b), from the koona-mobile
 * plugin's bridge (`window.__KOONA_MOBILE__.system()`, read by Android before the page's first
 * render, and the `koona-system` event when it changes):
 *
 * - `powerSave`: Android's battery saver is on;
 * - `lowRam`: the device calls itself a low-RAM one;
 * - `textScale`: how much larger than designed text is drawn: the WebView's text zoom, which
 *   follows the system's font size and scales `font-size` and `line-height` (1 at the normal size,
 *   2 at Android's largest).
 *
 * Without the bridge (a desktop, the browser demo, the tests, iOS for now) it is calm: no saver,
 * no low RAM, a scale of 1.
 */
export type SystemSignals = { powerSave: boolean; lowRam: boolean; textScale: number };

const calm: SystemSignals = { powerSave: false, lowRam: false, textScale: 1 };

type Bridge = { system?: () => Partial<SystemSignals> | undefined };

const bridge = (): Bridge | undefined =>
  typeof window === "undefined" ? undefined : (window as { __KOONA_MOBILE__?: Bridge }).__KOONA_MOBILE__;

function read(): SystemSignals {
  try {
    const now = bridge()?.system?.();
    if (!now) return calm;
    return {
      powerSave: now.powerSave === true,
      lowRam: now.lowRam === true,
      textScale: typeof now.textScale === "number" && now.textScale > 0 ? now.textScale : 1,
    };
  } catch {
    return calm;
  }
}

let current: SystemSignals | null = null;

/** The signals now; the same object until they change. */
export function systemSignals(): SystemSignals {
  if (!current) current = read();
  return current;
}

const listeners = new Set<() => void>();

/** The bridge says something changed: read it again, and tell every listener if it did. */
function changed() {
  const next = read();
  const now = systemSignals();
  if (next.powerSave === now.powerSave && next.lowRam === now.lowRam && next.textScale === now.textScale) return;
  current = next;
  for (const listener of listeners) listener();
}

/** Calls `listener` whenever the signals change; returns how to stop. */
export function subscribeSystem(listener: () => void): () => void {
  const first = listeners.size === 0;
  listeners.add(listener);
  if (first) {
    window.addEventListener("koona-system", changed);
    // What changed while nobody listened.
    changed();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("koona-system", changed);
  };
}

/** The signals, rendering again when one changes. */
export function useSystemSignals(): SystemSignals {
  return useSyncExternalStore(subscribeSystem, systemSignals, systemSignals);
}

/**
 * The glass is drawn as opaque paper (doc/mobile-design.md, "Glass levels" fallback and performance
 * rule 6): battery saver asks the phone to spare its GPU, and a low-RAM device has little to spare.
 */
export const flatGlass = (signals: SystemSignals) => signals.powerSave || signals.lowRam;

/**
 * The accessibility text sizes (doc/mobile-design.md, Dynamic Type): from here floating chrome
 * no longer keeps labels beside icons, and a row's value moves under its name. iOS's first
 * accessibility size draws body text about 1.65 times larger; Android's font sizes are 1.3, 1.5,
 * 1.8 and 2.0 above normal, so 1.8 and 2.0 count. Up to 1.5 the phone's layout holds as designed.
 */
export const LARGE_TEXT = 1.6;
export const largeText = (signals: SystemSignals) => signals.textScale >= LARGE_TEXT;
