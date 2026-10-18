import "../you/you.css";
import { ChevronRight, Globe, Hand, History, Info, SunMoon } from "lucide-react";
import { languages, resolveLanguage, storedLanguage } from "../../../i18n";
import { usePhone } from "../PhoneContext";
import { PhIcon } from "../ui/icons";
import { Sheet, useCloseSheet } from "../ui/Sheet";
import { Shelf, ShelfRow } from "../ui/Shelf";
import { useDataSummary, useVersion } from "../you/parts";
import { openSettings, type SettingsPage, themeName } from "../you/settingsRoute";
import { SupporterCard } from "../you/SupporterCard";
import { SyncCard, useSyncCard } from "../you/SyncCard";

export type YouSheetProps = Record<string, never>;

/**
 * A1 "You & sync" (NP-072b): the account cluster opens it, for Supporters and everyone else. The
 * Supporter card, the sync shelf with "Sync now" and the devices, then Settings rows with their
 * values (Appearance, Layout on the Fold, Language, Backups, About & licences), each pushing its
 * settings page over the settings list; the label "Settings" opens the list itself. The footer
 * names the version.
 */
export function YouSheet(_: { props: YouSheetProps }) {
  const { app, stack, fold, hand } = usePhone();
  const { t, theme, dataVersion } = app;
  const close = useCloseSheet();
  const version = useVersion();
  const [data] = useDataSummary(dataVersion);
  const sync = useSyncCard();
  const go = (page?: SettingsPage) => {
    close();
    openSettings(stack, page);
  };
  const language = languages.find((l) => l.code === resolveLanguage(storedLanguage()))?.name;
  return (
    <Sheet label={t("phone.you.title")} title={t("phone.you.title")} className="ys-sheet">
      <SupporterCard />
      {sync.kind !== "hidden" && (
        <section className="ys-section" data-you="sync">
          <h3 className="ys-label">{t("phone.you.sync")}</h3>
          <SyncCard card={sync} />
        </section>
      )}
      <section className="ys-section" data-you="settings">
        <button type="button" className="ys-label ys-label-link ph-hit" onClick={() => go()}>
          {t("phone.you.settings")}
          <PhIcon icon={ChevronRight} size={14} strokeWidth={1.75} />
        </button>
        <Shelf className="ys-shelf">
          <ShelfRow icon={SunMoon} title={t("phone.settings.appearance")} detail={themeName(theme, t)} chevron onClick={() => go("appearance")} />
          {fold && (
            <ShelfRow
              icon={Hand}
              title={t("phone.settings.layout")}
              detail={t(hand === "left" ? "phone.settings.controlsLeft" : "phone.settings.controlsRight")}
              chevron
              onClick={() => go("layout")}
            />
          )}
          <ShelfRow icon={Globe} title={t("phone.settings.language")} detail={language} chevron onClick={() => go("language")} />
          <ShelfRow
            icon={History}
            title={t("phone.settings.backups")}
            detail={data ? (data.copies ? t("phone.you.backupsValue", { count: data.copies }) : t("settings.noCopies")) : undefined}
            chevron
            onClick={() => go("backups")}
          />
          <ShelfRow icon={Info} title={t("phone.settings.about")} chevron onClick={() => go("about")} />
        </Shelf>
      </section>
      <p className="ys-footer">{version && t("phone.you.footer", { version })}</p>
    </Sheet>
  );
}
