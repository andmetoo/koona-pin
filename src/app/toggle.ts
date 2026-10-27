/** How long a toggle's own ask outranks the library's copy (the copy follows in well under it). */
export const ASKED_MS = 3000;

/** What a toggle last asked for, when, and the bookmark's revision it was asked from. */
export type Asked = { on: boolean; at: number; revision: number };

/**
 * Where a toggle stands for its next tap (#416): what it last asked for while the library's copy
 * is still the one it was asked from (same revision) and the ask is fresh, so a second quick tap
 * undoes the first instead of sending it again; once the copy is newer — this change landed, or
 * an Undo or a change elsewhere did — what the copy shows.
 */
export function toggleState(shown: boolean, revision: number, last: Asked | undefined, now = Date.now()): boolean {
  return last && last.revision === revision && now - last.at < ASKED_MS ? last.on : shown;
}

/** The asks still worth keeping: the others are dropped, so the map stays as small as the moment. */
export function pruneAsked(asked: Map<string, Asked>, now = Date.now()) {
  for (const [key, last] of asked) if (now - last.at >= ASKED_MS) asked.delete(key);
}
