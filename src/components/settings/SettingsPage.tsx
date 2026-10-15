import { ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AppSettings, CaptureStatus, DataSummary, Desktop, McpAccess, McpStatus, SupporterStatus, SyncStatus, UpdateStatus } from "../../types";
import { useSyncSettingsLine } from "../commercial/SyncRows";
import { api, isTauri } from "../../services/api";
import {
  appIsOlder,
  browserName,
  captureReport,
  connectedNames,
  incompatible,
  lastSaved,
  problemText,
  statusColor,
  statusLabel,
} from "../../services/capture";
import { describeError } from "../../services/errors";
import { GITHUB_ISSUES_URL, licensesUrl } from "../../services/feedback";
import { shortcut } from "../../services/keys";
import { changelogUrl, offer, percent } from "../../services/update";
import { languages, LanguageSetting, setLanguage, storedLanguage, systemLanguage } from "../../i18n";
import { OpenLinks, Theme } from "../../services/preferences";
import { Button } from "../ui/Button";
import { Dot, Segmented, Switch } from "../ui/Controls";
import { Kbd } from "../ui/Hint";

/** Settings in the main area (frame «14 · Настройки»), column 680 px. */
export function SettingsPage({
  theme,
  onTheme,
  settings,
  capture,
  onSettings,
  onCapture,
  onConnect,
  onConnectAssistant,
  onCopy,
  onNotice,
  onSaveCopy,
  onRestoreBackup,
  onFeedback,
  update,
  onUpdate,
  onCheckUpdates,
  dataVersion,
  supporter,
  sync,
  onSync,
  onSupporter,
  openLinks,
  onOpenLinks,
}: {
  /** «Open links» (Р-69, point 5, frame B10): what a title, a double-click and Enter do. */
  openLinks: OpenLinks;
  onOpenLinks: (target: OpenLinks) => void;
  /** Supporter and its sync (sheet 46): the «Sync» row of Data. */
  supporter: SupporterStatus | null;
  sync: SyncStatus | null;
  /** «Set up…» / «Manage…»: the Sync dialog. */
  onSync: () => void;
  /** «Learn more» without Supporter: the Supporter dialog. */
  onSupporter: () => void;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  settings: AppSettings | null;
  capture: CaptureStatus | null;
  onSettings: (settings: AppSettings) => void;
  onCapture: (status: CaptureStatus) => void;
  onConnect: () => void;
  /** «How to connect…» of AI assistants (NP-091, sheet 44). */
  onConnectAssistant: () => void;
  onCopy: (text: string) => void;
  onNotice: (text: string, alert?: boolean) => void;
  /** «Save a copy…» (NP-034): the notice with «Show» is the caller's. */
  onSaveCopy: () => Promise<void>;
  onRestoreBackup: () => void;
  /** «Send feedback…» (NP-088): the dialog is the caller's, it keeps the draft. */
  onFeedback: () => void;
  /** The app's own update (NP-038, sheet 42) and «Update…», which opens the same dialog as the sidebar row. */
  update: UpdateStatus | null;
  onUpdate: () => void;
  /** «Check for updates» and «Try again»: the status comes back through `update`. */
  onCheckUpdates: () => Promise<void>;
  /** Changes after a restore: the copies are counted again. */
  dataVersion: number;
}) {
  const { t, i18n } = useTranslation();
  const desktop = isTauri();
  // Sync (sheet 46, frame 10): only in a build that sells Supporter and has a relay.
  const syncShown = !!supporter?.available && !!sync?.available;
  const hasPlan = !!supporter?.plan;
  const syncLine = useSyncSettingsLine(sync);
  const [language, setLanguageSetting] = useState<LanguageSetting>(storedLanguage);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [data, setData] = useState<DataSummary | null>(null);
  const [version, setVersion] = useState("");
  const [system, setSystem] = useState<Desktop | null>(null);
  // Without a tray (NP-096) the app keeps running «in the background», not «in the tray».
  const tray = system?.tray ?? true;
  // Several actions can run at once; each keeps its own control disabled.
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const busy = (name: string) => running.has(name);

  useEffect(() => {
    void api.getDataSummary().then(setData).catch(() => {});
  }, [dataVersion]);
  useEffect(() => {
    void api.getVersion().then(setVersion).catch(() => {});
    if (desktop) void api.getAutostart().then(setAutostart).catch(() => setAutostart(null));
    void api.getDesktop().then(setSystem).catch(() => {});
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
    const at = moment(data.last_copy, i18n.language);
    return at.today ? t("settings.lastCopyToday", at) : t("settings.lastCopyOn", at);
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
        <Row title={t("settings.autostart")} description={desktop ? t(tray ? "settings.autostartHint" : "settings.autostartHintBackground") : t("settings.desktopOnly")}>
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
        <Row
          title={t(tray ? "settings.tray" : "settings.trayBackground")}
          description={t(tray ? "settings.trayHint" : "settings.trayBackgroundHint")}
        >
          <Switch
            label={t(tray ? "settings.tray" : "settings.trayBackground")}
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
        {/* On every system (NP-096): without a tray it is the way out of the app. */}
        <Row title={t("settings.quit")} description={t("settings.quitHint")}>
          <Kbd>{shortcut("Q")}</Kbd>
          <Button disabled={!desktop} onClick={() => void attempt("quit", api.quitApp)}>
            {t("settings.quitButton")}
          </Button>
        </Row>
      </Section>

      {/* Reading (NP-124, frame B10): how links open, «read» at the end, the R key. */}
      <Section title={t("settings.reading")}>
        <div data-settings-reading="links">
          <Row title={t("settings.openLinks")} description={t("settings.openLinksHint")}>
            <Segmented<OpenLinks>
              label={t("settings.openLinks")}
              value={openLinks}
              onChange={onOpenLinks}
              options={[
                { value: "browser", label: t("settings.openLinksBrowser") },
                { value: "reader", label: t("settings.openLinksReader") },
              ]}
            />
          </Row>
        </div>
        <Row title={t("settings.markRead")} description={t("settings.markReadHint")}>
          <Switch
            label={t("settings.markRead")}
            checked={settings?.reading_mark_at_end ?? true}
            disabled={!settings || busy("markRead")}
            onChange={(enabled) =>
              void attempt("markRead", async () => {
                await api.setReadingMarkAtEnd(enabled);
                if (settings) onSettings({ ...settings, reading_mark_at_end: enabled });
              })
            }
          />
        </Row>
        <Row title={t("card.toReading")} description={t("settings.sendToReadingHint")}>
          <Kbd>R</Kbd>
        </Row>
      </Section>

      <UpdatesSection
        version={version}
        update={update}
        checking={busy("updates")}
        onCheck={() => void attempt("updates", onCheckUpdates)}
        onUpdate={onUpdate}
        onOpen={(url) => void attempt("changelog", () => api.openUrl(url))}
      />

      <BrowserSection
        capture={capture}
        busy={busy("capture")}
        onConnect={onConnect}
        onRepair={() => void attempt("capture", async () => onCapture(await api.repairCapture()))}
        onReport={() => capture && onCopy(captureReport(capture, version))}
      />

      <AssistantsSection onConnect={onConnectAssistant} onNotice={onNotice} />

      <Section title={t("settings.data")}>
        {syncShown && syncLine && hasPlan && (
          <div data-sync-settings="supporter">
            <Row title={t("sync.title")} description={syncLine.description}>
              <Button onClick={onSync}>{syncLine.button}</Button>
            </Row>
          </div>
        )}
        {syncShown && !hasPlan && (
          <div data-sync-settings="free">
            <Row title={<span className="text-muted">{t("sync.withSupporter")}</span>} description="">
              <button type="button" onClick={onSupporter} className="px-1 text-sm font-medium text-accent hover:underline">
                {t("sync.learnMore")}
              </button>
            </Row>
          </div>
        )}
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
        <Row title={t("settings.licenses")} description={t("settings.licensesHint")}>
          <Button onClick={() => void attempt("licenses", () => api.openUrl(licensesUrl(i18n.language)))}>{t("common.open")}</Button>
        </Row>
      </Section>
    </div>
  );
}

/**
 * Settings → Updates (NP-038, sheet 42): the version and the last check. A version on offer gets
 * «Update…», the same dialog as the row in the sidebar, with what changed (NP-040); the AUR package says that
 * pacman updates it and has no button.
 */
function UpdatesSection({
  version,
  update,
  checking,
  onCheck,
  onUpdate,
  onOpen,
}: {
  version: string;
  update: UpdateStatus | null;
  checking: boolean;
  onCheck: () => void;
  onUpdate: () => void;
  onOpen: (url: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const desktop = isTauri();
  const upToDate = (iso: string) => {
    const at = moment(iso, i18n.language);
    return at.today ? t("settings.upToDateToday", at) : t("settings.upToDateOn", at);
  };
  const offered = offer(update);
  const state = checking ? "checking" : (update?.state ?? "unknown");
  let description: string;
  let controls: ReactNode = null;
  if (offered) {
    description =
      offered.state === "downloading"
        ? t("settings.updateDownloading", { version: offered.version, percent: percent(offered) ?? 0 })
        : offered.state === "installing"
          ? t("settings.updateInstalling", { version: offered.version })
          : offered.state === "failed"
            ? t("settings.updateFailed", { version: offered.version })
            : t("settings.updateAvailable", { version: offered.version });
    controls = (
      <Button variant={offered.state === "available" ? "primary" : "secondary"} onClick={onUpdate}>
        {t("settings.updateButton")}
      </Button>
    );
  } else if (state === "checking") {
    description = t("settings.checking");
    controls = (
      <span className="flex items-center gap-2 px-1 text-sm text-muted">
        <span aria-hidden className="size-3.5 animate-spin rounded-full border-[1.5px] border-line border-t-accent dark:border-divider dark:border-t-accent" />
        {t("settings.checkingShort")}
      </span>
    );
  } else if (update?.state === "pacman") {
    description = t("settings.pacman");
  } else {
    description =
      update?.state === "up_to_date"
        ? upToDate(update.checked_at)
        : update?.state === "check_failed"
          ? t("settings.checkFailed")
          : desktop
            ? t("settings.notChecked")
            : t("settings.desktopOnly");
    controls = (
      <Button disabled={!desktop} onClick={onCheck}>
        {update?.state === "check_failed" ? t("common.retry") : t("settings.checkUpdates")}
      </Button>
    );
  }
  // The changelog of the version that runs, on the site (NP-040): left of the button, in every state.
  const changelog = (
    <button type="button" onClick={() => onOpen(changelogUrl(version))} className="px-1 text-sm font-medium text-accent hover:underline">
      {t("settings.changelog")} ↗
    </button>
  );
  return (
    <section className="flex flex-col gap-2" data-update={state}>
      <h2 className="text-2xs font-semibold text-subtle uppercase">{t("settings.updates")}</h2>
      <div className="rounded-xl border border-line bg-card">
        <Row title={`Koona Pin ${version}`} description={description}>
          {changelog}
          {controls}
        </Row>
      </div>
    </section>
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
          : problemText(capture, t);
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

/**
 * Settings → AI assistants (NP-091, sheet 44): off by default; on, the last request, what assistants
 * may do and «How to connect…».
 */
function AssistantsSection({ onConnect, onNotice }: { onConnect: () => void; onNotice: (text: string, alert?: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api.getMcpStatus().then(setStatus).catch(() => {});
    return api.onMcpStatus(setStatus);
  }, []);
  const access = status?.access ?? "off";
  const change = (next: McpAccess) => {
    setBusy(true);
    api
      .setMcpAccess(next)
      .then(setStatus)
      .catch((err) => onNotice(describeError(err), true))
      .finally(() => setBusy(false));
  };
  const on = access !== "off";
  return (
    <Section title={t("settings.assistants")}>
      <div data-mcp={access}>
        <Row title={t("assistants.allow")} description={on ? lastRequest(status, t, i18n.language) : t("assistants.offHint")}>
          <Switch
            label={t("assistants.allow")}
            checked={on}
            disabled={!status || busy}
            onChange={(enabled) => change(enabled ? (status?.mode ?? "read") : "off")}
          />
        </Row>
      </div>
      {on && (
        <>
          <Row title={t("assistants.access")} description={t(access === "read" ? "assistants.readHint" : "assistants.addHint", { undo: shortcut("Z") })}>
            <Segmented<McpAccess>
              label={t("assistants.access")}
              value={access}
              onChange={(next) => !busy && change(next)}
              options={[
                { value: "read", label: t("assistants.read") },
                { value: "read_and_add", label: t("assistants.readAndAdd") },
              ]}
            />
          </Row>
          <Row title={t("assistants.connect")} description={t("assistants.connectHint")}>
            <Button onClick={onConnect}>{t("assistants.howToConnect")}</Button>
          </Row>
        </>
      )}
    </Section>
  );
}

/** «On · last request from Claude Code today at 14:05», or that none came yet. */
function lastRequest(status: McpStatus | null, t: TFunction, language: string) {
  if (!status?.last_at) return t("assistants.noRequests");
  const at = { ...moment(status.last_at, language), client: status.last_client || t("assistants.someone") };
  return at.today ? t("assistants.lastToday", at) : t("assistants.lastOn", at);
}

/** When something happened, for «… today at 14:05» or «… on 3 October at 14:05». */
function moment(iso: string, language: string) {
  const at = new Date(iso);
  return {
    today: at.toDateString() === new Date().toDateString(),
    time: at.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" }),
    date: at.toLocaleDateString(language, { day: "numeric", month: "long" }),
  };
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
  description: ReactNode;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <div className="flex min-h-[60px] items-center gap-4 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-medium ${danger ? "text-danger" : ""}`}>{title}</div>
        {/* A longer language wraps the hint to a second line rather than cutting it (NP-089). */}
        {description && <div className="mt-0.5 text-xs text-pretty [overflow-wrap:anywhere] text-muted">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}
