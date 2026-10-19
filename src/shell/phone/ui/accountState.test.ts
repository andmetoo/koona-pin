import { describe, expect, it } from "vitest";
import type { SupporterStatus, SyncStatus } from "../../../types";
import { isSupporter, syncState } from "./accountState";

const sync = (more: Partial<SyncStatus>): SyncStatus => ({ enabled: true, available: true, phase: { state: "online" }, error: null, ...more }) as SyncStatus;

describe("the account cluster", () => {
  it("shows the heart only with a plan here", () => {
    expect(isSupporter(null)).toBe(false);
    expect(isSupporter({ available: true, plan: null } as SupporterStatus)).toBe(false);
    expect(isSupporter({ available: true, plan: {} } as SupporterStatus)).toBe(true);
  });

  it("reads the sync circle from the phase, an error first", () => {
    expect(syncState(sync({}))).toBe("synced");
    expect(syncState(sync({ phase: { state: "syncing", done: 1, total: 4 } }))).toBe("syncing");
    expect(syncState(sync({ phase: { state: "connecting" } }))).toBe("syncing");
    expect(syncState(sync({ phase: { state: "pending" } }))).toBe("syncing");
    expect(syncState(sync({ phase: { state: "paused", reason: "update_needed" } as SyncStatus["phase"] }))).toBe("offline");
    expect(syncState(sync({ error: "network" as SyncStatus["error"] }))).toBe("error");
  });

  it("reads sync that is off or out of reach as offline", () => {
    expect(syncState(null)).toBe("offline");
    expect(syncState(sync({ enabled: false }))).toBe("offline");
    expect(syncState(sync({ available: false }))).toBe("offline");
    expect(syncState(sync({ phase: { state: "off" } }))).toBe("offline");
  });
});
