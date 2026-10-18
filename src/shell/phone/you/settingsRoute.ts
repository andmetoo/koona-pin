import type { TFunction } from "i18next";
import type { PhoneStack } from "../navigation/usePhoneStack";
import type { Theme } from "../../../services/preferences";

/** The phone's settings pages: the `page` of the `settings` route; none is the list. */
export const SETTINGS_PAGES = ["appearance", "language", "layout", "reading", "sync", "backups", "about"] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];

export const settingsPage = (page: string | undefined): SettingsPage | null =>
  (SETTINGS_PAGES as readonly string[]).includes(page ?? "") ? (page as SettingsPage) : null;

/**
 * Opens Settings: the list, and a page over it, so Back from a page returns to the list as on
 * iOS and Android, and every setting stays reachable from "You & sync".
 */
export function openSettings(stack: PhoneStack, page?: SettingsPage) {
  stack.push({ name: "settings" });
  if (page) stack.push({ name: "settings", page });
}

/** The app's theme by name: "System", "Light", "Dark" as the desktop's Settings says. */
export const themeName = (theme: Theme, t: TFunction) =>
  ({ system: t("settings.themeSystem"), light: t("settings.themeLight"), dark: t("settings.themeDark") })[theme];
