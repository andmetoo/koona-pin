import { describe, expect, it } from "vitest";
import { ASKED_MS, type Asked, settleAsked, toggleState } from "./toggle";

describe("toggleState", () => {
  it("takes the library's copy when nothing was asked", () => {
    expect(toggleState(false, undefined, 0)).toBe(false);
    expect(toggleState(true, undefined, 0)).toBe(true);
  });

  it("takes a fresh ask the copy has not shown yet: a second tap undoes the first", () => {
    expect(toggleState(false, { on: true, at: 1000 }, 1500)).toBe(true);
    expect(toggleState(true, { on: false, at: 1000 }, 1500)).toBe(false);
  });

  it("takes the copy once the ask is old", () => {
    expect(toggleState(false, { on: true, at: 1000 }, 1000 + ASKED_MS)).toBe(false);
  });
});

describe("settleAsked", () => {
  const shownOf = (shown: Record<string, boolean>) => (key: string) => shown[key];

  it("drops an ask the copy shows: an Undo after it is the copy's to show", () => {
    const asked = new Map<string, Asked>([["reading:1", { on: true, at: 1000 }]]);
    settleAsked(asked, shownOf({ "reading:1": true }), 1500);
    expect(asked.size).toBe(0);
    // The Undo came in: the copy says not in Reading, and nothing outranks it.
    expect(toggleState(false, asked.get("reading:1"), 1600)).toBe(false);
  });

  it("keeps an ask the copy does not show yet, whatever else changed (a progress write)", () => {
    const asked = new Map<string, Asked>([["reading:1", { on: true, at: 1000 }]]);
    settleAsked(asked, shownOf({ "reading:1": false }), 1500);
    expect(asked.get("reading:1")).toEqual({ on: true, at: 1000 });
  });

  it("keeps the last of two quick asks until the copy shows it", () => {
    const asked = new Map<string, Asked>([["reading:1", { on: false, at: 1100 }]]);
    // The first ask (on) landed; the second (off) has not yet.
    settleAsked(asked, shownOf({ "reading:1": true }), 1500);
    expect(asked.get("reading:1")?.on).toBe(false);
  });

  it("drops old asks and those of bookmarks no longer loaded", () => {
    const asked = new Map<string, Asked>([
      ["reading:1", { on: true, at: 0 }],
      ["reading:2", { on: true, at: 2000 }],
    ]);
    settleAsked(asked, shownOf({ "reading:1": false }), ASKED_MS + 1);
    expect(asked.size).toBe(0);
  });
});
