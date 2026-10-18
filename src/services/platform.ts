/**
 * Which system the app runs on (NP-151), learned once at start from the phone bridge that the
 * koona-mobile plugin injects before this page's scripts run (src-tauri/plugins/koona-mobile).
 * Without it — a desktop build, or the browser demo — it is the desktop.
 *
 * On a phone the bridge also asks the page to go back one level: system Back on Android, the
 * swipe from the left edge on iOS. What is open registers with {@link onBack} at the place it took
 * when it opened ({@link openPlace}); the one opened last that closes something wins, so a layer that
 * registers again (the editor moving between the side and a drawer as a Fold opens) stays under
 * what opened over it. With none, Android moves the app to the background.
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

type Entry = { handler: BackHandler; place: number };
const entries: Entry[] = [];
let lastPlace = 0;

/** A new place on top of everything open so far: take it when a layer opens. */
export function openPlace(): number {
  return ++lastPlace;
}

/** Goes back one level: the handler at the highest place that closes something. */
export function goBack(): boolean {
  const byPlace = [...entries].sort((a, b) => b.place - a.place);
  for (const { handler } of byPlace) {
    try {
      if (handler()) return true;
    } catch (error) {
      console.error(error);
    }
  }
  return false;
}

/**
 * Registers what Back closes while it is open, at `place` (a new one on top by default); returns the
 * call that unregisters it.
 */
export function onBack(handler: BackHandler, place: number = openPlace()): () => void {
  const entry = { handler, place };
  entries.push(entry);
  return () => {
    const at = entries.indexOf(entry);
    if (at >= 0) entries.splice(at, 1);
  };
}

const installed = bridge();
if (installed) installed.back = goBack;
