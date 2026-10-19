import "../you/you.css";
import type { Route } from "../navigation/stack";
import { usePhone } from "../PhoneContext";
import { Screen, Header } from "../ui/Screen";
import { AboutPage, AppearancePage, BackupsPage, LanguagePage, LayoutPage, ReadingPage, SettingsList, SyncPage } from "../you/SettingsPages";
import { type SettingsPage, settingsPage } from "../you/settingsRoute";

/** Each page's title. */
const TITLES = {
  appearance: "phone.settings.appearance",
  language: "phone.settings.language",
  layout: "phone.settings.layout",
  reading: "phone.settings.reading",
  sync: "phone.settings.sync",
  backups: "phone.settings.backups",
  about: "phone.settings.about",
} as const satisfies Record<SettingsPage, string>;

/**
 * Settings (NP-072b, route `settings`): the list of shelves, or the page `route.page` pushed over
 * it (Appearance, Language, Layout, Reading, Sync, Backups, About & licences). Built from the
 * shared settings logic, never the desktop's SettingsPage; a phone shows only what it has.
 */
export function SettingsScreen({ route, hidden }: { route: Extract<Route, { name: "settings" }>; hidden: boolean }) {
  const { app, stack } = usePhone();
  const { t } = app;
  const page = settingsPage(route.page);
  const title = t(page ? TITLES[page] : "phone.settings.title");
  return (
    <Screen label={title} hidden={hidden} route className="st-screen">
      <Header title={title} account={false} onBack={stack.back} />
      <div className="st-body" data-settings-page={page ?? "list"}>
        {page === "appearance" ? (
          <AppearancePage />
        ) : page === "language" ? (
          <LanguagePage />
        ) : page === "layout" ? (
          <LayoutPage />
        ) : page === "reading" ? (
          <ReadingPage />
        ) : page === "sync" ? (
          <SyncPage />
        ) : page === "backups" ? (
          <BackupsPage />
        ) : page === "about" ? (
          <AboutPage />
        ) : (
          <SettingsList go={(next) => stack.push({ name: "settings", page: next })} />
        )}
      </div>
    </Screen>
  );
}
