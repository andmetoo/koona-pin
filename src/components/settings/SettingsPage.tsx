import { ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppSettings, CaptureStatus, DataSummary } from "../../types";
import { api, isTauri } from "../../services/api";
import {
  appIsOlder,
  browserName,
  captureReport,
  connectedNames,
  incompatible,
  lastSaved,
  statusColor,
  statusLabel,
} from "../../services/capture";
import { describeError } from "../../services/errors";
import { GITHUB_ISSUES_URL } from "../../services/feedback";
import { languages, LanguageSetting, setLanguage, storedLanguage, systemLanguage } from "../../i18n";
import { Theme } from "../../services/preferences";
import { Button } from "../ui/Button";
import { Dot, Segmented, Switch } from "../ui/Controls";

/** Settings in the main area (frame «14 · Настройки»), column 680 px. */
export function SettingsPage({
  theme,
  onTheme,
  settings,
  capture,
  onSettings,
  onCapture,
  onConnect,
  onCopy,
  onNotice,
  onSaveCopy,
  onRestoreBackup,
  onFeedback,
  dataVersion,
}: {
  theme: Theme;
  onTheme: (theme: Theme) => void;
  settings: AppSettings | null;
  capture: CaptureStatus | null;
  onSettings: (settings: AppSettings) => void;
  onCapture: (status: CaptureStatus) => void;
  onConnect: () => void;
  onCopy: (text: string) => void;
  onNotice: (text: string, alert?: boolean) => void;
  /** «Save a copy…» (NP-034): the notice with «Show» is the caller's. */
  onSaveCopy: () => Promise<void>;
  onRestoreBackup: () => void;
  /** «Send feedback…» (NP-088): the dialog is the caller's, it keeps the draft. */
  onFeedback: () => void;
  /** Changes after a restore: the copies are counted again. */
  dataVersion: number;
}) {
  const { t, i18n } = useTranslation();
  const desktop = isTauri();
  const [language, setLanguageSetting] = useState<LanguageSetting>(storedLanguage);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [data, setData] = useState<DataSummary | null>(null);
  const [version, setVersion] = useState("");
  // Several actions can run at once; each keeps its own control disabled.
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const busy = (name: string) => running.has(name);
  const soon = t("common.soon");

  useEffect(() => {
    void api.getDataSummary().then(setData).catch(() => {});
  }, [dataVersion]);
  useEffect(() => {
    void api.getVersion().then(setVersion).catch(() => {});
    if (desktop) void api.getAutostart().then(setAutostart).catch(() => setAutostart(null));
  }, []);

  const attempt = async (name: string, action: () => Promise<void>) => {
    setRunning((prev) => new Set(prev).add(name));
    try {
      await action();
    } catch (err) {
      onNotice(describeError(err), true);
    } finally {
      setRunning((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  };
  const languageName = (code: string) => languages.find((l) => l.code === code)?.name ?? code;
  const size = (bytes: number) =>
    new Intl.NumberFormat(i18n.language, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 }).format(
      bytes / 1_000_000,
    );
  const lastCopy = (() => {
    if (!data?.last_copy) return t("settings.noCopies");
    const date = new Date(data.last_copy);
    const time = date.toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" });
    return date.toDateString() === new Date().toDateString()
      ? t("settings.lastCopyToday", { time })
      : t("settings.lastCopyOn", { date: date.toLocaleDateString(i18n.language, { day: "numeric", month: "long" }), time });
  })();

  return (
    <div className="flex w-full max-w-[680px] flex-col gap-[22px] pb-8">
      <Section title={t("settings.general")}>
        <Row title={t("settings.language")} description={t("settings.languageHint")}>
          <select
            aria-label={t("settings.language")}
            value={language}
            onChange={(e) => {
              setLanguageSetting(e.target.value);
              setLanguage(e.target.value);
            }}
            className="field h-8 w-[240px] py-1"
          >
            <option value="system">{t("settings.languageSystem", { name: languageName(systemLanguage()) })}</option>
            {languages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </Row>
        <Row title={t("settings.theme")} description={t("settings.themeHint")}>
          <Segmented<Theme>
            label={t("settings.theme")}
            value={theme}
            onChange={onTheme}
            options={[
              { value: "system", label: t("settings.themeSystem") },
              { value: "light", label: t("settings.themeLight") },
              { value: "dark", label: t("settings.themeDark") },
            ]}
          />
        </Row>
        <Row title={t("settings.autostart")} description={desktop ? t("settings.autostartHint") : t("settings.desktopOnly")}>
          <Switch
            label={t("settings.autostart")}
            checked={autostart ?? false}
            disabled={!desktop || autostart === null || busy("autostart")}
            onChange={(enabled) =>
              void attempt("autostart", async () => {
                await api.setAutostart(enabled);
                setAutostart(enabled);
              })
            }
          />
        </Row>
        <Row title={t("settings.tray")} description={t("settings.trayHint")}>
          <Switch
            label={t("settings.tray")}
            checked={settings?.close_to_tray ?? true}
            disabled={!desktop || !settings || busy("tray")}
            onChange={(enabled) =>
              void attempt("tray", async () => {
                await api.setCloseToTray(enabled);
                if (settings) onSettings({ ...settings, close_to_tray: enabled });
              })
            }
          />
        </Row>
      </Section>

      <BrowserSection
        capture={capture}
        busy={busy("capture")}
        onConnect={onConnect}
        onRepair={() => void attempt("capture", async () => onCapture(await api.repairCapture()))}
        onReport={() => capture && onCopy(captureReport(capture, version))}
      />

      <Section title={t("settings.data")}>
        <Row title={t("settings.folder")} description={data?.library_folder ?? ""}>
          <Button disabled={!desktop} onClick={() => void attempt("folder", () => api.revealLibraryPlace("data"))}>
            {t("common.open")}
          </Button>
        </Row>
        <Row
          title={t("settings.backups")}
          description={`${t("settings.copies", { count: data?.copies ?? 0 })} · ${size(data?.bytes ?? 0)} · ${t("settings.keeps")}`}
        >
          <Button disabled={!desktop} onClick={() => void attempt("backups", () => api.revealLibraryPlace("backups"))}>
            {t("settings.openFolder")}
          </Button>
        </Row>
        <Row title={lastCopy} description={t("settings.saveHint")}>
          <Button disabled={!desktop || busy("save")} onClick={() => void attempt("save", onSaveCopy)}>
            {busy("save") ? t("settings.savingCopy") : t("settings.saveCopy")}
          </Button>
          <Button
            disabled={!desktop || busy("copy")}
            onClick={() =>
              void attempt("copy", async () => {
                setData(await api.backUpNow());
                onNotice(t("settings.copyDone"));
              })
            }
          >
            {busy("copy") ? t("settings.copying") : t("settings.backUpNow")}
          </Button>
        </Row>
        <Row title={t("settings.restoreBackup")} description={t("settings.restoreHint")}>
          <Button onClick={onRestoreBackup}>{t("settings.restore")}</Button>
        </Row>
        <Row title={t("settings.searchIndex")} description={t("settings.searchIndexHint")}>
          <Button
            disabled={busy("index")}
            onClick={() =>
              void attempt("index", async () => {
                const count = await api.rebuildSearchIndex();
                onNotice(t("settings.rebuildDone", { count }));
              })
            }
          >
            {busy("index") ? t("settings.rebuilding") : t("settings.rebuild")}
          </Button>
        </Row>
      </Section>
      <p className="-mt-2.5 px-3 text-xs leading-[17px] text-muted">{t("settings.backupNote")}</p>

      <Section title={t("settings.support")}>
        <Row title={t("settings.feedback")} description={t("settings.feedbackHint")}>
          <Button onClick={onFeedback}>{t("settings.feedbackButton")}</Button>
        </Row>
        <Row title={t("settings.github")} description={t("settings.githubHint")}>
          <Button onClick={() => void attempt("github", () => api.openUrl(GITHUB_ISSUES_URL))}>{t("common.open")}</Button>
        </Row>
      </Section>

      <p className="flex flex-wrap items-center gap-3 px-3 text-xs text-subtle">
        <span>Netami Pin {version}</span>
        <span title={soon} className="text-faint">
          {t("settings.checkUpdates")}
        </span>
      </p>
    </div>
  );
}

/** Settings → Browser and its states (frame 14, «Блок «Браузер» — другие состояния»). */
function BrowserSection({
  capture,
  busy,
  onConnect,
  onRepair,
  onReport,
}: {
  capture: CaptureStatus | null;
  busy: boolean;
  onConnect: () => void;
  onRepair: () => void;
  onReport: () => void;
}) {
  const { t, i18n } = useTranslation();
  const title = t("settings.browser");
  const state = capture?.state;
  if (state === "lost" || state === "incompatible" || state === "failing") {
    const outdated = incompatible(capture);
    const text =
      state === "lost"
        ? t("browser.lostText", { count: capture?.days_silent ?? 3 })
        : state === "incompatible"
          ? t(appIsOlder(capture) ? "browser.updateAppText" : "browser.updateText", {
              browser: outdated ? browserName[outdated.browser] : "",
              version: outdated?.extension_version ?? "?",
            })
          : t(`browser.problem_${capture?.problem ?? "channel"}`);
    const failing = state === "failing";
    return (
      <section className="flex flex-col gap-2" data-capture={state}>
        <h2 className="text-2xs font-semibold text-subtle uppercase">{title}</h2>
        <div
          className={`flex flex-col items-start gap-2.5 rounded-xl px-4 py-3.5 ${failing ? "bg-danger-soft text-on-danger-soft" : "border border-line bg-card"}`}
        >
          <div className="flex items-center gap-2.5 text-sm font-medium">
            <Dot color={statusColor(capture)} />
            {statusLabel(capture, t)}
          </div>
          <p className={`text-sm leading-[18px] ${failing ? "" : "text-muted"}`}>{text}</p>
          <div className="flex gap-2">
            {failing ? (
              <>
                <Button variant="onDanger" disabled={busy} onClick={onRepair}>
                  {t("common.retry")}
                </Button>
                <Button variant="onDanger" onClick={onReport}>
                  {t("browser.copyReport")}
                </Button>
              </>
            ) : (
              <Button onClick={onConnect}>{state === "lost" ? t("browser.howToConnect") : t("browser.howToUpdate")}</Button>
            )}
          </div>
        </div>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-2" data-capture={state ?? "checking"}>
      <h2 className="text-2xs font-semibold text-subtle uppercase">{title}</h2>
      <div className="rounded-xl border border-line bg-card">
        <Row
          title={
            <span className="flex items-center gap-2.5">
              <Dot color={statusColor(capture)} />
              {state === "connected" ? t("browser.connectedTo", { browsers: connectedNames(capture) }) : statusLabel(capture, t)}
            </span>
          }
          description={state === "connected" ? lastSaved(capture, t, i18n.language) : state === "none" ? t("browser.notConnectedHint") : ""}
        >
          <Button onClick={onConnect}>{state === "connected" ? t("settings.connectBrowser") : t("browser.connect")}</Button>
        </Row>
      </div>
    </section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-2xs font-semibold text-subtle uppercase">{title}</h2>
      <div className="divide-y divide-divider rounded-xl border border-line bg-card">{children}</div>
    </section>
  );
}

function Row({
  title,
  description,
  children,
  danger = false,
}: {
  title: ReactNode;
  description: string;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <div className="flex min-h-[60px] items-center gap-4 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-medium ${danger ? "text-danger" : ""}`}>{title}</div>
        {description && <div className="mt-0.5 truncate text-xs text-muted">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}
