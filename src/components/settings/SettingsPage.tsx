import { ReactNode, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { AppSettings, CaptureStatus, DataSummary, Desktop, McpAccess, McpStatus, OfflineStats, PreviewCounts, PreviewRefresh, PreviewScope, SupporterStatus, SyncStatus, UpdateStatus } from "../../types";
import { useSyncSettingsLine } from "../commercial/SyncRows";
import { api, desktopApi, desktopOnly } from "../../services/api";
import { capabilities } from "../../platform/capabilities";
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
import { clearFeedCache, setFeedsRefreshMinutes } from "../../services/feeds";
import { GITHUB_ISSUES_URL, licensesUrl } from "../../services/feedback";
import { shortcut } from "../../services/keys";
import { changelogUrl, offer, percent } from "../../services/update";
import { languages, LanguageSetting, setLanguage, storedLanguage, systemLanguage } from "../../i18n";
import { OpenLinks, savePreference, storedValue, Theme } from "../../services/preferences";
import { Button } from "../ui/Button";
import { Dot, Segmented, Switch } from "../ui/Controls";
import { Kbd } from "../ui/Hint";
import { ConfirmDialog } from "../library/Dialogs";
import { Menu } from "../ui/Menu";
import { helpUrl } from "../../services/help";

/** The groups that fold (sheet S1–S3); General is always open. */
type GroupId = "connections" | "reading" | "feeds" | "backups" | "storage" | "support";
const GROUPS: GroupId[] = ["connections", "reading", "feeds", "backups", "storage", "support"];

/** The open groups, kept between visits; none at first. */
function storedGroups(): Set<GroupId> {
  const saved = storedValue("settingsGroups")?.split(",") ?? [];
  return new Set(GROUPS.filter((id) => saved.includes(id)));
}

/**
 * Settings in the main area (sheet S1–S3), column 680 px. General is always open; the other groups
 * fold and show a summary while folded. A row the build can't do is not shown at all.
 */
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
  onImportFeeds,
  onExportFeeds,
  previews,
  onRefreshPreviews,
  onStopPreviews,
}: {
  /** «Import feeds (OPML)…»: the import dialog for feeds (NP-133). */
  onImportFeeds: () => void;
  /** «Export feeds (OPML)…»: the Save dialog and its notice are the caller's. */
  onExportFeeds: () => Promise<unknown>;
  /** «Refresh previews» of Storage: the run of this session, if any. */
  previews: PreviewRefresh | null;
  onRefreshPreviews: (scope: PreviewScope) => void;
  onStopPreviews: () => void;
  /** «Open links» (Р-69, point 5, frame B10): what a title, a double-click and Enter do. */
  openLinks: OpenLinks;
  onOpenLinks: (target: OpenLinks) => void;
  /** Supporter and its sync (sheet 46): the «Sync» row of Sync and backups. */
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
  // Sync (sheet 46, frame 10): only in a build that sells Supporter and has a relay.
  const syncShown = !!supporter?.available && !!sync?.available;
  const hasPlan = !!supporter?.plan;
  const syncLine = useSyncSettingsLine(sync);
  const [language, setLanguageSetting] = useState<LanguageSetting>(storedLanguage);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [data, setData] = useState<DataSummary | null>(null);
  /** Offline copies (NP-126): how many and how much, read again as the library changes. */
  const [offline, setOffline] = useState<OfflineStats | null>(null);
  const [removingCopies, setRemovingCopies] = useState(false);
  const [version, setVersion] = useState("");
  const [system, setSystem] = useState<Desktop | null>(null);
  const mcp = useMcpStatus(onNotice);
  // Without a tray (NP-096) the app keeps running «in the background», not «in the tray».
  const tray = system?.tray ?? true;
  // Several actions can run at once; each keeps its own control disabled.
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const busy = (name: string) => running.has(name);
  const [open, setOpen] = useState(storedGroups);
  // A capture problem opens Connections (S3, A and B); folded by hand, it stays folded (C). Opened so,
  // it is not the person's choice and is not kept for the next visit.
  const autoOpened = useRef(false);
  const problem = capture?.state === "lost" || capture?.state === "incompatible" || capture?.state === "failing";
  useEffect(() => {
    if (!problem) return;
    setOpen((prev) => {
      if (prev.has("connections")) return prev;
      autoOpened.current = true;
      return new Set(prev).add("connections");
    });
  }, [problem]);
  // Kept with the click itself, so a reload or quit right after it keeps the choice.
  const toggle = (id: GroupId) => {
    if (id === "connections") autoOpened.current = false;
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      savePreference("settingsGroups", [...next].filter((group) => !(autoOpened.current && group === "connections")).join(","));
      return next;
    });
  };

  useEffect(() => {
    void api.getDataSummary().then(setData).catch(() => {});
  }, [dataVersion]);
  useEffect(() => {
    const read = () => void api.offlineStats().then(setOffline).catch(() => {});
    read();
    const offs = [api.onBookmarkChanged(read), api.onBookmarksChanged(read), api.onLibraryInvalidated(read)];
    return () => offs.forEach((off) => off());
  }, [dataVersion]);
  useEffect(() => {
    void api.getVersion().then(setVersion).catch(() => {});
    // A phone has no start at sign-in, tray or window of its own to ask about (NP-151).
    if (capabilities.autostart) void desktopApi?.getAutostart().then(setAutostart).catch(() => setAutostart(null));
    if (capabilities.tray) void desktopApi?.getDesktop().then(setSystem).catch(() => {});
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
  const group = (id: GroupId) => ({ name: id, open: open.has(id), onToggle: () => toggle(id) });
  const feedsMinutes = settings?.feeds_refresh_minutes ?? 60;
  const offlineArticles = t("settings.offlineArticles", { count: offline?.count ?? 0 });

  return (
    <div className="flex w-full max-w-[680px] flex-col gap-3 pb-8">
      <Group name="general" title={t("settings.general")}>
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
        {capabilities.autostart && (
          <Row title={t("settings.autostart")} description={t(tray ? "settings.autostartHint" : "settings.autostartHintBackground")}>
            <Switch
              label={t("settings.autostart")}
              checked={autostart ?? false}
              disabled={autostart === null || busy("autostart")}
              onChange={(enabled) =>
                void attempt("autostart", async () => {
                  await desktopOnly().setAutostart(enabled);
                  setAutostart(enabled);
                })
              }
            />
          </Row>
        )}
        {capabilities.tray && (
          <Row
            title={t(tray ? "settings.tray" : "settings.trayBackground")}
            description={t(tray ? "settings.trayHint" : "settings.trayBackgroundHint")}
          >
            <Switch
              label={t(tray ? "settings.tray" : "settings.trayBackground")}
              checked={settings?.close_to_tray ?? true}
              disabled={!settings || busy("tray")}
              onChange={(enabled) =>
                void attempt("tray", async () => {
                  await desktopOnly().setCloseToTray(enabled);
                  if (settings) onSettings({ ...settings, close_to_tray: enabled });
                })
              }
            />
          </Row>
        )}
        <UpdateRow
          version={version}
          update={update}
          checking={busy("updates")}
          onCheck={() => void attempt("updates", onCheckUpdates)}
          onUpdate={onUpdate}
          onOpen={(url) => void attempt("changelog", () => api.openUrl(url))}
        />
        {/* On every system (NP-096): without a tray it is the way out of the app. */}
        {capabilities.quit && (
          <Row title={t("settings.quit")} description={t("settings.quitHint")}>
            <Kbd>{shortcut("Q")}</Kbd>
            <Button onClick={() => void attempt("quit", () => desktopOnly().quitApp())}>{t("settings.quitButton")}</Button>
          </Row>
        )}
      </Group>

      {/* Desktop only (NP-151): a phone has no browser extension or MCP server. */}
      {(capabilities.browser_capture || capabilities.mcp) && (
        <Group
          title={t("settings.connections")}
          summary={<ConnectionsSummary capture={capabilities.browser_capture ? capture : undefined} mcp={capabilities.mcp ? mcp : undefined} />}
          {...group("connections")}
        >
          {capabilities.browser_capture && (
            <BrowserRows
              capture={capture}
              busy={busy("capture")}
              onConnect={onConnect}
              onRepair={() => void attempt("capture", async () => onCapture(await desktopOnly().repairCapture()))}
              onReport={() => capture && onCopy(captureReport(capture, version))}
            />
          )}
          {capabilities.mcp && <AssistantRows status={mcp.status} onChange={mcp.change} busy={mcp.busy} onConnect={onConnectAssistant} />}
        </Group>
      )}

      {/* Reading (NP-124, frame B10): how links open, «read» at the end, offline copies, the R key. */}
      <Group
        title={t("settings.reading")}
        summary={[
          t(openLinks === "browser" ? "settings.openLinksBrowser" : "settings.openLinksReader"),
          // Until the settings are read, nothing is said about them rather than a default.
          ...(settings?.reading_mark_at_end ? [t("settings.summaryMarkRead")] : []),
        ].join(" · ")}
        {...group("reading")}
      >
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
        <Row title={t("settings.saveOffline")} description={t("settings.saveOfflineHint")}>
          <Switch
            label={t("settings.saveOffline")}
            checked={settings?.reading_save_offline ?? false}
            disabled={!settings || busy("saveOffline")}
            onChange={(enabled) =>
              void attempt("saveOffline", async () => {
                await api.setReadingSaveOffline(enabled);
                if (settings) onSettings({ ...settings, reading_save_offline: enabled });
              })
            }
          />
        </Row>
        <Row title={t("card.toReading")} description={t("settings.sendToReadingHint")}>
          <Kbd>R</Kbd>
        </Row>
      </Group>

      {/* Feeds (NP-132): how often to check, how long posts stay, OPML and the cache. */}
      <Group
        title={t("feeds.title")}
        summary={
          !settings
            ? undefined
            : feedsMinutes
              ? t("feeds.settings.summaryEvery", { interval: checkLabel(feedsMinutes, t, i18n.language) })
              : t("feeds.settings.manually")
        }
        {...group("feeds")}
      >
        <div data-settings-feeds="check">
          <Row title={t("feeds.settings.check")} description={t("feeds.settings.checkHint")}>
            <Segmented
              label={t("feeds.settings.check")}
              value={String(feedsMinutes)}
              options={FEED_CHECKS.map((minutes) => ({ value: String(minutes), label: checkLabel(minutes, t, i18n.language) }))}
              onChange={(value) =>
                void attempt("feedsCheck", async () => {
                  await setFeedsRefreshMinutes(Number(value));
                  if (settings) onSettings({ ...settings, feeds_refresh_minutes: Number(value) });
                })
              }
            />
          </Row>
        </div>
        <Row title={t("feeds.settings.keep")} description={t("feeds.settings.keepHint")}>
          {null}
        </Row>
        <Row title={t("feeds.settings.opml")} description={t("feeds.settings.opmlHint")}>
          <Button
            disabled={busy("opmlExport")}
            onClick={() => void attempt("opmlExport", async () => void (await onExportFeeds()))}
          >
            {t("feeds.settings.export")}
          </Button>
          <Button onClick={onImportFeeds}>
            {t("feeds.settings.import")}
          </Button>
        </Row>
        <Row title={t("feeds.settings.clear")} description={t("feeds.settings.clearHint")}>
          <Button
            disabled={busy("feedCache")}
            onClick={() =>
              void attempt("feedCache", async () => {
                await clearFeedCache();
                onNotice(t("feeds.notice.cacheCleared"));
              })
            }
          >
            {t("feeds.settings.clearButton")}
          </Button>
        </Row>
      </Group>

      <div className="flex flex-col gap-2">
        <Group
          title={t("settings.syncAndBackups")}
          summary={`${lastCopy} · ${t("settings.copies", { count: data?.copies ?? 0 })}`}
          {...group("backups")}
        >
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
          <Row
            title={t("settings.backups")}
            description={`${t("settings.copies", { count: data?.copies ?? 0 })} · ${size(data?.bytes ?? 0)} · ${t("settings.keeps")}`}
          >
            {capabilities.file_manager && (
              <Button onClick={() => void attempt("backups", () => desktopOnly().revealLibraryPlace("backups"))}>
                {t("settings.openFolder")}
              </Button>
            )}
          </Row>
          <Row title={lastCopy} description={t("settings.saveHint")}>
            <Button disabled={busy("save")} onClick={() => void attempt("save", onSaveCopy)}>
              {busy("save") ? t("settings.savingCopy") : t("settings.saveCopy")}
            </Button>
            <Button
              disabled={busy("copy")}
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
        </Group>
        {open.has("backups") && <p className="px-3 text-xs leading-[17px] text-muted">{t("settings.backupNote")}</p>}
      </div>

      {/* Offline copies (NP-126, frame O5) live here with the library's other files. */}
      <Group
        title={t("settings.storage")}
        summary={t("settings.summaryOffline", { articles: offlineArticles, size: size(offline?.bytes ?? 0) })}
        {...group("storage")}
      >
        <Row title={t("settings.folder")} description={data?.library_folder ?? ""}>
          {capabilities.file_manager && (
            <Button onClick={() => void attempt("folder", () => desktopOnly().revealLibraryPlace("data"))}>{t("common.open")}</Button>
          )}
        </Row>
        <div data-settings-offline="stats">
          <Row title={t("settings.offlineStats", { articles: offlineArticles, size: size(offline?.bytes ?? 0) })} description={`${t("settings.offlineHint")} ${t("settings.removeCopiesHint")}`}>
            {capabilities.file_manager && (
              <Button onClick={() => void attempt("offlineFolder", () => desktopOnly().revealOfflineFolder())}>
                {t("settings.showFolder")}
              </Button>
            )}
            <Button disabled={!offline?.count} onClick={() => setRemovingCopies(true)}>
              {t("settings.removeCopiesButton")}
            </Button>
          </Row>
        </div>
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
        <PreviewsRow run={previews} onStart={onRefreshPreviews} onStop={onStopPreviews} />
      </Group>
      {removingCopies && (
        <ConfirmDialog
          title={t("settings.removeCopiesTitle")}
          text={t("settings.removeCopiesText", { count: offline?.count ?? 0 })}
          confirm={t("settings.removeCopiesConfirm")}
          onClose={() => setRemovingCopies(false)}
          onConfirm={async () => {
            const count = await api.removeAllOfflineCopies();
            setRemovingCopies(false);
            setOffline(await api.offlineStats());
            onNotice(t("settings.copiesRemoved", { count }));
          }}
        />
      )}

      <Group title={t("settings.support")} summary={t("settings.summarySupport")} {...group("support")}>
        <Row title={t("settings.help")} description={t("settings.helpHint")}>
          <Button onClick={() => void attempt("help", () => api.openUrl(helpUrl("home")))}>{t("settings.helpButton")}</Button>
        </Row>
        <Row title={t("settings.feedback")} description={t("settings.feedbackHint")}>
          <Button onClick={onFeedback}>{t("settings.feedbackButton")}</Button>
        </Row>
        <Row title={t("settings.github")} description={t("settings.githubHint")}>
          <Button onClick={() => void attempt("github", () => api.openUrl(GITHUB_ISSUES_URL))}>{t("common.open")}</Button>
        </Row>
        <Row title={t("settings.licenses")} description={t("settings.licensesHint")}>
          <Button onClick={() => void attempt("licenses", () => api.openUrl(licensesUrl(i18n.language)))}>{t("common.open")}</Button>
        </Row>
      </Group>
    </div>
  );
}

/**
 * General → the version row (NP-038, sheet 42): the version and the last check. A version on offer gets
 * «Update…», the same dialog as the row in the sidebar, with what changed (NP-040); the AUR package says that
 * pacman updates it and has no button.
 */
function UpdateRow({
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
  } else if (capabilities.updates !== "self") {
    // A phone's store updates the app (NP-151): the version and what changed, nothing to check.
    description = "";
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
          : t("settings.notChecked");
    controls = (
      <Button onClick={onCheck}>
        {update?.state === "check_failed" ? t("common.retry") : t("settings.checkUpdates")}
      </Button>
    );
  }
  // The changelog of the version that runs, on the site (NP-040): left of the button, in every state.
  return (
    <div data-settings-update={state}>
      <Row title={`Koona Pin ${version}`} description={description}>
        <button type="button" onClick={() => onOpen(changelogUrl(version))} className="px-1 text-sm font-medium text-accent hover:underline">
          {t("settings.changelog")} ↗
        </button>
        {controls}
      </Row>
    </div>
  );
}

/** The folded Connections: the browser's state, with its dot when something is wrong, and the assistants. */
function ConnectionsSummary({ capture, mcp }: { capture?: CaptureStatus | null; mcp?: { status: McpStatus | null } }) {
  const { t } = useTranslation();
  const state = capture?.state;
  const failing = state === "failing";
  const warn = state === "lost" || state === "incompatible" || failing;
  // Connected but no browser wrote lately: no names to give, so the plain status.
  const names = state === "connected" ? connectedNames(capture ?? null) : "";
  const browser = capture === undefined ? null : names ? t("settings.summaryConnected", { browsers: names }) : statusLabel(capture, t);
  const assistants = mcp ? t((mcp.status?.access ?? "off") === "off" ? "settings.summaryAssistantsOff" : "settings.summaryAssistantsOn") : null;
  // Inline, not flex: the header's summary ends in «…» when it is too long.
  return (
    <>
      {warn && <Dot color={statusColor(capture ?? null)} className="mr-2 align-middle" />}
      <span className={failing ? "text-danger" : ""}>{[browser, assistants].filter(Boolean).join(" · ")}</span>
    </>
  );
}

/**
 * Connections → the browser (S3). Connected or not yet: one row. Silent or out of date: a row with the
 * ochre dot and how to fix it. Failing: the red plaque takes the row's place, with Retry and the report.
 */
function BrowserRows({
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
  const state = capture?.state;
  const status = (label: string) => (
    <span className="flex items-center gap-2.5">
      <Dot color={statusColor(capture)} />
      {label}
    </span>
  );
  if (state === "failing") {
    return (
      <div data-capture={state} className="px-3 py-3">
        <div className="flex flex-col items-start gap-2.5 rounded-[10px] bg-danger-soft px-4 py-3.5 text-on-danger-soft">
          <div className="flex items-center gap-2.5 text-sm font-medium">
            <Dot color={statusColor(capture)} />
            {statusLabel(capture, t)}
          </div>
          <p className="text-sm leading-[18px]">{problemText(capture, t)}</p>
          <div className="flex gap-2">
            <Button variant="onDanger" disabled={busy} onClick={onRepair}>
              {t("common.retry")}
            </Button>
            <Button variant="onDanger" onClick={onReport}>
              {t("browser.copyReport")}
            </Button>
          </div>
        </div>
      </div>
    );
  }
  if (state === "lost" || state === "incompatible") {
    const outdated = incompatible(capture);
    const text =
      state === "lost"
        ? t("browser.lostText", { count: capture?.days_silent ?? 3 })
        : t(appIsOlder(capture) ? "browser.updateAppText" : "browser.updateText", {
            browser: outdated ? browserName[outdated.browser] : "",
            version: outdated?.extension_version ?? "?",
          });
    return (
      <div data-capture={state}>
        <Row title={status(statusLabel(capture, t))} description={text}>
          <Button onClick={onConnect}>{state === "lost" ? t("browser.howToConnect") : t("browser.howToUpdate")}</Button>
        </Row>
      </div>
    );
  }
  return (
    <div data-capture={state ?? "checking"}>
      <Row
        title={status(state === "connected" ? t("browser.connectedTo", { browsers: connectedNames(capture) }) : statusLabel(capture, t))}
        description={state === "connected" ? lastSaved(capture, t, i18n.language) : state === "none" ? t("browser.notConnectedHint") : ""}
      >
        <Button onClick={onConnect}>{state === "connected" ? t("settings.connectBrowser") : t("browser.connect")}</Button>
      </Row>
    </div>
  );
}

/** The MCP server's state, read once and followed while Settings are open. */
function useMcpStatus(onNotice: (text: string, alert?: boolean) => void) {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!capabilities.mcp) return;
    const desktop = desktopOnly();
    void desktop.getMcpStatus().then(setStatus).catch(() => {});
    return desktop.onMcpStatus(setStatus);
  }, []);
  const change = (next: McpAccess) => {
    setBusy(true);
    desktopOnly()
      .setMcpAccess(next)
      .then(setStatus)
      .catch((err) => onNotice(describeError(err), true))
      .finally(() => setBusy(false));
  };
  return { status, busy, change };
}

/**
 * Connections → AI assistants (NP-091, sheet 44): off by default; on, the last request, what assistants
 * may do and «How to connect…».
 */
function AssistantRows({
  status,
  busy,
  onChange,
  onConnect,
}: {
  status: McpStatus | null;
  busy: boolean;
  onChange: (next: McpAccess) => void;
  onConnect: () => void;
}) {
  const { t, i18n } = useTranslation();
  const access = status?.access ?? "off";
  const on = access !== "off";
  return (
    <div data-settings-assistants className="divide-y divide-divider">
      <div data-mcp={access}>
        <Row title={t("assistants.allow")} description={on ? lastRequest(status, t, i18n.language) : t("assistants.offHint")}>
          <Switch
            label={t("assistants.allow")}
            checked={on}
            disabled={!status || busy}
            onChange={(enabled) => onChange(enabled ? (status?.mode ?? "read") : "off")}
          />
        </Row>
      </div>
      {on && (
        <>
          <Row title={t("assistants.access")} description={t(access === "read" ? "assistants.readHint" : "assistants.addHint", { undo: shortcut("Z") })}>
            <Segmented<McpAccess>
              label={t("assistants.access")}
              value={access}
              onChange={(next) => !busy && onChange(next)}
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
    </div>
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

/** «Check for new posts» (NP-132): minutes, 0 only on refresh. */
const FEED_CHECKS = [30, 60, 180, 720, 0];
function checkLabel(minutes: number, t: TFunction, language: string): string {
  if (minutes === 0) return t("feeds.settings.manually");
  const hours = minutes >= 60;
  return new Intl.NumberFormat(language, { style: "unit", unit: hours ? "hour" : "minute", unitDisplay: "short" }).format(hours ? minutes / 60 : minutes);
}

/**
 * «Refresh previews» (Settings → Storage): every page read again for its picture, icon and site
 * name, as a bookmark's own «Refresh preview» does. «Refresh…» asks which: those without a
 * picture or site name, the default, or all, each with its count. While a run is under way
 * the row says how far it is, with «Stop».
 */
function PreviewsRow({ run, onStart, onStop }: { run: PreviewRefresh | null; onStart: (scope: PreviewScope) => void; onStop: () => void }) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ anchor: DOMRect; trigger: HTMLElement } | null>(null);
  const [counts, setCounts] = useState<PreviewCounts | null>(null);
  const read = () => void api.getPreviewCounts().then(setCounts).catch(() => {});
  const running = run?.state === "running";
  // A run ended: fewer may lack a picture now.
  useEffect(read, [running]);
  return (
    <div data-settings-previews={running ? "running" : "idle"}>
      <Row title={t("settings.refreshPreviews")} description={t("settings.refreshPreviewsHint")}>
        {running ? (
          <>
            <span role="status" className="text-sm text-muted tabular-nums">
              {t("settings.refreshProgress", { done: run.done, total: run.total })}
            </span>
            <Button onClick={onStop}>{t("settings.refreshStop")}</Button>
          </>
        ) : (
          <Button
            aria-haspopup="menu"
            aria-expanded={!!menu}
            onClick={(e) => {
              if (menu) return setMenu(null);
              read();
              setMenu({ anchor: e.currentTarget.getBoundingClientRect(), trigger: e.currentTarget });
            }}
          >
            {t("settings.refreshButton")}
          </Button>
        )}
      </Row>
      {menu && !running && (
        <Menu
          label={t("settings.refreshChoice")}
          anchor={menu.anchor}
          trigger={menu.trigger}
          width={340}
          entries={[
            { heading: t("settings.refreshChoice") },
            {
              id: "missing",
              label: t("settings.refreshMissing"),
              count: counts?.missing ?? "…",
              disabled: counts?.missing === 0,
              onSelect: () => onStart("missing"),
            },
            { id: "all", label: t("settings.refreshAll"), count: counts?.all ?? "…", disabled: counts?.all === 0, onSelect: () => onStart("all") },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * A group card (S1): a 52 px header, then rows with dividers. Without `onToggle` it is always open
 * (General); otherwise the header folds it, and a folded group shows its summary and a chevron.
 */
function Group({
  name,
  title,
  summary,
  open = true,
  onToggle,
  children,
}: {
  /** The group's id for tests and the stored choice; the title is translated. */
  name: string;
  title: string;
  summary?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const head = (
    <span id={`${id}-title`} className="text-sm font-semibold">
      {title}
    </span>
  );
  return (
    <section className="rounded-xl border border-line bg-card" data-settings-group={name}>
      <h2>
        {onToggle ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            // The group's name alone; the summary is read as its description.
            aria-labelledby={`${id}-title`}
            aria-describedby={!open && summary ? `${id}-summary` : undefined}
            onClick={onToggle}
            className="flex h-[52px] w-full items-center gap-4 rounded-xl px-3 text-left"
          >
            {head}
            {/* The summary only while folded; it gives way to the title when the column is narrow. */}
            <span id={`${id}-summary`} className="ml-auto min-w-0 truncate text-sm text-muted">
              {!open && summary}
            </span>
            {open ? (
              <ChevronDown aria-hidden className="size-4 shrink-0 text-muted" strokeWidth={1.5} />
            ) : (
              <ChevronRight aria-hidden className="size-4 shrink-0 text-muted" strokeWidth={1.5} />
            )}
          </button>
        ) : (
          <span className="flex h-[52px] items-center px-3">{head}</span>
        )}
      </h2>
      {open && (
        <div id={id} className="divide-y divide-divider border-t border-divider">
          {children}
        </div>
      )}
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
