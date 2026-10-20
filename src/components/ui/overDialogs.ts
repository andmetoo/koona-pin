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

  // Into the dialog on top when a notice appears: looked for after the commit, so a dialog that
  // closes in the same update (a sheet that saved, a confirmation) has gone already.
  useLayoutEffect(() => {
    if (!box || !anchor.current) return;
    const target = on && popovers ? openModal() : null;
    const element = ref.current;
    if (target) {
      if (box.parentNode !== target) target.append(box);
      dressRef.current?.(box, true);
      if (element) {
        element.setAttribute("popover", "manual");
        if (element.matches(":popover-open")) element.hidePopover();
        element.showPopover();
      }
    } else if (box.previousSibling !== anchor.current) {
      home(box, anchor.current, element);
      dressRef.current?.(box, false);
    }
    setHost(target);
  }, [box, on, raise]);

  // Back to its place when that dialog closes or leaves the page without closing.
  useEffect(() => {
    if (!host || !box) return;
    const back = () => {
      if (anchor.current) home(box, anchor.current, ref.current);
      dressRef.current?.(box, false);
      setHost(null);
    };
    const gone = new MutationObserver(() => !host.isConnected && back());
    if (host.parentNode) gone.observe(host.parentNode, { childList: true });
    host.addEventListener("close", back);
    return () => {
      gone.disconnect();
      host.removeEventListener("close", back);
    };
  }, [host, box]);

  // The box goes with the notice.
  useLayoutEffect(() => () => box?.remove(), [box]);

  return (node: ReactNode) =>
    box ? [createElement("span", { key: "anchor", ref: anchor, hidden: true }), createPortal(node, box, "notice")] : node;
}

/** The box back beside its anchor, the notice out of the top layer. */
function home(box: HTMLElement, anchor: HTMLElement, element: HTMLElement | null) {
  if (element?.hasAttribute("popover")) {
    if (element.matches(":popover-open")) element.hidePopover();
    element.removeAttribute("popover");
  }
  anchor.after(box);
}
