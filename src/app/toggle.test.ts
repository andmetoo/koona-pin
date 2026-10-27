import { describe, expect, it } from "vitest";
import { ASKED_MS, type Asked, pruneAsked, toggleState } from "./toggle";

describe("toggleState", () => {
  it("takes the library's copy when nothing was asked", () => {
    expect(toggleState(false, 3, undefined, 0)).toBe(false);
    expect(toggleState(true, 3, undefined, 0)).toBe(true);
  });

  it("takes the fresh ask while the copy is the one it was asked from: a second tap undoes the first", () => {
    expect(toggleState(false, 3, { on: true, at: 1000, revision: 3 }, 1500)).toBe(true);
    expect(toggleState(true, 3, { on: false, at: 1000, revision: 3 }, 1500)).toBe(false);
  });

  it("takes a newer copy: the change landed", () => {
    expect(toggleState(true, 4, { on: true, at: 1000, revision: 3 }, 1500)).toBe(true);
  });

  it("takes a newer copy that shows the old state again: an Undo came in between", () => {
    expect(toggleState(false, 5, { on: true, at: 1000, revision: 3 }, 1500)).toBe(false);
  });

  it("takes the copy once the ask is old", () => {
    expect(toggleState(false, 3, { on: true, at: 1000, revision: 3 }, 1000 + ASKED_MS)).toBe(false);
  });
});

describe("pruneAsked", () => {
  it("drops the asks that no longer count and keeps the fresh ones", () => {
    const asked = new Map<string, Asked>([
      ["reading:1", { on: true, at: 0, revision: 1 }],
      ["reading:2", { on: false, at: 2000, revision: 1 }],
    ]);
    pruneAsked(asked, ASKED_MS + 1);
    expect([...asked.keys()]).toEqual(["reading:2"]);
  });
});
