/**
 * The focus given back by the app (a closed editor returns it where it came from), not
 * moved by the person: a control that shows something on keyboard focus (the note
 * marker, #410) shows nothing then. Focus events fire inside `focus()`, so the flag
 * is up exactly while they run.
 */
let restoring = false;

export function restoreFocus(element: HTMLElement | null | undefined) {
  restoring = true;
  try {
    element?.focus();
  } finally {
    restoring = false;
  }
}

/** True inside a focus event that `restoreFocus` caused. */
export const isRestoringFocus = () => restoring;
