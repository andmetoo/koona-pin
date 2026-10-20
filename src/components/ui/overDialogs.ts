import { createElement, ReactNode, RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
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
 * A notice that stays readable over an open dialog. A modal dialog makes the rest of the window inert
 * under its backdrop, so «Couldn't open the link» from inside a dialog would be neither seen nor read
 * out. The notice lives in a box of its own (`display: contents`), which stands where the notice is
 * rendered; a notice that appears while a dialog is open (`raise` changes) has its box moved into that
 * dialog, and the notice `ref` shown in the top layer as a manual popover. When the dialog closes or
 * leaves the page, the box comes back. React keeps the same box all along, so nothing is mounted
 * again: a snackbar keeps its time, a toast its focus. A dialog opened later covers an older notice, as
 * before. Without the Popover API nothing moves.
 *
 * `dress` gives the box what the notice's styles need from its own place while it is in a dialog: the
 * phone's snackbar is styled under `.phone`, and the shared dialogs stand outside it.
 */
export function useOverDialogs(
  ref: RefObject<HTMLElement | null>,
  { on, raise, dress }: { on: boolean; raise: unknown; dress?: (box: HTMLElement, inDialog: boolean) => void },
) {
  const [box] = useState(() => {
    if (typeof document === "undefined") return null;
    const element = document.createElement("div");
    element.style.display = "contents";
    return element;
  });
  const anchor = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<HTMLDialogElement | null>(null);
  const dressRef = useRef(dress);
  dressRef.current = dress;

  // Into the dialog on top when a notice appears, a frame later: a dialog that closes with the notice
  // (the Add sheet that saved, a confirmation) may go in the next update, and the notice stays home.
  useLayoutEffect(() => {
    if (!box) return;
    // The notice is gone (its owner renders nothing, so no anchor either): the box leaves the dialog
    // bare, and comes back beside the anchor with the next notice.
    if (!anchor.current) {
      if (box.parentNode) home(box, null, ref.current);
      dressRef.current?.(box, false);
      setHost(null);
      return;
    }
    const top = on && popovers ? openModal() : null;
    // A new notice in the dialog it is in already is raised there at once; anywhere else it starts home.
    if (top && box.parentNode === top) raiseIn(top, box, ref.current);
    else if (box.previousSibling !== anchor.current) {
      home(box, anchor.current, ref.current);
      dressRef.current?.(box, false);
      setHost(null);
    }
    if (!on || !popovers) return;
    const frame = requestAnimationFrame(() => {
      const target = openModal();
      if (!target || box.parentNode === target || !box.isConnected) return;
      dressRef.current?.(box, true);
      raiseIn(target, box, ref.current);
      setHost(target);
    });
    return () => cancelAnimationFrame(frame);
  }, [box, on, raise]);

  // Back to its place when that dialog closes or leaves the page without closing.
  useEffect(() => {
    if (!host || !box) return;
    const back = () => {
      home(box, anchor.current, ref.current);
      dressRef.current?.(box, false);
      setHost(null);
    };
    // React removes the topmost element that goes, often a wrapper of the dialog: the whole page is
    // watched while the notice is in one.
    const gone = new MutationObserver(() => !host.isConnected && back());
    gone.observe(document.body, { childList: true, subtree: true });
    host.addEventListener("close", back);
    return () => {
      gone.disconnect();
      host.removeEventListener("close", back);
    };
  }, [host, box]);

  // The box goes with its owner.
  useLayoutEffect(
    () => () => {
      if (!box) return;
      box.remove();
      dressRef.current?.(box, false);
    },
    [box],
  );

  return (node: ReactNode) =>
    box ? [createElement("span", { key: "anchor", ref: anchor, hidden: true }), createPortal(node, box, "notice")] : node;
}

/** The box in the dialog, the notice over it in the top layer. */
function raiseIn(dialog: HTMLDialogElement, box: HTMLElement, element: HTMLElement | null) {
  if (box.parentNode !== dialog) dialog.append(box);
  if (!element) return;
  element.setAttribute("popover", "manual");
  if (element.matches(":popover-open")) element.hidePopover();
  element.showPopover();
}

/** The notice out of the top layer, its box back beside the anchor (out of the page without one). */
function home(box: HTMLElement, anchor: HTMLElement | null, element: HTMLElement | null) {
  if (element?.hasAttribute("popover")) {
    if (element.matches(":popover-open")) element.hidePopover();
    element.removeAttribute("popover");
  }
  if (anchor) anchor.after(box);
  else box.remove();
}
