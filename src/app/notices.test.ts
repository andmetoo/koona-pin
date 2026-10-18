import { describe, expect, it } from "vitest";
import { NOTICE_MS, noticeDuration, UNDO_MS } from "./notices";

describe("notices (frames 12, 20, 21, 29)", () => {
  it("a plain notice goes after 3 s, one with Undo or a long one after 8 s, an alert stays", () => {
    expect(noticeDuration({ text: "Saved", alert: false })).toBe(NOTICE_MS);
    expect(noticeDuration({ text: "Moved", alert: false, undo: () => {} })).toBe(UNDO_MS);
    expect(noticeDuration({ text: "Exported", alert: false, long: true })).toBe(UNDO_MS);
    expect(noticeDuration({ text: "Failed", alert: true, retry: () => {} })).toBeNull();
  });
});
