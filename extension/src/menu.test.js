import { describe, it, expect, vi } from "vitest";
import { MENU_ID, READING_LINK_ID, READING_PAGE_ID, SEARCH_ID, onMenuClicked, readingTarget, registerMenu } from "./menu.js";

const menus = () => ({ removeAll: vi.fn(async () => {}), create: vi.fn() });
const WEB = ["http://*/*", "https://*/*"];
const readingItems = (shortcut) => [
  [{ id: READING_PAGE_ID, title: shortcut ? `menuReadingPage (${shortcut})` : "menuReadingPage", contexts: ["page", "selection"], documentUrlPatterns: WEB }],
  [{ id: READING_LINK_ID, title: "menuReadingLink", contexts: ["link"], targetUrlPatterns: WEB }],
];

describe("toolbar button menu", () => {
  it("offers the quick search with its shortcut, and the settings where the button has no Options", async () => {
    const firefox = menus();
    expect(await registerMenu(firefox, { settings: true, shortcut: "Alt+Shift+D", readingShortcut: "Alt+Shift+R" })).toBe(true);
    expect(firefox.removeAll).toHaveBeenCalledBefore(firefox.create);
    expect(firefox.create.mock.calls).toEqual([
      [{ id: SEARCH_ID, title: "menuSearch (Alt+Shift+D)", contexts: ["action"] }],
      [{ id: MENU_ID, title: "menuOptions", contexts: ["action"] }],
      ...readingItems("Alt+Shift+R"),
    ]);
  });

  it("gives Chrome and Edge only the search, without a shortcut when none is set", async () => {
    const chrome = menus();
    await registerMenu(chrome, { shortcut: "" });
    expect(chrome.create.mock.calls).toEqual([
      [{ id: SEARCH_ID, title: "menuSearch", contexts: ["action"] }],
      ...readingItems(""),
    ]);
    expect(await registerMenu(undefined)).toBe(false);
  });

  it("opens what its own item names", () => {
    const openOptions = vi.fn();
    const openSearch = vi.fn();
    const saveToReading = vi.fn();
    const actions = { openOptions, openSearch, saveToReading };
    onMenuClicked({ menuItemId: "other" }, undefined, actions);
    expect(openOptions).not.toHaveBeenCalled();
    expect(openSearch).not.toHaveBeenCalled();
    expect(saveToReading).not.toHaveBeenCalled();
    onMenuClicked({ menuItemId: MENU_ID }, undefined, actions);
    onMenuClicked({ menuItemId: SEARCH_ID }, undefined, actions);
    expect(openOptions).toHaveBeenCalledOnce();
    expect(openSearch).toHaveBeenCalledOnce();
    expect(saveToReading).not.toHaveBeenCalled();
  });
});

describe("Save to Reading in the page's menu (NP-125)", () => {
  const tab = { id: 7, windowId: 2, url: "https://example.com/article", title: "An article" };

  it("saves the page of the tab, from the page or a selection on it", () => {
    const saveToReading = vi.fn();
    onMenuClicked({ menuItemId: READING_PAGE_ID, pageUrl: tab.url }, tab, { saveToReading });
    expect(saveToReading).toHaveBeenCalledWith(tab);
    // Without the tab's address (no activeTab yet), the page's from the click.
    expect(readingTarget({ menuItemId: READING_PAGE_ID, pageUrl: "https://example.com/p" }, { id: 7 })).toEqual({
      id: 7,
      url: "https://example.com/p",
    });
  });

  it("saves the link, not the page, with its text where the browser gives it", () => {
    const saveToReading = vi.fn();
    const firefox = { menuItemId: READING_LINK_ID, linkUrl: "https://other.example/post", linkText: "  A post  ", pageUrl: tab.url };
    onMenuClicked(firefox, tab, { saveToReading });
    expect(saveToReading).toHaveBeenCalledWith({ id: 7, windowId: 2, url: "https://other.example/post", title: "A post" });
    // Chrome and Edge give no link text: the queue names it by its site.
    expect(readingTarget({ menuItemId: READING_LINK_ID, linkUrl: "https://other.example/post" }, tab).title).toBe("");
  });
});
