import { isMobile } from "./platform";

export type Insets = { top: number; right: number; bottom: number; left: number };

const noInsets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
let measured: Insets | null = null;
let watching = false;

/** Forgets the measured safe area: the next {@link safeArea} measures it again. */
const invalidate = () => {
  measured = null;
};

/**
 * Starts listening for what can change the safe area: a resize or rotation (`env()` changes with
 * it), the visual viewport (the keyboard), and the bridge's new `--kp-inset-*` on the root.
 */
function watchSafeArea() {
  if (watching) return;
  watching = true;
  window.addEventListener("resize", invalidate);
  window.visualViewport?.addEventListener("resize", invalidate);
  if (typeof MutationObserver !== "undefined")
    new MutationObserver(invalidate).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
}

/**
 * A phone's safe area in CSS pixels now: the system bars, the cutout and the keyboard (`--safe-*`,
 * app.css). Zero on a desktop, without touching the page. Read through a probe, since a custom
 * property holding max() has no computed length of its own; measured once and again only after
 * something that can change it.
 */
export function safeArea(): Insets {
  if (!isMobile) return { ...noInsets };
  watchSafeArea();
  if (!measured) {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;visibility:hidden;pointer-events:none;padding:var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left)";
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    const px = (value: string) => parseFloat(value) || 0;
    measured = { top: px(style.paddingTop), right: px(style.paddingRight), bottom: px(style.paddingBottom), left: px(style.paddingLeft) };
    probe.remove();
  }
  return { ...measured };
}
