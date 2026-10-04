import { t } from "./ext.js";

/**
 * Firefox's toolbar button has no «Options» item of its own, as Chrome and
 * Edge have; a left click saves the page. A right click offers the settings
 * page with the queue (NP-018). Only Firefox has `menus`: elsewhere nothing
 * is added.
 */
export const MENU_ID = "netamipin-options";

/** Menus outlive an event page, not an update: build the item afresh. */
export async function registerMenu(menus) {
  if (!menus) return false;
  await menus.removeAll();
  menus.create({ id: MENU_ID, title: t("menuOptions"), contexts: ["action"] });
  return true;
}

export function onMenuClicked(info, openOptions) {
  if (info?.menuItemId === MENU_ID) return openOptions();
}
