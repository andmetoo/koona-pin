/** How long a toggle's own ask outranks the library's copy (the copy follows in well under it). */
export const ASKED_MS = 3000;

/** What a toggle last asked for, and when. */
export type Asked = { on: boolean; at: number };

/**
 * Where a toggle stands for its next tap (#416): what it last asked for while that ask is fresh and
 * the library's copy has not shown it yet, so a second quick tap undoes the first instead of
 * sending it again; otherwise what the copy shows.
 */
export function toggleState(shown: boolean, last: Asked | undefined, now = Date.now()): boolean {
  return last && now - last.at < ASKED_MS ? last.on : shown;
}

/**
 * The asks still worth keeping once the library's copy changes: one the copy now shows is done
 * (later changes, an Undo among them, are the copy's to show), and an old one no longer counts.
 * `shownOf` reads the copy's state for a key, `undefined` when that bookmark is not loaded.
 */
export function settleAsked(asked: Map<string, Asked>, shownOf: (key: string) => boolean | undefined, now = Date.now()) {
  for (const [key, last] of asked) {
    const shown = shownOf(key);
    if (shown === undefined || shown === last.on || now - last.at >= ASKED_MS) asked.delete(key);
  }
}
