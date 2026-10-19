import { ReactNode, RefObject, useEffect, useLayoutEffect, useMemo, useReducer } from "react";
import { createPortal } from "react-dom";

/** Engines with the Popover API: WebView2, WebKit from Safari 17, WebKitGTK 2.42. */
const popovers = typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;

/** The modal dialog on top, if one is open. */
function openModal(): HTMLDialogElement | null {
  try {
    return [...document.querySelectorAll("dialog[open]")].filter((d): d is HTMLDialogElement => d.matches(":modal")).at(-1) ?? null;
  } catch {
    return null;
  }
}

/**
 * A notice that stays readable over an open dialog: a modal dialog makes the rest of the window
 * inert under its backdrop, so «Couldn't open the link» from inside a dialog would be neither seen nor
 * read out. A notice that appears while a dialog is open (`raise` changes) goes into the dialog on top
 * and into the top layer (a manual popover); a dialog opened later covers an older notice, as any
 * window does. When its dialog closes, or went away in the same update, the notice comes back to its
 * own place. Without the Popover API it stays where it is, as before.
 */
export function useOverDialogs(ref: RefObject<HTMLElement | null>, on: boolean, raise: unknown) {
  const [tries, again] = useReducer((n: number) => n + 1, 0);
  // Looked up when the notice changes, not on every render of the window.
  const host = useMemo(() => (on && popovers ? openModal() : null), [on, raise, tries]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!on || !popovers || !element) return;
    // Placed in a dialog that closed in the same update: look for the place again.
    if (!element.isConnected) return again();
    if (element.matches(":popover-open")) element.hidePopover();
    element.showPopover();
  }, [on, raise, host]);
  useEffect(() => {
    if (!host) return;
    host.addEventListener("close", again);
    return () => host.removeEventListener("close", again);
  }, [host]);
  return {
    popover: on && popovers ? ("manual" as const) : undefined,
    place: (node: ReactNode) => (host ? createPortal(node, host) : node),
  };
}
