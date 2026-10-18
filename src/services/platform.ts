/**
 * Which system the app runs on (NP-151), learned once at start from the phone bridge that the
 * koona-mobile plugin injects before this page's scripts run (src-tauri/plugins/koona-mobile).
 * Without it — a desktop build, or the browser demo — it is the desktop.
 *
 * On a phone the bridge also asks the page to go back one level: system Back on Android, the
 * swipe from the left edge on iOS. What is open registers with {@link onBack}; the newest handler
 * that closes something wins. With none, Android moves the app to the background.
 */
export type Platform = "desktop" | "android" | "ios";

type Bridge = { platform: Platform; back: () => boolean };

const bridge = (): Bridge | undefined =>
  typeof window === "undefined" ? undefined : (window as { __KOONA_MOBILE__?: Bridge }).__KOONA_MOBILE__;

export const platform: Platform = bridge()?.platform ?? "desktop";
/** A phone: no window controls, tray, updater, start at sign-in, browser capture or MCP. */
export const isMobile = platform !== "desktop";

/** Closes one level and says true, or says false when it had nothing to close. */
export type BackHandler = () => boolean;

const handlers: BackHandler[] = [];

/** Goes back one level: the newest handler that closes something. */
export function goBack(): boolean {
  for (let i = handlers.length - 1; i >= 0; i--) {
    try {
      if (handlers[i]()) return true;
    } catch (error) {
      console.error(error);
    }
  }
  return false;
}

/** Registers what Back closes while it is open; returns the call that unregisters it. */
export function onBack(handler: BackHandler): () => void {
  handlers.push(handler);
  return () => {
    const at = handlers.lastIndexOf(handler);
    if (at >= 0) handlers.splice(at, 1);
  };
}

const installed = bridge();
if (installed) installed.back = goBack;
