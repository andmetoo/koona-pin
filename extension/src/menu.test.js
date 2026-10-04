import { describe, it, expect, vi } from "vitest";
import { MENU_ID, onMenuClicked, registerMenu } from "./menu.js";

describe("toolbar button menu", () => {
  it("adds one settings item to the button where the browser has menus", async () => {
    const menus = { removeAll: vi.fn(async () => {}), create: vi.fn() };
    expect(await registerMenu(menus)).toBe(true);
    expect(menus.removeAll).toHaveBeenCalledBefore(menus.create);
    expect(menus.create).toHaveBeenCalledWith({ id: MENU_ID, title: "menuOptions", contexts: ["action"] });
  });

  it("adds nothing in Chrome and Edge, which have no menus", async () => {
    expect(await registerMenu(undefined)).toBe(false);
  });

  it("opens the settings page only for its own item", () => {
    const open = vi.fn();
    onMenuClicked({ menuItemId: "other" }, open);
    expect(open).not.toHaveBeenCalled();
    onMenuClicked({ menuItemId: MENU_ID }, open);
    expect(open).toHaveBeenCalledOnce();
  });
});
