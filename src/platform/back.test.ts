import { describe, expect, it } from "vitest";
import { goBack, onBack, openPlace } from "./back";

describe("back", () => {
  it("goes back one level, newest first, and says when there was nothing to close", () => {
    const closed: string[] = [];
    const offEditor = onBack(() => (closed.push("editor"), true));
    const offIdle = onBack(() => false);
    const offDialog = onBack(() => (closed.push("dialog"), true));
    expect(goBack()).toBe(true);
    expect(closed).toEqual(["dialog"]);
    offDialog();
    // A handler with nothing open passes Back on.
    expect(goBack()).toBe(true);
    expect(closed).toEqual(["dialog", "editor"]);
    offEditor();
    offIdle();
    expect(goBack()).toBe(false);
  });

  it("keeps a layer that registers again under what opened over it (a Fold unfolding with the editor open)", () => {
    const closed: string[] = [];
    // The editor opens, then a dialog over it.
    const editorPlace = openPlace();
    let offEditor = onBack(() => (closed.push("editor"), true), editorPlace);
    const offDialog = onBack(() => (closed.push("dialog"), true), openPlace());
    // The screen changes size: the editor moves between the side and a drawer and registers again.
    offEditor();
    offEditor = onBack(() => (closed.push("editor"), true), editorPlace);
    expect(goBack()).toBe(true);
    expect(closed).toEqual(["dialog"]);
    offDialog();
    expect(goBack()).toBe(true);
    expect(closed).toEqual(["dialog", "editor"]);
    offEditor();
  });
});

describe("a Back the phone gave up on", () => {
  it("closes nothing when it is not claimed, and nothing is asked with nothing open", () => {
    const closed: string[] = [];
    let asked = 0;
    expect(goBack(() => (asked++, true))).toBe(false);
    expect(asked).toBe(0);
    const off = onBack(() => (closed.push("dialog"), true));
    expect(goBack(() => false)).toBe(false);
    expect(closed).toEqual([]);
    expect(goBack(() => true)).toBe(true);
    expect(closed).toEqual(["dialog"]);
    off();
  });
});
