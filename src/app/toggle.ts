/** How long a toggle's own ask outranks the library's copy (the copy follows in well under it). */
export const ASKED_MS = 3000;

/** What a toggle last asked for, and when. */
export type Asked = { on: boolean; at: number };

/**
 * Where a toggle stands for its next tap (#416): what it last asked for while the library's copy
 * still shows the old state and the ask is fresh, so a second quick tap undoes the first instead of
 * sending it again; otherwise what the copy shows, so a change made elsewhere wins.
 */
export function toggleState(shown: boolean, last: Asked | undefined, now = Date.now()): boolean {
  return last && last.on !== shown && now - last.at < ASKED_MS ? last.on : shown;
}
