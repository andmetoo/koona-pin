import { expect, type Page } from "@playwright/test";

// The phone in the browser demo (NP-072b): what the app's plugin and the koona-mobile bridge inject
// on a phone, before the page's scripts — the platform with the phone's capabilities, a stub of the
// Back bridge (src/platform/back.ts replaces its `back`), the system's signals (src/platform/system.ts)
// and the safe area as `--kp-inset-*`.

/** A phone the size of the NP-070 frames, and a Galaxy Z Fold's inner screen. */
export const PHONE = { width: 393, height: 852 };
export const FOLD = { width: 1088, height: 821 };

/**
 * iPhone Duo in the Simulator (iOS 27.1): the outer display and the inner one in landscape, with
 * the safe area and the vertical bar the koona-mobile plugin reports there (src/platform/verticalBar.ts).
 */
export const DUO_OUTER = {
  viewport: { width: 466, height: 678 },
  insets: { top: 0, right: 84, bottom: 34, left: 0 },
  bar: { edge: "right", column: [382, 0, 84, 678], status: [382, 0, 84, 174], division: null },
};
export const DUO_INNER = {
  viewport: { width: 951, height: 669 },
  insets: { top: 0, right: 84, bottom: 34, left: 0 },
  bar: { edge: "right", column: [867, 0, 84, 669], status: [867, 0, 84, 124], division: [455.5, 0, 40, 669] },
};

/** A phone build's capabilities (src-tauri/src/capabilities.rs). */
export const phoneCapabilities = {
  file_manager: false,
  tray: false,
  autostart: false,
  updates: "store",
  browser_capture: false,
  mcp: false,
  quit: false,
  folder_picker: false,
  // Android's share sheet; an iPhone has none until its share extension (openPhone).
  share_intake: true,
  haptics: true,
  purchase: "none",
};

/** What Android reports for the look (the bridge's `system()`): battery saver, low RAM, text scale. */
export type SystemSignals = { powerSave: boolean; lowRam: boolean; textScale: number };
const CALM: SystemSignals = { powerSave: false, lowRam: false, textScale: 1 };

/**
 * Android's font size as the WebView draws it (its text zoom, which the koona-mobile plugin keeps
 * equal to the system's font scale): every `font-size` and every `line-height` given as a length
 * grows by `scale`, boxes with a fixed size do not. Chromium in the tests has no text zoom (nor
 * does `--blink-settings=accessibilityFontScaleFactor` reach a page here), and `zoom` would grow
 * the boxes too, so the page's style rules and inline styles are rewritten: each such value
 * becomes `calc((value) * scale)`, again whenever the scale changes or a stylesheet arrives.
 * Sizes in `em` and `%` and unitless line heights follow their scaled parents by themselves.
 * Runs in the page, before its scripts (`page.addInitScript`); `window.__textZoom(scale)` rescales.
 */
function textZoom(initial: number) {
  let scale = initial;
  const PROPS = ["font-size", "line-height"];
  /** A length: px or rem, or what a variable or a calc() may give. A bare number is a factor. */
  const length = (value: string) => /px|rem|var\(|calc\(/.test(value);
  const originals = new Map<CSSStyleDeclaration, Record<string, string>>();
  const zoomed = (value: string) => (scale === 1 ? value : `calc((${value}) * ${scale})`);
  function zoom(style: CSSStyleDeclaration) {
    let own = originals.get(style);
    if (!own) {
      own = {};
      for (const prop of PROPS) {
        const value = style.getPropertyValue(prop);
        if (value && length(value)) own[prop] = value;
      }
      if (!Object.keys(own).length) return;
      originals.set(style, own);
    }
    for (const [prop, value] of Object.entries(own)) style.setProperty(prop, zoomed(value), style.getPropertyPriority(prop));
  }
  function walk(rules: CSSRuleList) {
    for (const rule of Array.from(rules)) {
      if ("style" in rule) zoom((rule as CSSStyleRule).style);
      if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules);
    }
  }
  const seen = new WeakSet<CSSStyleSheet>();
  function sheets() {
    for (const sheet of Array.from(document.styleSheets)) {
      if (seen.has(sheet)) continue;
      try {
        walk(sheet.cssRules);
        seen.add(sheet);
      } catch {
        // Not loaded yet, or another origin's.
      }
    }
  }
  /** What the inline styles read after the zoom wrote them (the browser simplifies a calc()). */
  const written = new WeakMap<CSSStyleDeclaration, Record<string, string>>();
  /** An inline style React wrote (a feed's letter, the reader's sample sizes): its own value, unless it is ours. */
  function inline(el: Element) {
    const style = (el as HTMLElement).style;
    if (!style) return;
    const own = originals.get(style) ?? {};
    const ours = written.get(style) ?? {};
    for (const prop of PROPS) {
      const value = style.getPropertyValue(prop);
      if (value && length(value) && value !== ours[prop]) own[prop] = value;
    }
    if (!Object.keys(own).length) return;
    originals.set(style, own);
    written.set(style, ours);
    for (const [prop, value] of Object.entries(own)) {
      if (style.getPropertyValue(prop) === ours[prop]) continue;
      style.setProperty(prop, zoomed(value));
      ours[prop] = style.getPropertyValue(prop);
    }
  }
  const watch = new MutationObserver((records) => {
    sheets();
    for (const record of records) {
      if (record.type === "attributes") inline(record.target as Element);
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof Element) {
          inline(node);
          for (const el of Array.from(node.querySelectorAll("[style]"))) inline(el);
        }
      }
    }
  });
  watch.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["style"] });
  document.addEventListener("DOMContentLoaded", sheets);
  window.addEventListener("load", sheets);
  (window as unknown as { __textZoom: (next: number) => void }).__textZoom = (next) => {
    scale = next;
    for (const [style, own] of originals)
      for (const [prop, value] of Object.entries(own)) {
        style.setProperty(prop, zoomed(value), style.getPropertyPriority(prop));
        const ours = written.get(style);
        if (ours) ours[prop] = style.getPropertyValue(prop);
      }
  };
}

/** The frames' iPhone: a 54 status bar and a 34 home indicator. */
const FRAME_INSETS = { top: 54, right: 0, bottom: 34, left: 0 };

/**
 * Opens the demo as a phone with a fresh library, at `viewport`, in `theme`, with the phone's
 * capabilities and `capabilities` over them; `settings` are
 * `koonapin.*` keys without the prefix, as tests/fixtures/app.ts `openApp` takes them.
 */
export async function openPhone(
  page: Page,
  {
    viewport = PHONE,
    theme = "light",
    insets = FRAME_INSETS,
    settings = {},
    capabilities = {},
    system = CALM,
    platform = "android",
    bar = null,
  }: {
    viewport?: { width: number; height: number };
    theme?: "light" | "dark";
    insets?: typeof FRAME_INSETS;
    settings?: Record<string, string>;
    /** Over the phone's: `{ purchase: "paddle" }` for the site's APK. */
    capabilities?: Partial<typeof phoneCapabilities>;
    system?: SystemSignals;
    /** The phone's system: iOS has CSS of its own (`:root[data-platform="ios"]`). */
    platform?: "android" | "ios";
    /** iOS 27.1's vertical bar (iPhone Duo), as the bridge's `bar()` answers. */
    bar?: unknown;
  } = {},
) {
  await page.setViewportSize(viewport);
  await page.addInitScript(textZoom, system.textScale);
  await page.addInitScript(
    ({ capabilities, insets, theme, settings, system, platform, bar }) => {
      const w = window as unknown as Record<string, unknown>;
      w.__KOONA__ = { platform, capabilities };
      let signals = system;
      w.__KOONA_MOBILE__ = {
        back: () => false,
        claim: () => true,
        system: () => ({ ...signals }),
        bar: () => bar,
        systemChanged: (next: typeof system) => {
          signals = next;
          (w.__textZoom as (scale: number) => void)(next.textScale);
          window.dispatchEvent(new Event("koona-system"));
        },
      };
      // As the Android bridge does once the page is there.
      document.addEventListener("DOMContentLoaded", () => {
        for (const [side, px] of Object.entries(insets)) document.documentElement.style.setProperty(`--kp-inset-${side}`, `${px}px`);
      });
      if (!sessionStorage.getItem("phone.started")) {
        sessionStorage.setItem("phone.started", "1");
        localStorage.removeItem("koonapin.demo.v4");
      }
      localStorage.setItem("koonapin.theme", theme);
      for (const [key, value] of Object.entries(settings)) localStorage.setItem(`koonapin.${key}`, value);
    },
    { capabilities: { ...phoneCapabilities, share_intake: platform === "android", ...capabilities }, insets, theme, settings, system, platform, bar },
  );
  await page.goto("/");
  await expect(page.locator("[data-phone]")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** The system's signals change, as Android sends them (battery saver turned on, a new font size). */
export const systemChanged = (page: Page, next: SystemSignals) =>
  page.evaluate((next) => (window as unknown as { __KOONA_MOBILE__: { systemChanged: (n: SystemSignals) => void } }).__KOONA_MOBILE__.systemChanged(next), next);

/** System Back as the bridge calls it: true when the page closed something. */
export const systemBack = (page: Page) => page.evaluate(() => (window as unknown as { __KOONA_MOBILE__: { back: () => boolean } }).__KOONA_MOBILE__.back());

export const navPill = (page: Page) => page.locator("[data-navpill]");
/** The screen on top (the others are hidden); on the Fold the detail pane's, else the list pane's. */
export const topScreen = (page: Page) => page.locator("[data-screen]:not([hidden])").last();
