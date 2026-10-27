import { describe, expect, it } from "vitest";
import { ASKED_MS, toggleState } from "./toggle";

describe("toggleState", () => {
  it("takes the library's copy when nothing was asked", () => {
    expect(toggleState(false, undefined, 0)).toBe(false);
    expect(toggleState(true, undefined, 0)).toBe(true);
  });

  it("takes the fresh ask while the copy still shows the old state: a second tap undoes the first", () => {
    expect(toggleState(false, { on: true, at: 1000 }, 1500)).toBe(true);
    expect(toggleState(true, { on: false, at: 1000 }, 1500)).toBe(false);
  });

  it("takes the copy once it shows the ask", () => {
    expect(toggleState(true, { on: true, at: 1000 }, 1500)).toBe(true);
  });

  it("takes the copy once the ask is old: a change made elsewhere wins", () => {
    expect(toggleState(false, { on: true, at: 1000 }, 1000 + ASKED_MS)).toBe(false);
  });
});
