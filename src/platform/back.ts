/**
 * On a phone the koona-mobile plugin's bridge asks the page to go back one level (NP-151): system
 * Back on Android, the swipe from the left edge on iOS (src-tauri/plugins/koona-mobile). What is open
 * registers with {@link onBack} at the place it took when it opened ({@link openPlace}); the one
 * opened last that closes something wins, so a layer that registers again (the editor moving between
 * the side and a drawer as a Fold opens) stays under what opened over it. With none, Android moves
 * the app to the background.
 */
type Bridge = { back: (id?: number) => boolean; claim: (id?: number) => boolean };

const bridge = (): Bridge | undefined =>
  typeof window === "undefined" ? undefined : (window as { __KOONA_MOBILE__?: Bridge }).__KOONA_MOBILE__;

/** Closes one level and says true, or says false when it had nothing to close. */
export type BackHandler = () => boolean;

type Entry = { handler: BackHandler; place: number };
const entries: Entry[] = [];
let lastPlace = 0;

/** A new place on top of everything open so far: take it when a layer opens. */
export function openPlace(): number {
  return ++lastPlace;
}

/**
 * Goes back one level: the handler at the highest place that closes something. With nothing open it
 * says false at once; otherwise `claim` comes first, and a Back it refuses (Android gave up waiting
 * and moved the app to the background) closes nothing.
 */
export function goBack(claim: () => boolean = () => true): boolean {
  if (!entries.length || !claim()) return false;
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
if (installed) installed.back = (id?: number) => goBack(() => installed.claim(id));
