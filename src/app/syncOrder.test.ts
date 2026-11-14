import { describe, expect, it } from "vitest";
import type { SyncStatus } from "../types";
import { newerSync } from "./syncOrder";

const status = (seq: number, enabled = true) => ({ seq, enabled }) as SyncStatus;

describe("sync status order", () => {
  it("keeps the newer status when an older answer comes late", () => {
    const event = status(5);
    expect(newerSync(null, event)).toBe(event);
    expect(newerSync(event, status(4, false))).toBe(event);
    const newer = status(6, false);
    expect(newerSync(event, newer)).toBe(newer);
  });

  it("takes the same status again", () => {
    const again = status(5, false);
    expect(newerSync(status(5), again)).toBe(again);
  });
});
