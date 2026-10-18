import { ChangeEvent, ReactNode, useEffect, useState } from "react";
import { CircleCheck, FileText, Folder, Link, Rss } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TFunction } from "i18next";
import { CaptureStatus, ImportProgress, ImportSummary, OpmlImport, RestoreMode, RestoreOutcome, RestorePreview, RestoreProblem, RestoreSummary } from "../../types";
import { api } from "../../services/api";
import { ParsedFile, parseBookmarksFile } from "../../services/bookmarksFile";
import { describeError } from "../../services/errors";
import { importOpml } from "../../services/feeds";
import { fileKindOf, opmlRoot } from "../../services/openRequests";

export { opmlRoot };
import { shortcut } from "../../services/keys";
import {
  ConnectTab,
  connectTabName,
  connectTabs,
  connectedNames,
  installSteps,
  lastSaved,
  preferredBrowser,
  statusColor,
  statusLabel,
  tabBrowser,
} from "../../services/capture";
import { Icon } from "../icons";
import { Button, buttonClass } from "../ui/Button";
import { Dot, Field, Segmented, StatePanels, TabPanels } from "../ui/Controls";
import { Dialog } from "../ui/Dialog";

/** Runs an action, keeps the dialog and its input on failure. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

/**
 * With `reserve` two lines are kept for an error while there is none, so the dialog does not grow when
 * one comes (NP-118).
 */
const Failure = ({ error, reserve = false }: { error: string; reserve?: boolean }) => {
  const alert = error ? (
    <p role="alert" className="flex items-center rounded-xl bg-danger-soft px-3 py-2.5 text-sm text-on-danger-soft [grid-area:1/1]">
      {error}
    </p>
  ) : null;
  if (!reserve) return alert;
  return (
    <div className="grid">
      <p aria-hidden className="invisible py-2.5 text-sm [grid-area:1/1]">
        {" "}
        <br />
        {" "}
      </p>
      {alert}
    </div>
  );
};

/** At the bottom of a state of the dialog, wherever its content ends (NP-118). */
export const Footer = ({ children }: { children: ReactNode }) => <footer className="mt-auto flex justify-end gap-2 pt-1">{children}</footer>;

/** A report longer than the dialog scrolls above its footer, which stays put (NP-118). */
export const Scrolling = ({ children }: { children: ReactNode }) => (
  <div className="-m-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-1">{children}</div>
);

/** An OPML file (NP-133): by its name, or an `<opml>` root in a file named otherwise. */
export const isOpml = (name: string, content: string) => /\.(opml|xml)$/i.test(name) || opmlRoot(content);

/** How many feeds an OPML file lists: every outline with an `xmlUrl`, folders or not (plan §7.1). */
export const opmlFeedCount = (content: string) => content.match(/<outline\b[^>]*\bxmlUrl\s*=/gi)?.length ?? 0;

type ChosenFile = { name: string; content: string; preview: ParsedFile; feeds: number | null };

/** A picked or dropped file as the dialog shows it: its feeds when it is OPML, else its links. */
function chosenFile(name: string, content: string): ChosenFile {
  const opml = isOpml(name, content);
  return {
    name,
    content,
    preview: opml ? { links: [], skipped: [], folders: 0 } : parseBookmarksFile(content),
    feeds: opml ? opmlFeedCount(content) : null,
  };
}

/**
 * Frame 28: the file and where to put it, progress, the report, an error with nothing changed.
 * An OPML file follows its feeds instead (NP-133): no place to choose, its own report.
 */
export function ImportDialog({
  kind = "bookmarks",
  file: dropped,
  onImport,
  onOpenInbox,
  onClose,
  onList,
}: {
  /** Settings → Feeds → «Import…» opens it for feeds; either way it takes both kinds of file. */
  kind?: "bookmarks" | "feeds";
  /** A file dropped on the window (NP-139): the dialog opens with it chosen. */
  file?: { name: string; content: string };
  onImport: (content: string, toInbox: boolean) => Promise<ImportSummary>;
  onOpenInbox: () => void;
  onClose: () => void;
  /** A `.kpin` list picked here goes to the list dialog (NP-138). */
  onList?: (file: { name: string; text: string }) => void;
}) {
  const { t, i18n } = useTranslation();
  const [file, setFile] = useState<ChosenFile | null>(() => (dropped ? chosenFile(dropped.name, dropped.content) : null));
  const [feedReport, setFeedReport] = useState<OpmlImport | null>(null);
  const [toInbox, setToInbox] = useState(false);
  const [running, setRunning] = useState<ImportProgress | null>(null);
  const [report, setReport] = useState<ImportSummary | null>(null);
  const [error, setError] = useState("");
  const [showSkipped, setShowSkipped] = useState(false);
  useEffect(() => api.onImportProgress((progress) => setRunning((current) => current && progress)), []);
  const feeds = file ? file.feeds !== null : kind === "feeds";
  const empty = !!file && (file.feeds !== null ? file.feeds === 0 : file.preview.links.length === 0 && file.preview.skipped.length === 0);
  const start = async () => {
    if (!file) return;
    setError("");
    setRunning({ done: 0, total: file.feeds ?? file.preview.links.length });
    try {
      // The text goes to the core, as for bookmarks: a picked file has no path it could open.
      if (file.feeds !== null) setFeedReport(await importOpml(file.content));
      else setReport(await onImport(file.content, toInbox));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setRunning(null);
    }
  };
  const state = report || feedReport ? "report" : running && file ? "running" : "choose";

  const feedReportPanel = (report: OpmlImport) => {
    const row = (label: string, count: number) => (
      <div className="flex items-center justify-between gap-3 border-t border-divider py-2 text-sm first:border-t-0">
        <span>{label}</span>
        <span className="font-medium tabular-nums">{count.toLocaleString(i18n.language)}</span>
      </div>
    );
    return (
      <>
        <Scrolling>
          <div className="flex gap-2.5">
            <Icon icon={CircleCheck} size={18} className="mt-px shrink-0 text-accent" />
            <p role="status" className="text-md font-semibold">
              {report.added > 0 ? t("import.opmlAdded", { count: report.added }) : t("import.opmlNothingNew")}
            </p>
          </div>
          <div className="border-y border-divider">
            {row(t("import.added"), report.added)}
            {row(t("import.opmlExisting"), report.existing)}
            {row(t("import.skipped"), report.skipped.length)}
            {report.skipped.length > 0 && (
              <div className="flex flex-col gap-1.5 pb-3 pl-4 text-xs text-muted">
                <button
                  type="button"
                  aria-expanded={showSkipped}
                  onClick={() => setShowSkipped(!showSkipped)}
                  className="mt-1.5 self-start font-medium text-accent hover:underline"
                >
                  {showSkipped ? t("import.hideSkipped") : t("import.showSkipped")}
                </button>
                {showSkipped && (
                  <ul className="rounded-lg bg-secondary px-3 py-2 text-subtle">
                    {report.skipped.map((s, i) => (
                      <li key={i} className="truncate" title={`${s.url} — ${t(`import.opmlReason_${s.reason}`)}`}>
                        {s.title || s.url} — {t(`import.opmlReason_${s.reason}`)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </Scrolling>
        <Footer>
          <Button variant="primary" size="lg" autoFocus onClick={onClose}>
            {t("import.done")}
          </Button>
        </Footer>
      </>
    );
  };

  const reportPanel = (report: ImportSummary) => {
    const skipped = report.not_web + report.invalid + report.repeated;
    const shown = report.collections.slice(0, 2).join(", ");
    const names = report.collections.length > 2 ? t("import.andMore", { names: shown, count: report.collections.length - 2 }) : shown;
    const created = [
      report.collections.length > 0 && t("import.collections", { count: report.collections.length, names }),
      report.tags > 0 && t("import.tags", { count: report.tags }),
    ].filter(Boolean);
    const row = (label: string, count: number) => (
      <div className="flex items-center justify-between gap-3 border-t border-divider py-2 text-sm first:border-t-0">
        <span>{label}</span>
        <span className="font-medium tabular-nums">{count.toLocaleString(i18n.language)}</span>
      </div>
    );
    return (
      <>
        <Scrolling>
          <div className="flex gap-2.5">
            <Icon icon={CircleCheck} size={18} className="mt-px shrink-0 text-accent" />
            <div className="min-w-0">
              <p role="status" className="text-md font-semibold">
                {report.added > 0
                  ? t(toInbox ? "import.addedInbox" : "import.addedLibrary", { count: report.added })
                  : t("import.nothingNew")}
              </p>
              {created.length > 0 && <p className="mt-0.5 text-xs text-muted">{created.join(" · ")}</p>}
              {/* The new bookmarks' pages are read in the background (refresh.rs), with progress in the notification centre. */}
              {report.added > 0 && (
                <p data-import-fetching className="mt-0.5 text-xs text-muted">
                  {t("import.fetching")}
                </p>
              )}
            </div>
          </div>
          <div className="border-y border-divider">
            {row(t("import.added"), report.added)}
            {row(t("import.existing"), report.existing)}
            {report.in_trash > 0 && row(t("import.inTrash"), report.in_trash)}
            {row(t("import.skipped"), skipped)}
            {skipped > 0 && (
              <div className="flex flex-col gap-1.5 pb-3 pl-4 text-xs text-muted">
                {(["not_web", "invalid", "repeated"] as const).map(
                  (reason) =>
                    report[reason] > 0 && (
                      <div key={reason} className="flex justify-between gap-3">
                        <span>{t(`import.reason_${reason}`)}</span>
                        <span className="tabular-nums">{report[reason].toLocaleString(i18n.language)}</span>
                      </div>
                    ),
                )}
                <button
                  type="button"
                  aria-expanded={showSkipped}
                  onClick={() => setShowSkipped(!showSkipped)}
                  className="mt-1.5 self-start font-medium text-accent hover:underline"
                >
                  {showSkipped ? t("import.hideSkipped") : t("import.showSkipped")}
                </button>
                {showSkipped && (
                  <ul className="rounded-lg bg-secondary px-3 py-2 text-subtle">
                    {report.skipped.map((s, i) => (
                      <li key={i} className="truncate" title={`${s.address} — ${t(`import.reason_${s.reason}`)}`}>
                        {s.address || "—"}
                      </li>
                    ))}
                    {skipped > report.skipped.length && <li>{t("import.moreSkipped", { count: skipped - report.skipped.length })}</li>}
                  </ul>
                )}
              </div>
            )}
          </div>
        </Scrolling>
        <Footer>
          {toInbox && report.added > 0 && (
            <Button variant="outline" size="lg" onClick={onOpenInbox}>
              {t("import.openInbox")}
            </Button>
          )}
          <Button variant="primary" size="lg" autoFocus onClick={onClose}>
            {t("import.done")}
          </Button>
        </Footer>
      </>
    );
  };

  const runningPanel = (name: string, progress: ImportProgress) => {
    const total = Math.max(progress.total, 1);
    return (
      <div className="flex flex-1 flex-col gap-3">
        <p className="text-sm font-medium [overflow-wrap:anywhere]">{t("import.importing", { name })}</p>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          aria-label={t("import.importing", { name })}
          className="h-1 overflow-hidden rounded-full bg-hover"
        >
          <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${(progress.done / total) * 100}%` }} />
        </div>
        <p className="text-xs text-muted">{t("import.progress", { done: progress.done, count: progress.total })}</p>
        <p className="text-xs text-subtle">{t("import.progressNote")}</p>
        <Footer>
          <Button variant="primary" size="lg" disabled>
            {t("import.running")}
          </Button>
        </Footer>
      </div>
    );
  };

  // The unseen copy has no file: the line under its name is kept for the summary either way.
  const choosePanel = (sizing: boolean) => {
    const picked = sizing ? null : file;
    const failed = !sizing && !!error;
    const summary = picked && (picked.feeds !== null ? t("import.opmlFeeds", { count: picked.feeds }) : [
      t("import.links", { count: picked.preview.links.length }),
      picked.preview.folders > 0 ? t("import.inFolders", { count: picked.preview.folders }) : "",
    ].filter(Boolean).join(" "));
    return (
      <>
        <p className="text-sm text-muted">{t(feeds ? "import.leadFeeds" : "import.lead")}</p>
        {failed && picked ? (
          <div className="flex items-center gap-2.5 rounded-xl bg-secondary px-3 py-3 text-sm">
            <Icon icon={FileText} className="shrink-0 text-icon" />
            <span className="min-w-0 flex-1 truncate font-medium">{picked.name}</span>
            <span className="shrink-0 text-xs text-subtle">
              {picked.feeds !== null ? t("import.opmlFeeds", { count: picked.feeds }) : t("import.links", { count: picked.preview.links.length })}
            </span>
          </div>
        ) : (
          <label className="flex cursor-default flex-col items-center gap-1 rounded-xl border border-dashed border-border px-4 py-4 text-center text-sm hover:bg-panel focus-within:outline-2 focus-within:outline-accent">
            <Icon icon={FileText} size={22} className="mb-1.5 text-icon" />
            <span className={`max-w-full truncate ${picked ? "font-medium" : "text-muted"}`} title={picked?.name}>
              {picked?.name ?? t(feeds ? "import.fileFeeds" : "import.file")}
            </span>
            <span className="max-w-full truncate text-xs text-subtle">{picked ? `${summary} · ${t("import.another")}` : " "}</span>
            {!sizing && (
              <input
                type="file"
                accept={feeds ? ".opml,.xml,.html,.htm,.kpin" : ".html,.htm,.opml,.xml,.kpin"}
                className="sr-only"
                onChange={(e) => {
                  const chosen = e.target.files?.[0];
                  if (chosen)
                    void chosen
                      .text()
                      .then((content) => {
                        setError("");
                        if (onList && fileKindOf(chosen.name) === "kpin") return onList({ name: chosen.name, text: content });
                        setFile(chosenFile(chosen.name, content));
                      })
                      .catch((err) => setError(describeError(err)));
                }}
              />
            )}
          </label>
        )}
        {/* A file without links, like an error, leaves nothing to choose a place for. */}
        {!sizing && empty && <Failure error={t(feeds ? "import.opmlEmpty" : "import.empty")} />}
        {!failed && !(empty && !sizing) && feeds && (
          <div className="flex gap-2.5 rounded-xl bg-secondary p-3 text-xs text-icon">
            <Icon icon={Rss} className="shrink-0" />
            <p>{t("import.opmlRule")}</p>
          </div>
        )}
        {!failed && !(empty && !sizing) && !feeds && (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">{t("import.destination")}</span>
              <div className="flex">
                <Segmented<"library" | "inbox">
                  label={t("import.destination")}
                  value={toInbox ? "inbox" : "library"}
                  onChange={(value) => setToInbox(value === "inbox")}
                  options={[
                    { value: "library", label: t("import.library") },
                    { value: "inbox", label: t("import.inbox") },
                  ]}
                />
              </div>
              <p className="text-xs text-subtle">{t("import.destinationHint")}</p>
            </div>
            <div className="flex gap-2.5 rounded-xl bg-secondary p-3 text-xs text-icon">
              <Icon icon={Folder} className="shrink-0" />
              <p>{t("import.rule")}</p>
            </div>
          </>
        )}
        {failed && <Failure error={picked ? t("import.failed", { reason: error }) : error} />}
        <Footer>
          <Button variant="outline" size="lg" onClick={onClose}>
            {t("import.cancel")}
          </Button>
          <Button variant="primary" size="lg" disabled={!picked || empty} onClick={() => void start()}>
            {failed && picked ? t("common.retry") : t("import.run")}
          </Button>
        </Footer>
      </>
    );
  };

  return (
    <Dialog
      title={t(state === "report" ? "import.finished" : feeds ? "import.titleFeeds" : "import.title")}
      onClose={onClose}
      locked={state === "running"}
    >
      <StatePanels value={state} states={["choose", "running", "report"] as const}>
        {(shown, sizing) =>
          shown === "report"
            ? !sizing && (feedReport ? feedReportPanel(feedReport) : report && reportPanel(report))
            : shown === "running"
              ? runningPanel(sizing ? " " : (file?.name ?? ""), sizing || !running ? { done: 0, total: 0 } : running)
              : choosePanel(sizing)
        }
      </StatePanels>
    </Dialog>
  );
}

/** Why a copy cannot be restored, in words (frame 30). */
function problemText(problem: RestoreProblem, t: TFunction): string {
  switch (problem.problem) {
    case "not_json":
      return t("restore.notJson");
    case "not_ours":
      return t("restore.notOurs");
    case "newer":
      return t("restore.newer", { version: problem.version });
    case "damaged":
      return t("restore.damaged", {
        what: t(`restore.damage.${problem.item}_${problem.damage}` as "restore.damage.file_structure", { index: problem.index, detail: problem.detail }),
      });
  }
}

/** A radio card of frame 30: the mode and what it does. */
function ModeOption({ checked, title, hint, onSelect }: { checked: boolean; title: string; hint: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={`flex w-full gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors duration-150 ${checked ? "border-accent bg-accent-soft outline outline-[0.5px] outline-accent" : "border-border bg-card hover:bg-panel"}`}
    >
      <span className={`mt-px flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] bg-card ${checked ? "border-accent" : "border-subtle"}`}>
        {checked && <span className="size-2 rounded-full bg-accent" />}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted">{hint}</span>
      </span>
    </button>
  );
}

/**
 * Frame 30: the copy and what it holds, merge or replace, the confirmation of
 * a replace, the report; a damaged, foreign or newer copy is refused with
 * nothing changed.
 */
export function RestoreDialog({
  file: dropped,
  onRestore,
  onShowBackups,
  onClose,
}: {
  /** A full copy dropped on the window or picked with «Import a file…»: checked at once. */
  file?: { name: string; content: string };
  onRestore: (content: string, mode: RestoreMode) => Promise<RestoreOutcome>;
  onShowBackups: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [file, setFile] = useState<{ name: string; content: string; preview: RestorePreview } | null>(null);
  const [problem, setProblem] = useState<string>("");
  const [mode, setMode] = useState<RestoreMode>("merge");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<{ summary: RestoreSummary; mode: RestoreMode } | null>(null);
  const number = (n: number) => n.toLocaleString(i18n.language);

  const check = async (name: string, read: () => Promise<string>) => {
    setError("");
    setProblem("");
    setFile(null);
    try {
      const content = await read();
      const check = await api.checkRestore(content);
      if (check.outcome === "rejected") {
        setFile({ name, content, preview: { bookmarks: 0, collections: 0, tags: 0, exported_at: "", current: 0 } });
        setProblem(problemText(check.problem, t));
      } else setFile({ name, content, preview: check.preview });
    } catch (err) {
      setError(describeError(err));
    }
  };
  const pick = (picked: File) => check(picked.name, () => picked.text());
  // The dialog opens with a dropped copy chosen; the key of a new drop is a new dialog.
  useEffect(() => {
    if (dropped) void check(dropped.name, async () => dropped.content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const outcome = await onRestore(file.content, mode);
      if (outcome.outcome === "restored") setReport({ summary: outcome.summary, mode });
      else if (outcome.outcome === "rejected") setProblem(problemText(outcome.problem, t));
      else setError(t("restore.backupFailed", { detail: outcome.detail }));
    } catch (err) {
      setError(t("restore.failed", { reason: describeError(err) }));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const { preview } = file ?? { preview: null };
  const state = report ? "report" : confirming && file ? "confirm" : "choose";

  const reportPanel = ({ summary, mode }: { summary: RestoreSummary; mode: RestoreMode }) => {
    const created = [
      summary.collections.length > 0 && t("restore.collections", { count: summary.collections.length }),
      summary.tags > 0 && t("import.tags", { count: summary.tags }),
    ].filter(Boolean);
    const row = (label: string, count: number) => (
      <div className="flex items-center justify-between gap-3 border-t border-divider py-2 text-sm first:border-t-0">
        <span>{label}</span>
        <span className="font-medium tabular-nums">{number(count)}</span>
      </div>
    );
    const sub = (label: string, count: number) => (
      <div className="flex justify-between gap-3 pb-1.5 pl-4 text-xs text-muted">
        <span>{label}</span>
        <span className="tabular-nums">{number(count)}</span>
      </div>
    );
    return (
      <>
        <Scrolling>
          <div className="flex gap-2.5">
            <Icon icon={CircleCheck} size={18} className="mt-px shrink-0 text-accent" />
            <div className="min-w-0">
              <p role="status" className="text-md font-semibold">
                {mode === "replace"
                  ? t("restore.restored", { count: summary.added })
                  : summary.added > 0
                    ? t("restore.added", { count: summary.added })
                    : t("import.nothingNew")}
              </p>
              {created.length > 0 && <p className="mt-0.5 text-xs text-muted">{created.join(" · ")}</p>}
            </div>
          </div>
          <div className="border-y border-divider">
            {row(mode === "replace" ? t("restore.rowRestored") : t("import.added"), summary.added)}
            {summary.in_inbox > 0 && sub(t("restore.inInbox"), summary.in_inbox)}
            {summary.in_trash > 0 && sub(t("restore.inTrash"), summary.in_trash)}
            {mode === "merge" && row(t("import.existing"), summary.existing)}
            {summary.backup && (
              <div className="flex items-center justify-between gap-3 border-t border-divider py-2 text-sm">
                <span className="min-w-0 [overflow-wrap:anywhere]">{t("restore.backup", { name: summary.backup })}</span>
                <button type="button" onClick={onShowBackups} className="shrink-0 font-medium text-accent hover:underline">
                  {t("export.show")}
                </button>
              </div>
            )}
          </div>
        </Scrolling>
        <Footer>
          <Button variant="primary" size="lg" autoFocus onClick={onClose}>
            {t("import.done")}
          </Button>
        </Footer>
      </>
    );
  };

  // The confirmation of a replace: a state of this dialog, not a second one over it.
  const confirmPanel = () => (
    <>
      <p className="text-sm text-muted [overflow-wrap:anywhere]">
        {t("restore.confirmText", { count: preview?.current ?? 0, copy: number(preview?.bookmarks ?? 0), undo: shortcut("Z") })}
      </p>
      <Footer>
        <Button variant="outline" size="lg" autoFocus disabled={busy} onClick={() => setConfirming(false)}>
          {t("common.keep")}
        </Button>
        <Button variant="primary" size="lg" disabled={busy} onClick={() => void run()}>
          {busy ? t("restore.running") : t("restore.confirm")}
        </Button>
      </Footer>
    </>
  );

  // The unseen copy has no file and no error: the line under the name is kept for what the copy holds.
  const choosePanel = (sizing: boolean) => {
    const picked = sizing ? null : file;
    const refused = sizing ? "" : problem;
    const failed = sizing ? "" : error;
    const made = picked?.preview.exported_at
      ? new Date(picked.preview.exported_at).toLocaleDateString(i18n.language, { day: "numeric", month: "short", year: "numeric" })
      : "";
    const choose = (e: ChangeEvent<HTMLInputElement>) => {
      const chosen = e.target.files?.[0];
      e.target.value = "";
      if (chosen) void pick(chosen);
    };
    return (
      <>
        <p className="text-sm text-muted">{t("restore.lead")}</p>
        <label className="flex cursor-default items-center gap-2.5 rounded-xl bg-secondary px-3 py-3 text-sm hover:bg-secondary-hover focus-within:outline-2 focus-within:outline-accent">
          <Icon icon={FileText} className="shrink-0 text-icon" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className={`truncate ${picked ? "font-medium" : "text-muted"}`} title={picked?.name}>
              {picked?.name ?? t("restore.file")}
            </span>
            <span className="truncate text-xs text-subtle">
              {!picked
                ? " "
                : refused
                  ? t("restore.checkedBad")
                  : [
                      t("restore.bookmarks", { count: picked.preview.bookmarks }),
                      t("restore.collectionsCount", { count: picked.preview.collections }),
                      t("restore.tagsCount", { count: picked.preview.tags }),
                      made,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
            </span>
          </span>
          {!sizing && <input type="file" accept=".json,application/json" className="sr-only" onChange={choose} />}
        </label>
        {/* A refused copy or a failed restore takes the place of the modes; «Try again» keeps the mode chosen. */}
        {refused || failed ? (
          <Failure error={refused || failed} />
        ) : (
          <div className="flex flex-col gap-2">
            <span id={sizing ? undefined : "restore-mode"} className="text-xs font-medium text-muted">
              {t("restore.how")}
            </span>
            <div role="radiogroup" aria-labelledby={sizing ? undefined : "restore-mode"} className="flex flex-col gap-2">
              <ModeOption checked={mode === "merge"} title={t("restore.merge")} hint={t("restore.mergeHint")} onSelect={() => setMode("merge")} />
              <ModeOption checked={mode === "replace"} title={t("restore.replace")} hint={t("restore.replaceHint")} onSelect={() => setMode("replace")} />
            </div>
          </div>
        )}
        <Footer>
          <Button variant="outline" size="lg" disabled={busy} onClick={onClose}>
            {t("import.cancel")}
          </Button>
          {refused ? (
            <label className={`${buttonClass("primary", "lg")} cursor-default focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent`}>
              {t("restore.another")}
              <input type="file" accept=".json,application/json" className="sr-only" onChange={choose} />
            </label>
          ) : (
            <Button variant="primary" size="lg" disabled={!picked || busy} onClick={() => (mode === "replace" ? setConfirming(true) : void run())}>
              {busy ? t("restore.running") : failed && picked ? t("common.retry") : t("restore.run")}
            </Button>
          )}
        </Footer>
      </>
    );
  };

  const title = { choose: t("restore.title"), confirm: t("restore.confirmTitle"), report: t("restore.finished") }[state];
  return (
    // Escape, «×» and the backdrop on the confirmation go back to the copy, as «Keep» does.
    <Dialog title={title} onClose={() => !busy && (state === "confirm" ? setConfirming(false) : onClose())} locked={busy}>
      <StatePanels value={state} states={["choose", "confirm", "report"] as const}>
        {(shown, sizing) =>
          shown === "report" ? report && !sizing && reportPanel(report) : shown === "confirm" ? confirmPanel() : choosePanel(sizing)
        }
      </StatePanels>
    </Dialog>
  );
}

/** `initial` — the name offered for «Новая коллекция из выбранного» in a narrow window (NP-029). */
export function CollectionDialog({
  initial = "",
  onCreate,
  onClose,
}: {
  initial?: string;
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { busy, error, run } = useAction();
  const [name, setName] = useState(initial);
  return (
    <Dialog title={t("collection.title")} onClose={() => !busy && onClose()} width={400}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => onCreate(name.trim()));
        }}
      >
        <Field label={t("collection.name")}>
          {(id) => (
            <input id={id} autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder={t("collection.placeholder")} className="field" />
          )}
        </Field>
        <Failure error={error} reserve />
        <Footer>
          <Button variant="primary" size="lg" type="submit" disabled={busy}>
            {t("collection.create")}
          </Button>
        </Footer>
      </form>
    </Dialog>
  );
}

export function ConfirmDialog({
  title,
  text,
  confirm,
  onConfirm,
  onClose,
}: {
  title: string;
  text: string;
  confirm: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { busy, error, run } = useAction();
  return (
    <Dialog title={title} onClose={() => !busy && onClose()} width={400}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted [overflow-wrap:anywhere]">{text}</p>
        <Failure error={error} reserve />
        <Footer>
          <Button disabled={busy} onClick={onClose}>
            {t("common.keep")}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void run(onConfirm)}>
            {confirm}
          </Button>
        </Footer>
      </div>
    </Dialog>
  );
}

/**
 * Frame «40 · Без трея: первое закрытие окна» (NP-096): the desktop has no
 * tray, so closing the window only hides it. Shown once; «×» and Esc keep the
 * window open.
 */
export function BackgroundDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { busy, error, run } = useAction();
  return (
    <Dialog title={t("background.title")} onClose={() => !busy && onClose()} width={440}>
      <div className="flex flex-col gap-4">
        <p className="text-sm leading-[18px] text-muted">{t("background.text")}</p>
        <p className="rounded-lg bg-panel px-3 py-2.5 text-xs leading-[17px] text-muted dark:bg-hover">{t("background.hint", { quit: shortcut("Q") })}</p>
        <Failure error={error} reserve />
        <Footer>
          <Button variant="outline" disabled={busy} onClick={() => void run(api.quitApp)}>
            {t("background.quit")}
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.hideToBackground();
                onClose();
              })
            }
          >
            {t("background.hide")}
          </Button>
        </Footer>
      </div>
    </Dialog>
  );
}

/** Frame 18: how to connect, reconnect and update the extension in each browser. */
export function ConnectDialog({
  capture,
  onOpen,
  onClose,
}: {
  capture: CaptureStatus | null;
  onOpen: (url: string) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<ConnectTab>(() => preferredBrowser(capture));
  // Linux (sheet 40, NP-054): a Chromium tab, Firefox from Snap, the sandboxed browsers.
  const linux = capture?.system === "linux";
  const mac = capture?.system === "macos";
  const [tray, setTray] = useState(true);
  useEffect(() => {
    if (linux) void api.getDesktop().then((desktop) => setTray(desktop.tray)).catch(() => {});
  }, [linux]);
  const status =
    capture?.state === "connected"
      ? `${t("browser.connectedTo", { browsers: connectedNames(capture) })} · ${lastSaved(capture, t, i18n.language)}`
      : statusLabel(capture, t);
  const tabs = connectTabs(capture);
  // Every browser's steps are laid out at once, so the dialog keeps its height when the tab changes.
  const panel = (shown: ConnectTab) => {
    const browser = tabBrowser(shown);
    const install = installSteps(browser);
    // Safari's extension is already inside the app (NP-119): turned on and allowed in Safari's settings.
    const safari = browser === "safari";
    const steps = [
      {
        title: t(safari ? "connect.enableTitle" : "connect.installTitle"),
        text: t(install.install),
        action: install.url ? (
          <Button className="mt-2" onClick={() => onOpen(install.url)}>
            {t("connect.openStore", { store: install.store })}
          </Button>
        ) : null,
      },
      { title: t(safari ? "connect.allowTitle" : "connect.pinTitle"), text: t(`connect.pin_${browser}`), action: null },
      // Without a tray the closed app starts «in the background» (NP-096); on a Mac it starts in the menu bar.
      { title: t("connect.saveTitle"), text: t(mac ? "connect.save_menubar" : tray ? "connect.save" : "connect.save_background"), action: null },
    ];
    return (
      <>
        <ol className="flex flex-col gap-4">
          {steps.map((step, index) => (
            <li key={step.title} className="flex gap-3">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-2xs font-semibold text-on-accent-soft">
                {index + 1}
              </span>
              <div>
                <div className="font-medium">{step.title}</div>
                <p className="mt-0.5 leading-[18px] text-muted">{step.text}</p>
                {step.action}
              </div>
            </li>
          ))}
        </ol>
        {linux && shown === "firefox" && (
          <p className="ml-8 rounded-lg bg-accent-soft px-3 py-2.5 text-xs leading-[17px] text-on-accent-soft">
            {t("connect.snapFirefox")}
          </p>
        )}
        <div className="flex flex-col gap-3 border-t border-divider pt-4">
          <div>
            <div className="font-medium">{t("connect.lostTitle")}</div>
            <p className="mt-0.5 leading-[18px] text-muted">{t(`connect.lost_${browser}`)}</p>
          </div>
          <div>
            <div className="font-medium">{t("connect.updateTitle")}</div>
            <p className="mt-0.5 leading-[18px] text-muted">{t(install.update)}</p>
          </div>
          {linux && (
            <div data-sandboxed>
              <div className="font-medium">{t("connect.sandboxTitle")}</div>
              <p className="mt-0.5 leading-[18px] text-muted">{t("connect.sandboxText")}</p>
            </div>
          )}
        </div>
      </>
    );
  };
  return (
    <Dialog title={t("connect.title")} onClose={onClose} width={480}>
      <div className="flex flex-col gap-4 text-sm">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary text-icon">
            <Icon icon={Link} />
          </span>
          <div className="min-w-0">
            <h3 className="text-md font-semibold">{t("connect.lead")}</h3>
            <p data-capture={capture?.state ?? "checking"} className="mt-0.5 flex items-center gap-2 text-xs text-muted">
              <Dot color={statusColor(capture)} className="size-1.5" />
              {status}
            </p>
          </div>
        </div>
        <Segmented<ConnectTab>
          label={t("connect.browsers")}
          value={tab}
          onChange={setTab}
          options={tabs.map((value) => ({ value, label: connectTabName[value] }))}
        />
        <TabPanels value={tab} tabs={tabs}>
          {panel}
        </TabPanels>
      </div>
    </Dialog>
  );
}
