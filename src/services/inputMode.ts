/**
 * How the person moves around: with the keys that move focus, or with the pointer. The browser's
 * `:focus-visible` turns on for any key, so a card clicked and then left with Esc (or F, R, Space)
 * got the ink ring of keyboard focus. The ring and a card's corner buttons follow this instead
 * (`app.css`): `data-input="pointer"` on <html> after a press, `"keys"` after a key that moves.
 */
const MOVING = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

export function inputModeOf(key: string): "keys" | null {
  return MOVING.has(key) ? "keys" : null;
}

export function trackInputMode(target: Window, root: HTMLElement) {
  // Capture: the mode is set before the app's own handlers move focus.
  target.addEventListener(
    "keydown",
    (e) => {
      if (inputModeOf(e.key)) root.dataset.input = "keys";
    },
    true,
  );
  target.addEventListener("pointerdown", () => (root.dataset.input = "pointer"), true);
}
