import { t } from "./ext.js";

/**
 * The toolbar button's right-click menu. «Find a link» opens the quick search
 * (NP-082) in every browser, with its shortcut in the title: browser menus
 * show no shortcuts of their own. Firefox's and Safari's buttons have no
 * «Options» item, as Chrome and Edge have, so there the menu also offers the
 * settings page with the queue (NP-018, NP-119). A left click saves the page.
 *
 * The page's own menu has «Save to Reading» (NP-125, Р-69): on the page (or a
 * selection on it) for the page, on a link for the link. Browsers show the
 * page item only where no link, image or selection is under the pointer.
 * Safari shows its items flat, without the extension's icon or name, next to
 * its own Reading List: there they name the app (#319).
 */
export const MENU_ID = "koonapin-options";
export const SEARCH_ID = "koonapin-search";
export const READING_PAGE_ID = "koonapin-reading-page";
export const READING_LINK_ID = "koonapin-reading-link";
const WEB = ["http://*/*", "https://*/*"];

const titled = (title, shortcut) => (shortcut ? `${title} (${shortcut})` : title);

/** Menus outlive an event page, not an update: build the items afresh. */
export async function registerMenu(menus, { settings = false, named = false, shortcut = "", readingShortcut = "" } = {}) {
  if (!menus) return false;
  await menus.removeAll();
  menus.create({ id: SEARCH_ID, title: titled(t("menuSearch"), shortcut), contexts: ["action"] });
  if (settings) menus.create({ id: MENU_ID, title: t("menuOptions"), contexts: ["action"] });
  menus.create({
    id: READING_PAGE_ID,
    title: titled(named ? t("commandReading") : t("menuReadingPage"), readingShortcut),
    contexts: ["page", "selection"],
    documentUrlPatterns: WEB,
  });
  menus.create({
    id: READING_LINK_ID,
    title: named ? t("menuReadingLinkNamed") : t("menuReadingLink"),
    contexts: ["link"],
    targetUrlPatterns: WEB,
  });
  return true;
}

/**
 * What to save from a «Save to Reading» item: the page of the tab, or the
 * link with its text (Firefox gives it; Chrome and Edge do not, and the queue
 * then names it by its site until the app reads the page). The tab is kept for
 * the answer on the button and on the page.
 */
export function readingTarget(info, tab) {
  if (info?.menuItemId === READING_LINK_ID)
    return { id: tab?.id, windowId: tab?.windowId, url: info.linkUrl ?? "", title: info.linkText?.trim() || "" };
  return { ...tab, url: tab?.url || info?.pageUrl || "" };
}

export function onMenuClicked(info, tab, { openOptions, openSearch, saveToReading }) {
  if (info?.menuItemId === MENU_ID) return openOptions();
  if (info?.menuItemId === SEARCH_ID) return openSearch();
  if (info?.menuItemId === READING_PAGE_ID || info?.menuItemId === READING_LINK_ID)
    return saveToReading(readingTarget(info, tab));
}
