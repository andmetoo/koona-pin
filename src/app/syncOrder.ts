import type { SyncStatus } from "../types";

/**
 * The status to show of the one shown and one that came in: a command's answer can arrive after a
 * newer `sync-status` event, and would put an older state back. Every status the app makes has a
 * larger `seq`; an equal one is the same status again.
 */
export function newerSync(shown: SyncStatus | null, next: SyncStatus): SyncStatus {
  return shown && next.seq < shown.seq ? shown : next;
}
