import { describe, it, expect } from "vitest";
import { answerState, collectionColor, shortDate, shortcutFrom, siteTile } from "./search-model.js";

describe("quick search rules (NP-082)", () => {
  it("colours collections as the app does, by id", () => {
    expect(collectionColor(1)).toBe("#c9785a");
    expect(collectionColor(3, true)).toBe("#8aa3d0");
    expect(collectionColor(6)).toBe(collectionColor(1));
  });

  it("gives a site a steady letter and colour without asking the network", () => {
    expect(siteTile("www.github.com")).toEqual(siteTile("github.com"));
    expect(siteTile("github.com").letter).toBe("G");
    expect(siteTile("яндекс.рф").letter).toBe("Я");
    expect(siteTile("").letter).toBe("•");
  });

  it("dates rows as today, this year or another year", () => {
    const now = new Date(2026, 9, 5, 18, 0);
    expect(shortDate(new Date(2026, 9, 5, 9, 0).toISOString(), { now, today: "Сегодня" })).toBe("Сегодня");
    expect(shortDate(new Date(2026, 9, 2).toISOString(), { now })).toBe("Oct 2");
    expect(shortDate(new Date(2025, 9, 2).toISOString(), { now })).toBe("Oct 2, 2025");
    expect(shortDate("not a date", { now })).toBe("");
  });

  it("tells why there are no results from the app's answer", () => {
    expect(answerState({ ok: true, items: [] })).toBe("results");
    expect(answerState({ ok: false, code: "host_missing" })).toBe("missing");
    expect(answerState({ ok: false, code: "invalid_request", message: "Неизвестное сообщение" })).toBe("update-app");
    expect(answerState({ ok: false, code: "incompatible_protocol", protocol: 1 })).toBe("update-app");
    expect(answerState({ ok: false, code: "incompatible_protocol", protocol: 9 })).toBe("update-extension");
    expect(answerState({ ok: false, code: "database_error" })).toBe("library");
    expect(answerState({ ok: false, code: "app_unavailable" })).toBe("unavailable");
    expect(answerState(undefined)).toBe("unavailable");
  });

  it("reads a shortcut from a key press as browsers accept it", () => {
    const press = (key, code, mods = {}) => shortcutFrom({ key, code, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
    expect(press("D", "KeyD", { altKey: true, shiftKey: true })).toBe("Alt+Shift+D");
    expect(press("д", "KeyD", { ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+D");
    expect(press("1", "Digit1", { altKey: true })).toBe("Alt+1");
    expect(press("F5", "F5", { ctrlKey: true })).toBe("Ctrl+F5");
    expect(press("D", "KeyD", { shiftKey: true })).toBeNull();
    expect(press("D", "KeyD", { ctrlKey: true, altKey: true })).toBeNull();
    expect(press("Shift", "ShiftLeft", { altKey: true, shiftKey: true })).toBeNull();
  });
});
