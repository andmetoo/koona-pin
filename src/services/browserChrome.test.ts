import { describe, expect, it } from "vitest";
import { browserKey } from "./browserChrome";

const press = (code: string, key: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean } = {}) =>
  browserKey({ code, key, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, altKey: !!mods.alt });

describe("the webview's own keys", () => {
  it("takes reload, print and save the page", () => {
    expect(press("F5", "F5")).toBe(true);
    expect(press("F5", "F5", { ctrl: true })).toBe(true);
    expect(press("KeyR", "r", { ctrl: true })).toBe(true);
    expect(press("KeyP", "p", { ctrl: true })).toBe(true);
    expect(press("KeyS", "s", { meta: true })).toBe(true);
  });
  it("counts a Russian layout by the physical key", () => {
    expect(press("KeyR", "к", { ctrl: true })).toBe(true);
    expect(press("KeyP", "з", { ctrl: true })).toBe(true);
  });
  it("leaves typing and the app's shortcuts alone", () => {
    expect(press("KeyR", "r")).toBe(false);
    expect(press("KeyC", "c", { ctrl: true })).toBe(false);
    expect(press("KeyK", "k", { ctrl: true })).toBe(false);
    expect(press("KeyR", "r", { ctrl: true, alt: true })).toBe(false);
  });
});
