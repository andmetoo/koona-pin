import { t } from "./ext.js";

/**
 * The toolbar button's right-click menu. «Find a link» opens the quick search
 * (NP-082) in every browser, with its shortcut in the title: browser menus
 * show no shortcuts of their own. Firefox's button has no «Options» item, as
 * Chrome and Edge have, so there the menu also offers the settings page with
 * the queue (NP-018). A left click saves the page.
 */
export const MENU_ID = "netamipin-options";
export const SEARCH_ID = "netamipin-search";

/** Menus outlive an event page, not an update: build the items afresh. */
export async function registerMenu(menus, { settings = false, shortcut = "" } = {}) {
  if (!menus) return false;
  await menus.removeAll();
  const search = shortcut ? `${t("menuSearch")} (${shortcut})` : t("menuSearch");
  menus.create({ id: SEARCH_ID, title: search, contexts: ["action"] });
  if (settings) menus.create({ id: MENU_ID, title: t("menuOptions"), contexts: ["action"] });
  return true;
}

export function onMenuClicked(info, { openOptions, openSearch }) {
  if (info?.menuItemId === MENU_ID) return openOptions();
  if (info?.menuItemId === SEARCH_ID) return openSearch();
}
