import i18n from "../i18n";

/**
 * Whether the app runs on a Mac (or an iPad), from the webview's platform: ⌘
 * stands where Ctrl does elsewhere. Known at once, without asking Rust.
 */
export function isMac(platform = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent): boolean {
  return /Mac|iPhone|iPad/.test(platform);
}

/**
 * A shortcut with the platform's modifier as the app shows it (#319): «⌘K» on
 * a Mac, «Ctrl K» elsewhere («Strg K» in German). The one place that writes
 * it: hints, menus, notices and the strings that name a shortcut
 * (`{{undo}}`, `{{quit}}`) all take it from here.
 */
export function shortcut(key: string, mac = isMac()): string {
  return mac ? `⌘${key}` : `${i18n.t("common.ctrl")} ${key}`;
}

/** The key that deletes, as a Mac's keyboard and others' name it: ⌫ or Del. */
export const deleteKey = (mac = isMac()) => (mac ? "⌫" : "Del");

/** The arrows that move the selection of the library. */
export type Arrow = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

export const isArrow = (key: string): key is Arrow =>
  key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown";

/**
 * Where an arrow takes the selection in a grid of `columns` (the list is a
 * grid of one): ← → one bookmark, wrapping into the row before or after; ↑ ↓
 * one row, to the last bookmark when the row below is shorter. From nowhere
 * (`index` −1) any arrow starts at the first. `null`: nowhere to go, or ← →
 * in the list.
 */
export function arrowTarget(index: number, key: Arrow, count: number, columns: number): number | null {
  if (count <= 0) return null;
  if (index < 0 || index >= count) return 0;
  if (key === "ArrowLeft" || key === "ArrowRight") {
    if (columns < 2) return null;
    const next = index + (key === "ArrowRight" ? 1 : -1);
    return next >= 0 && next < count ? next : null;
  }
  if (key === "ArrowUp") return index - columns >= 0 ? index - columns : null;
  const row = Math.floor(index / columns);
  if (row >= Math.floor((count - 1) / columns)) return null;
  return Math.min(index + columns, count - 1);
}
