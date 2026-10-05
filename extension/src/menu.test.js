import { describe, it, expect, vi } from "vitest";
import { MENU_ID, SEARCH_ID, onMenuClicked, registerMenu } from "./menu.js";

const menus = () => ({ removeAll: vi.fn(async () => {}), create: vi.fn() });

describe("toolbar button menu", () => {
  it("offers the quick search with its shortcut, and the settings where the button has no Options", async () => {
    const firefox = menus();
    expect(await registerMenu(firefox, { settings: true, shortcut: "Alt+Shift+D" })).toBe(true);
    expect(firefox.removeAll).toHaveBeenCalledBefore(firefox.create);
    expect(firefox.create.mock.calls).toEqual([
      [{ id: SEARCH_ID, title: "menuSearch (Alt+Shift+D)", contexts: ["action"] }],
      [{ id: MENU_ID, title: "menuOptions", contexts: ["action"] }],
    ]);
  });

  it("gives Chrome and Edge only the search, without a shortcut when none is set", async () => {
    const chrome = menus();
    await registerMenu(chrome, { shortcut: "" });
    expect(chrome.create.mock.calls).toEqual([[{ id: SEARCH_ID, title: "menuSearch", contexts: ["action"] }]]);
    expect(await registerMenu(undefined)).toBe(false);
  });

  it("opens what its own item names", () => {
    const openOptions = vi.fn();
    const openSearch = vi.fn();
    onMenuClicked({ menuItemId: "other" }, { openOptions, openSearch });
    expect(openOptions).not.toHaveBeenCalled();
    expect(openSearch).not.toHaveBeenCalled();
    onMenuClicked({ menuItemId: MENU_ID }, { openOptions, openSearch });
    onMenuClicked({ menuItemId: SEARCH_ID }, { openOptions, openSearch });
    expect(openOptions).toHaveBeenCalledOnce();
    expect(openSearch).toHaveBeenCalledOnce();
  });
});
