import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import {
  ALargeSmall,
  Bug,
  ExternalLink,
  Globe,
  Hand,
  History,
  Info,
  Lock,
  MessageSquare,
  Minus,
  Plus,
  RefreshCw,
  ArchiveRestore,
  Sun,
  SunMoon,
} from "lucide-react";
import { deviceDetail, syncSummary } from "../../../components/commercial/syncText";
import { languages, resolveLanguage, setLanguage, storedLanguage, systemLanguage } from "../../../i18n";
import { capabilities } from "../../../platform/capabilities";
import { api } from "../../../services/api";
import { describeError } from "../../../services/errors";
import { GITHUB_ISSUES_URL, licensesUrl } from "../../../services/feedback";
import type { Theme } from "../../../services/preferences";
import { type ReaderChoice, type ReaderTheme, FONTS, FREE_THEMES, SIZES, SUPPORTER_THEMES, themeLocked } from "../../../services/readerLook";
import { changelogUrl } from "../../../services/update";
import { usePhone } from "../PhoneContext";
import { Button, CircleButton } from "../ui/buttons";
import { Segmented, Toggle } from "../ui/controls";
import { CloudCheck as CloudIcon } from "../ui/icons";
import { Shelf, ShelfRow } from "../ui/Shelf";
import { ChoiceRow, SettingsCard, useDataSummary, useVersion } from "./parts";
import { type SettingsPage, themeName } from "./settingsRoute";
import { SyncCard, useSyncCard, useSyncNow } from "./SyncCard";
import { sizeName } from "./youText";

// The phone's Settings (NP-072b): what the desktop's Settings page offers that a phone has, as
// shelves of rows and a page per topic. Hidden here, by capability or because a phone has no use
// for it: start at sign-in, the tray, quitting, updates (the store's), browser capture, AI
// assistants, the folder picker and the file manager; "Open links" (a tap opens the reader),
// offline copies (no offline copy on a phone, doc/mobile-design.md R1) and the feeds' check
// interval (NP-152).

/** The reader's theme by name: "System" follows the app's theme (FL3). */
const readerThemeName = (theme: ReaderChoice["theme"], t: TFunction) => (theme === "auto" ? t("settings.themeSystem") : t(`readerAa.themes.${theme}`));

/** The list: General, Reading, Sync, Data, Help (FL3's rows: an icon, the name, the value, a chevron). */
export function SettingsList({ go }: { go: (page: SettingsPage) => void }) {
  const { app, fold, hand } = usePhone();
  const { t, i18n, theme, readerLook, sync, setSurface, dataVersion } = app;
  const [data] = useDataSummary(dataVersion);
  const card = useSyncCard();
  const syncNow = useSyncNow();
  // The tone of the desktop's line for the dot, the card's short title as the value (FL3 "Synced · 2 min").
  const summary = sync && card.kind === "on" ? syncSummary(sync, t, i18n.language, "settings") : null;
  const language = languages.find((l) => l.code === resolveLanguage(storedLanguage()))?.name;
  return (
    <>
      <Shelf label={t("phone.settings.general")} className="st-shelf">
        <ShelfRow icon={SunMoon} title={t("phone.settings.appearance")} detail={themeName(theme, t)} chevron onClick={() => go("appearance")} />
        <ShelfRow icon={Globe} title={t("phone.settings.language")} detail={language} chevron onClick={() => go("language")} />
        {fold && (
          <ShelfRow
            icon={Hand}
            title={t("phone.settings.layout")}
            detail={t(hand === "left" ? "phone.settings.controlsLeft" : "phone.settings.controlsRight")}
            chevron
            onClick={() => go("layout")}
          />
        )}
      </Shelf>
      <Shelf label={t("phone.settings.reading")} className="st-shelf">
        <ShelfRow
          icon={ALargeSmall}
          title={t("phone.settings.textSize")}
          detail={t(`phone.settings.sizes.${sizeName(readerLook.choice.size)}`)}
          chevron
          onClick={() => go("reading")}
        />
        <ShelfRow icon={Sun} title={t("phone.settings.readerTheme")} detail={readerThemeName(readerLook.choice.theme, t)} chevron onClick={() => go("reading")} />
      </Shelf>
      {card.kind !== "hidden" && (
        <Shelf label={t("phone.settings.sync")} className="st-shelf">
          <ShelfRow
            icon={CloudIcon}
            title={t("phone.settings.sync")}
            detail={
              summary ? (
                <span className="st-sync-detail" data-tone={summary.tone}>
                  <span className="st-dot" aria-hidden="true" />
                  {card.kind === "on" ? card.title : summary.text}
                </span>
              ) : (
                t(card.kind === "free" ? "sync.withSupporter" : "phone.you.offTitle")
              )
            }
            chevron
            onClick={() => go("sync")}
          />
          {card.kind === "on" && (
            <ShelfRow icon={RefreshCw} title={t("phone.settings.syncNow")} onClick={card.busy || syncNow.running ? undefined : syncNow.run} />
          )}
        </Shelf>
      )}
      <Shelf label={t("phone.settings.data")} className="st-shelf">
        <ShelfRow
          icon={History}
          title={t("phone.settings.backups")}
          detail={data ? (data.copies ? t("phone.you.backupsValue", { count: data.copies }) : t("settings.noCopies")) : undefined}
          chevron
          onClick={() => go("backups")}
        />
      </Shelf>
      <Shelf label={t("phone.settings.help")} className="st-shelf">
        <ShelfRow icon={MessageSquare} title={t("settings.feedback")} chevron onClick={() => setSurface("feedback")} />
        <ShelfRow icon={Info} title={t("phone.settings.about")} chevron onClick={() => go("about")} />
      </Shelf>
    </>
  );
}

/** Appearance: the app's theme; text follows the system's size (Dynamic Type), nothing to set. */
export function AppearancePage() {
  const { app } = usePhone();
  const { t, theme, setTheme } = app;
  return (
    <SettingsCard title={t("phone.settings.theme")} caption={t("phone.settings.themeHint")} footnote={t("phone.settings.textSizeHint")}>
      <Segmented<Theme>
        label={t("phone.settings.theme")}
        value={theme}
        onChange={setTheme}
        className="st-segmented"
        options={[
          { value: "system", label: t("settings.themeSystem") },
          { value: "light", label: t("settings.themeLight") },
          { value: "dark", label: t("settings.themeDark") },
        ]}
      />
    </SettingsCard>
  );
}

/** Language: "System — English" or one of the app's languages, as the desktop's select offers. */
export function LanguagePage() {
  const { app } = usePhone();
  const { t } = app;
  const [setting, setSetting] = useState(storedLanguage);
  const pick = (value: string) => {
    setSetting(value);
    setLanguage(value);
  };
  const systemName = languages.find((l) => l.code === systemLanguage())?.name ?? systemLanguage();
  return (
    <div role="radiogroup" aria-label={t("phone.settings.language")}>
      <Shelf className="st-shelf">
        <ChoiceRow label={t("settings.languageSystem", { name: systemName })} checked={setting === "system"} onSelect={() => pick("system")} />
      </Shelf>
      <Shelf className="st-shelf">
        {languages.map((l) => (
          <ChoiceRow key={l.code} label={l.name} checked={setting === l.code} onSelect={() => pick(l.code)} />
        ))}
      </Shelf>
      <p className="st-note">{t("settings.languageHint")}</p>
    </div>
  );
}

/**
 * Layout (FL3): which side the Fold's rail and main buttons are on, per device. Reachable on any
 * phone through the route; the lists show it only on the unfolded Fold, where it changes anything.
 */
export function LayoutPage() {
  const { app, hand, setHand } = usePhone();
  const { t } = app;
  return (
    <SettingsCard title={t("phone.settings.controls")} caption={t("phone.settings.controlsHint")} footnote={t("phone.settings.controlsTip")}>
      <Segmented<"left" | "right">
        label={t("phone.settings.controls")}
        value={hand}
        onChange={setHand}
        className="st-segmented"
        options={[
          { value: "left", label: t("phone.settings.controlsLeft") },
          { value: "right", label: t("phone.settings.controlsRight") },
        ]}
      />
    </SettingsCard>
  );
}

/**
 * Reading: the Aa panel's choices for the reader (text size, theme, font) and "Mark as read at the
 * end". Paper and Sepia are Supporter's: a tap on one waits for the plan and opens the way to it,
 * as the Aa panel does.
 */
export function ReadingPage() {
  const { app } = usePhone();
  const { t, readerLook, settings, setSettings, setSurface, say } = app;
  const { choice, setChoice, unlocked } = readerLook;
  const [busy, setBusy] = useState(false);
  // The desktop reads the settings when its Settings page opens (app/status.ts); the phone's here.
  useEffect(() => {
    void api
      .getAppSettings()
      .then(setSettings)
      .catch(() => {});
  }, [setSettings]);
  const index = Math.max(0, SIZES.indexOf(choice.size as (typeof SIZES)[number]));
  const size = (step: number) => setChoice({ ...choice, size: SIZES[Math.min(SIZES.length - 1, Math.max(0, index + step))] });
  const pickTheme = (theme: ReaderChoice["theme"]) => {
    if (theme !== "auto" && themeLocked(theme, unlocked)) {
      readerLook.wish({ theme });
      setSurface("supporter");
    } else setChoice({ ...choice, theme });
  };
  const themes: (ReaderTheme | "auto")[] = ["auto", ...FREE_THEMES, ...SUPPORTER_THEMES];
  const anyLocked = SUPPORTER_THEMES.some((theme) => themeLocked(theme, unlocked));
  return (
    <>
      <SettingsCard title={t("phone.settings.textSize")}>
        <div className="st-stepper">
          <CircleButton icon={Minus} kind="well" size={44} label={t("phone.settings.smaller")} disabled={index === 0} onClick={() => size(-1)} />
          <span className="st-stepper-value" aria-live="polite">
            {t(`phone.settings.sizes.${sizeName(choice.size)}`)} · {t("readerAa.sizeValue", { size: choice.size })}
          </span>
          <CircleButton icon={Plus} kind="well" size={44} label={t("phone.settings.larger")} disabled={index === SIZES.length - 1} onClick={() => size(1)} />
        </div>
        <p className="st-sample" data-font={choice.font} style={{ fontSize: choice.size, lineHeight: `${Math.round(choice.size * 1.6)}px` }}>
          {t("phone.settings.sample")}
        </p>
      </SettingsCard>
      <div role="radiogroup" aria-label={t("phone.settings.readerTheme")}>
        <Shelf label={t("phone.settings.readerTheme")} className="st-shelf">
          {themes.map((theme) => {
            const locked = theme !== "auto" && themeLocked(theme, unlocked);
            return (
              <ChoiceRow
                key={theme}
                label={readerThemeName(theme, t)}
                icon={locked ? Lock : undefined}
                checked={choice.theme === theme}
                onSelect={() => pickTheme(theme)}
              />
            );
          })}
        </Shelf>
      </div>
      {anyLocked && <p className="st-note st-note-tight">{t("phone.settings.lockedHint")}</p>}
      <SettingsCard title={t("phone.settings.font")}>
        <Segmented
          label={t("phone.settings.font")}
          value={choice.font}
          onChange={(font) => setChoice({ ...choice, font })}
          className="st-segmented"
          options={FONTS.map((font) => ({ value: font, label: t(`readerAa.fonts.${font}`) }))}
        />
      </SettingsCard>
      <Shelf className="st-shelf">
        <ShelfRow
          title={t("settings.markRead")}
          subtitle={t("settings.markReadHint")}
          trailing={
            <Toggle
              label={t("settings.markRead")}
              checked={settings?.reading_mark_at_end ?? true}
              disabled={!settings || busy}
              onChange={(enabled) => {
                setBusy(true);
                api
                  .setReadingMarkAtEnd(enabled)
                  .then(() => settings && setSettings({ ...settings, reading_mark_at_end: enabled }))
                  .catch((err) => say(describeError(err), true))
                  .finally(() => setBusy(false));
              }}
            />
          }
        />
      </Shelf>
    </>
  );
}

/** Sync: the card of "You & sync", this device and the others with their state, and the Sync dialog. */
export function SyncPage() {
  const { app } = usePhone();
  const { t, i18n, sync, setSurface } = app;
  const card = useSyncCard();
  const version = useVersion();
  return (
    <>
      <div className="st-block">
        <SyncCard card={card} devices={false} />
      </div>
      {card.kind === "on" && sync && (
        <Shelf label={t("phone.settings.devices")} className="st-shelf">
          {card.devices.map((d, i) => (
            <ShelfRow
              key={d.id}
              title={
                <span className="st-device">
                  <span className="st-dot" data-online={d.online || undefined} aria-hidden="true" />
                  {d.name}
                </span>
              }
              subtitle={i === 0 ? `${t("phone.settings.thisDevice")} · ${deviceDetail(d, t, i18n.language, { version })}` : deviceDetail(d, t, i18n.language)}
            />
          ))}
        </Shelf>
      )}
      {card.kind === "on" && (
        <Shelf className="st-shelf">
          <ShelfRow title={t("phone.you.manage")} chevron onClick={() => setSurface("sync")} />
        </Shelf>
      )}
    </>
  );
}

/**
 * Backups: the daily copies on this device, the last one, "Back up now" and restoring one. Saving
 * a copy elsewhere and a Supporter's backup folder need the desktop's file and folder pickers.
 */
export function BackupsPage() {
  const { app } = usePhone();
  const { t, i18n, say, setSurface, dataVersion } = app;
  const [data, setData] = useDataSummary(dataVersion);
  const [busy, setBusy] = useState(false);
  const megabytes = (bytes: number) =>
    new Intl.NumberFormat(i18n.language, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 }).format(bytes / 1_000_000);
  const last = (() => {
    if (!data?.last_copy) return t("settings.noCopies");
    const at = new Date(data.last_copy);
    const values = {
      time: at.toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" }),
      date: at.toLocaleDateString(i18n.language, { day: "numeric", month: "long" }),
    };
    return at.toDateString() === new Date().toDateString() ? t("settings.lastCopyToday", values) : t("settings.lastCopyOn", values);
  })();
  return (
    <>
      <p className="st-note st-note-top">{t("phone.settings.backupsText")}</p>
      <Shelf className="st-shelf">
        <ShelfRow
          icon={History}
          title={last}
          subtitle={data?.copies ? `${t("settings.copies", { count: data.copies })} · ${megabytes(data.bytes)}` : undefined}
        />
        <ShelfRow icon={ArchiveRestore} title={t("settings.restoreBackup")} subtitle={t("settings.restoreHint")} chevron onClick={() => setSurface("backup")} />
      </Shelf>
      <div className="st-actions">
        <Button
          kind="clear"
          block
          disabled={busy}
          onClick={() => {
            setBusy(true);
            api
              .backUpNow()
              .then((next) => {
                setData(next);
                say(t("settings.copyDone"));
              })
              .catch((err) => say(describeError(err), true))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? t("settings.copying") : t("settings.backUpNow")}
        </Button>
      </div>
    </>
  );
}

/** About & licences: the version (the store updates it), what's new, licences, feedback and issues. */
export function AboutPage() {
  const { app } = usePhone();
  const { t, i18n, say, setSurface } = app;
  const version = useVersion();
  const open = (url: string) => void api.openUrl(url).catch((err) => say(describeError(err), true));
  return (
    <>
      <Shelf className="st-shelf">
        <ShelfRow
          icon={Info}
          title={version ? t("sync.version", { version }) : "Koona Pin"}
          subtitle={capabilities.updates === "self" ? undefined : t("phone.settings.storeUpdates")}
        />
        <ShelfRow icon={ExternalLink} title={t("phone.settings.changelog")} chevron onClick={() => version && open(changelogUrl(version))} />
        <ShelfRow icon={ExternalLink} title={t("phone.settings.licences")} subtitle={t("phone.settings.licencesHint")} chevron onClick={() => open(licensesUrl(i18n.language))} />
      </Shelf>
      <Shelf label={t("phone.settings.help")} className="st-shelf">
        <ShelfRow icon={MessageSquare} title={t("settings.feedback")} subtitle={t("settings.feedbackHint")} chevron onClick={() => setSurface("feedback")} />
        <ShelfRow icon={Bug} title={t("settings.github")} subtitle={t("settings.githubHint")} chevron onClick={() => open(GITHUB_ISSUES_URL)} />
      </Shelf>
      <p className="st-note">{t("phone.settings.aboutText")}</p>
    </>
  );
}
