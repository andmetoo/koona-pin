/**
 * The webview is a browser underneath: a right click opened its own menu (Back,
 * Refresh, Save as, Print, Share of a tauri.localhost page), and its keys
 * reloaded, printed or saved the window. None of it belongs to the app. A text
 * field keeps its menu: cut, paste and spelling live there. In development
 * Shift and a right click still open it, for Inspect.
 */

/** Fields whose own menu stays. */
const EDITABLE =
  "textarea, [contenteditable]:not([contenteditable=false]), input:not([type=checkbox], [type=radio], [type=button], [type=submit], [type=reset], [type=range], [type=color], [type=file], [type=image])";

type Keys = Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "metaKey" | "altKey">;

/** Reload, print and save the page: the browser's keys. By `code`, so a Russian layout counts too. */
export function browserKey(e: Keys): boolean {
  if (e.key === "F5") return true;
  return (e.ctrlKey || e.metaKey) && !e.altKey && (e.code === "KeyR" || e.code === "KeyP" || e.code === "KeyS");
}

export function blockBrowserChrome(target: Window, dev = import.meta.env.DEV): void {
  target.addEventListener("contextmenu", (e) => {
    if (dev && e.shiftKey) return;
    if (e.target instanceof Element && e.target.closest(EDITABLE)) return;
    e.preventDefault();
  });
  target.addEventListener("keydown", (e) => browserKey(e) && e.preventDefault(), { capture: true });
}
