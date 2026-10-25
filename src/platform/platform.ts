import type { AppInfo } from "../bindings/AppInfo";
import type { Platform } from "../bindings/Platform";

/**
 * Which system the app runs on and what it can do (NP-151, NP-072a), learned once at start from
 * `window.__KOONA__`, which the app's own plugin injects before this page's scripts run
 * (src-tauri/src/capabilities.rs). Without it — the browser demo, the tests — it is a desktop.
 *
 * Only the shell is chosen by the platform (src/main.tsx); shared code asks {@link capabilities}
 * (./capabilities.ts) what the app can do.
 */
export type { Platform };

/** A desktop build's: what the browser demo and the tests stand for. */
const desktop: AppInfo = {
  platform: "desktop",
  capabilities: {
    file_manager: true,
    tray: true,
    autostart: true,
    updates: "self",
    browser_capture: true,
    mcp: true,
    quit: true,
    folder_picker: true,
    share_intake: false,
    haptics: false,
    icon_service: true,
    purchase: "paddle",
  },
};

const injected = (): AppInfo | undefined =>
  typeof window === "undefined" ? undefined : (window as { __KOONA__?: AppInfo }).__KOONA__;

export const appInfo: AppInfo = injected() ?? desktop;
export const platform: Platform = appInfo.platform;
/** A phone: the phone shell, Back and the safe area. Nowhere else: shared code asks a capability. */
export const isMobile = platform !== "desktop";
