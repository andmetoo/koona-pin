import { expect, type Page } from "@playwright/test";

// The phone in the browser demo (NP-072b): what the app's plugin and the koona-mobile bridge inject
// on a phone, before the page's scripts — the platform with the phone's capabilities, a stub of the
// Back bridge (src/platform/back.ts replaces its `back`) and the safe area as `--kp-inset-*`.

/** A phone the size of the NP-070 frames, and a Galaxy Z Fold's inner screen. */
export const PHONE = { width: 393, height: 852 };
export const FOLD = { width: 1088, height: 821 };

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
  share_intake: false,
  haptics: true,
  purchase: "none",
};

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
  }: {
    viewport?: { width: number; height: number };
    theme?: "light" | "dark";
    insets?: typeof FRAME_INSETS;
    settings?: Record<string, string>;
    /** Over the phone's: `{ purchase: "paddle" }` for the site's APK. */
    capabilities?: Partial<typeof phoneCapabilities>;
  } = {},
) {
  await page.setViewportSize(viewport);
  await page.addInitScript(
    ({ capabilities, insets, theme, settings }) => {
      const w = window as unknown as Record<string, unknown>;
      w.__KOONA__ = { platform: "android", capabilities };
      w.__KOONA_MOBILE__ = { back: () => false, claim: () => true };
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
    { capabilities: { ...phoneCapabilities, ...capabilities }, insets, theme, settings },
  );
  await page.goto("/");
  await expect(page.locator("[data-phone]")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** System Back as the bridge calls it: true when the page closed something. */
export const systemBack = (page: Page) => page.evaluate(() => (window as unknown as { __KOONA_MOBILE__: { back: () => boolean } }).__KOONA_MOBILE__.back());

export const navPill = (page: Page) => page.locator("[data-navpill]");
/** The screen on top (the others are hidden). */
export const topScreen = (page: Page) => page.locator("[data-screen]:not([hidden])");
