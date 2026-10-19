import { useSyncExternalStore } from "react";

/** A rectangle in CSS pixels of the page: x, y, width, height. */
export type Rect = [number, number, number, number];

/**
 * The system's vertical bar (iOS 27.1, iPhone Duo): on both of its displays the status bar is a
 * column along one edge, where UIKit also puts its own tab bar and toolbar. The koona-mobile
 * plugin describes it (`window.__KOONA_MOBILE__.bar()`, the `koona-bar` event) from
 * `UITraitCollection.verticalBarEdge`, the safe area and the reserved regions:
 *
 * - `edge`: the side it is on;
 * - `column`: the strip it takes, the safe area's inset on that side;
 * - `status`: the time, the network and the camera at the column's top (an occlusion region);
 * - `division`: the fold of the inner display, where content divides in two (none on the outer).
 *
 * Null everywhere else: other iPhones, Android, a desktop, the tests unless they inject one.
 */
export type VerticalBar = {
  edge: "left" | "right";
  column: Rect;
  status: Rect | null;
  division: Rect | null;
};

type Bridge = { bar?: () => unknown };

const bridge = (): Bridge | undefined =>
  typeof window === "undefined" ? undefined : (window as { __KOONA_MOBILE__?: Bridge }).__KOONA_MOBILE__;

const rect = (value: unknown): Rect | null =>
  Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === "number" && Number.isFinite(n)) ? (value as Rect) : null;

/** What the bridge says, checked: a bar with an edge and a column of some width, or null. */
export function parseBar(value: unknown): VerticalBar | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const column = rect(v.column);
  if ((v.edge !== "left" && v.edge !== "right") || !column || column[2] <= 0) return null;
  return { edge: v.edge, column, status: rect(v.status), division: rect(v.division) };
}

function read(): VerticalBar | null {
  try {
    return parseBar(bridge()?.bar?.());
  } catch {
    return null;
  }
}

let current: VerticalBar | null | undefined;
let key = "";

/** The bar now; the same object until it changes. */
export function verticalBar(): VerticalBar | null {
  if (current === undefined) {
    current = read();
    key = JSON.stringify(current);
  }
  return current;
}

const listeners = new Set<() => void>();

function changed() {
  const next = read();
  const nextKey = JSON.stringify(next);
  verticalBar();
  if (nextKey === key) return;
  current = next;
  key = nextKey;
  for (const listener of listeners) listener();
}

/** Calls `listener` whenever the bar changes (a fold, a rotation); returns how to stop. */
export function subscribeBar(listener: () => void): () => void {
  const first = listeners.size === 0;
  listeners.add(listener);
  if (first) {
    window.addEventListener("koona-bar", changed);
    changed();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("koona-bar", changed);
  };
}

/** The vertical bar, rendering again when it changes. */
export function useVerticalBar(): VerticalBar | null {
  return useSyncExternalStore(subscribeBar, verticalBar, verticalBar);
}
