import type { SupporterStatus, SyncStatus } from "../../../types";

/** What the account cluster's green circle shows. */
export type SyncState = "synced" | "syncing" | "offline" | "error";

/**
 * A Supporter sees the heart (a plan here); everyone else, including a build that sells no plan,
 * the settings gear.
 */
export const isSupporter = (supporter: SupporterStatus | null) => !!supporter?.plan;

/**
 * The circle's state from the sync status: an error first, then the phase; sync turned off or
 * out of reach reads as offline (the hairline circle with cloud-off).
 */
export function syncState(sync: SyncStatus | null): SyncState {
  if (!sync || !sync.available || !sync.enabled) return "offline";
  if (sync.error) return "error";
  switch (sync.phase.state) {
    case "online":
      return "synced";
    case "syncing":
    case "connecting":
    case "pending":
      return "syncing";
    default:
      return "offline";
  }
}
