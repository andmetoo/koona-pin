import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { arrowTarget, deleteKey, isDeleteKey, isMac, shiftShortcut, shortcut } from "./keys";

describe("the platform's modifier (#319)", () => {
  it("is ⌘ on a Mac, Ctrl elsewhere", () => {
    expect(isMac("MacIntel")).toBe(true);
    expect(isMac("iPad")).toBe(true);
    expect(isMac("Win32")).toBe(false);
    expect(isMac("Linux x86_64")).toBe(false);
  });
  it("deletes with Del everywhere, and with ⌫ and ⌘⌫ on a Mac (#297)", () => {
    const key = (key: string, mods: Partial<KeyboardEvent> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, ...mods });
    expect(isDeleteKey(key("Delete"), false)).toBe(true);
    expect(isDeleteKey(key("Delete"), true)).toBe(true);
    expect(isDeleteKey(key("Backspace"), false)).toBe(false);
    expect(isDeleteKey(key("Backspace"), true)).toBe(true);
    expect(isDeleteKey(key("Backspace", { metaKey: true }), true)).toBe(true);
    expect(isDeleteKey(key("Backspace", { altKey: true }), true)).toBe(false);
    expect(isDeleteKey(key("Backspace", { ctrlKey: true }), true)).toBe(false);
  });

  it("writes a shortcut as the platform does: ⌘K on a Mac, the language's Ctrl elsewhere", async () => {
    expect(shortcut("K", true)).toBe("⌘K");
    expect(shortcut("K", false)).toBe("Ctrl K");
    expect(deleteKey(true)).toBe("⌫");
    expect(deleteKey(false)).toBe("Del");
    const language = i18n.language;
    await i18n.changeLanguage("de");
    expect(shortcut("Z", false)).toBe("Strg Z");
    expect(shortcut("Z", true)).toBe("⌘Z");
    expect(shiftShortcut("A", false)).toBe("Umschalt A");
    expect(shiftShortcut("A", true)).toBe("⇧A");
    await i18n.changeLanguage(language);
    expect(shiftShortcut("A", false)).toBe("Shift A");
  });
  it("no string of any language names Ctrl itself: the shortcut comes in as {{undo}} or {{quit}}", () => {
    for (const language of Object.keys(i18n.options.resources ?? {})) {
      const t = i18n.getFixedT(language);
      expect(t("common.ctrl"), language).toMatch(/^(Ctrl|Strg)$/);
      expect(t("backup.confirmText", { count: 2, copy: "2", when: "", undo: "⌘Z" }), language).toContain("⌘Z");
      expect(t("background.hint", { quit: "⌘Q" }), language).toContain("⌘Q");
      expect(t("readingMode.keysRemove", { key: "⌫" }), language).toMatch(/^⌫ /);
    }
  });
});

describe("arrows in the library (#319)", () => {
  // A grid of 4 columns with 10 bookmarks: rows 0–3, 4–7, 8–9.
  it("← → move by one, across rows, and stop at the ends", () => {
    expect(arrowTarget(1, "ArrowRight", 10, 4)).toBe(2);
    expect(arrowTarget(3, "ArrowRight", 10, 4)).toBe(4);
    expect(arrowTarget(4, "ArrowLeft", 10, 4)).toBe(3);
    expect(arrowTarget(0, "ArrowLeft", 10, 4)).toBeNull();
    expect(arrowTarget(9, "ArrowRight", 10, 4)).toBeNull();
  });
  it("↑ ↓ move by a row; a shorter last row takes its last bookmark", () => {
    expect(arrowTarget(1, "ArrowDown", 10, 4)).toBe(5);
    expect(arrowTarget(6, "ArrowDown", 10, 4)).toBe(9);
    expect(arrowTarget(9, "ArrowDown", 10, 4)).toBeNull();
    expect(arrowTarget(8, "ArrowUp", 10, 4)).toBe(4);
    expect(arrowTarget(2, "ArrowUp", 10, 4)).toBeNull();
  });
  it("the list is one column: ↑ ↓ only", () => {
    expect(arrowTarget(0, "ArrowDown", 3, 1)).toBe(1);
    expect(arrowTarget(2, "ArrowDown", 3, 1)).toBeNull();
    expect(arrowTarget(1, "ArrowUp", 3, 1)).toBe(0);
    expect(arrowTarget(1, "ArrowRight", 3, 1)).toBeNull();
  });
  it("from nowhere any arrow starts at the first; an empty list has nowhere", () => {
    expect(arrowTarget(-1, "ArrowUp", 3, 4)).toBe(0);
    expect(arrowTarget(-1, "ArrowLeft", 3, 1)).toBe(0);
    expect(arrowTarget(-1, "ArrowDown", 0, 4)).toBeNull();
  });
});
