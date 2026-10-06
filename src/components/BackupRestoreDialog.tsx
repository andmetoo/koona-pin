import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TFunction } from "i18next";
import { BackupCopy, BackupRestoreOutcome, BackupSource, CopyProblem } from "../types";
import { api } from "../services/api";
import { describeError } from "../services/errors";
import { Icon } from "./icons";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { ConfirmDialog } from "./library/Dialogs";

/** When a copy was written: «Today, 09:12» in the list, «today, 09:12» inside a sentence. */
export function copyTime(iso: string, t: TFunction, language: string, inline = false): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" });
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (days === 0) return t(inline ? "backup.todayAt" : "backup.today", { time });
  if (days === 1) return t(inline ? "backup.yesterdayAt" : "backup.yesterday", { time });
  const sameYear = date.getFullYear() === today.getFullYear();
  const shown = date.toLocaleDateString(language, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
  return t("backup.on", { date: shown, time });
}

/** Why a copy cannot be restored, in words (sheet 33). */
function problemText(problem: CopyProblem, t: TFunction): string {
  switch (problem.problem) {
    case "not_database":
      return t("backup.notDatabase");
    case "not_ours":
      return t("backup.notOurs");
    case "newer":
      return t("backup.newer", { schema: problem.schema });
    case "damaged":
      return t("backup.damaged", { detail: problem.detail });
    case "unreadable":
      return t("backup.unreadable", { detail: problem.detail });
  }
}

type Choice = { copy: BackupCopy; source: BackupSource };

/**
 * Sheet 33: the copies in the backups folder or a file chosen elsewhere, the
 * confirmation with the numbers, the report with the copy of the replaced
 * library; a foreign, newer or damaged file is refused with nothing changed.
 * `current` is the size of the open library; without it the library did not
 * open (frame 12) and the confirmation says its file is kept as it is.
 */
export function BackupRestoreDialog({
  current,
  onRestored,
  onClose,
}: {
  current?: number;
  onRestored: () => void | Promise<void>;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [copies, setCopies] = useState<BackupCopy[] | null>(null);
  const [picked, setPicked] = useState<BackupCopy | null>(null);
  const [chosen, setChosen] = useState<Choice | null>(null);
  const [rejected, setRejected] = useState<{ fileName: string; problem: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<{ copy: BackupCopy; previous: string } | null>(null);
  const number = (n: number) => n.toLocaleString(i18n.language);
  const size = (bytes: number) =>
    new Intl.NumberFormat(i18n.language, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 }).format(bytes / 1_000_000);

  useEffect(() => {
    api
      .listBackups()
      .then((list) => {
        setCopies(list);
        const first = list.find((copy) => copy.bookmarks !== null);
        if (first) setChosen({ copy: first, source: { from: "listed", file_name: first.file_name } });
      })
      .catch((err) => {
        setCopies([]);
        setError(describeError(err));
      });
  }, []);

  const choose = async () => {
    setError("");
    try {
      const result = await api.pickBackup();
      if (result.outcome === "cancelled") return;
      if (result.outcome === "rejected") {
        setRejected({ fileName: result.file_name, problem: problemText(result.problem, t) });
        return;
      }
      setRejected(null);
      setPicked(result.copy);
      setChosen({ copy: result.copy, source: { from: "picked" } });
    } catch (err) {
      setError(describeError(err));
    }
  };

  const run = async () => {
    if (!chosen) return;
    setBusy(true);
    setError("");
    try {
      const outcome: BackupRestoreOutcome = await api.restoreBackup(chosen.source);
      if (outcome.outcome === "restored") {
        setReport({ copy: { ...chosen.copy, bookmarks: outcome.bookmarks }, previous: outcome.previous });
        await onRestored();
      } else if (outcome.outcome === "rejected") {
        setRejected({ fileName: chosen.copy.file_name, problem: problemText(outcome.problem, t) });
      } else if (outcome.outcome === "backup_failed") {
        setError(t("backup.backupFailed", { detail: outcome.detail }));
      } else {
        setError(t("backup.failed", { detail: outcome.detail }));
      }
    } catch (err) {
      setError(t("backup.failed", { detail: describeError(err) }));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  if (report) {
    const when = copyTime(report.copy.created_at, t, i18n.language, true);
    return (
      <Dialog title={t("backup.done")} onClose={onClose}>
        <div className="flex flex-col gap-4">
          <div className="flex gap-2.5">
            <Icon icon={CircleCheck} size={18} className="mt-px shrink-0 text-accent" />
            <div className="min-w-0">
              <p role="status" className="text-md font-semibold">
                {t("backup.summary", { count: report.copy.bookmarks ?? 0, when })}
              </p>
              {current !== undefined && <p className="mt-0.5 text-xs text-muted">{t("backup.journalCleared")}</p>}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 border-y border-divider py-2.5">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm">{t("backup.previous")}</span>
              <span className="text-xs text-subtle [overflow-wrap:anywhere]">{report.previous}</span>
            </span>
            <button
              type="button"
              onClick={() => void api.revealBackup(report.previous).catch((err) => setError(describeError(err)))}
              className="shrink-0 text-sm font-medium text-accent hover:underline"
            >
              {t("export.show")}
            </button>
          </div>
          <Failure error={error} />
          <footer className="mt-1 flex justify-end gap-2">
            <Button variant="primary" size="lg" autoFocus data-autofocus onClick={onClose}>
              {t("import.done")}
            </Button>
          </footer>
        </div>
      </Dialog>
    );
  }

  if (rejected) {
    return (
      <Dialog title={t("backup.title")} onClose={onClose} width={480}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">{t("backup.lead")}</p>
          <div className="flex items-center gap-2.5 rounded-xl bg-secondary px-3 py-3 text-sm">
            <Icon icon={FileText} className="shrink-0 text-icon" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium [overflow-wrap:anywhere]">{rejected.fileName}</span>
              <span className="text-xs text-subtle">{t("backup.checkedBad")}</span>
            </span>
          </div>
          <p role="alert" className="flex gap-2.5 rounded-xl bg-danger-soft px-3 py-2.5 text-sm text-on-danger-soft">
            <Icon icon={CircleAlert} className="mt-px shrink-0" />
            <span>{rejected.problem}</span>
          </p>
          <Failure error={error} />
          <footer className="mt-1 flex justify-end gap-2">
            <Button variant="outline" size="lg" onClick={onClose}>
              {t("import.cancel")}
            </Button>
            <Button variant="primary" size="lg" autoFocus data-autofocus onClick={() => void choose()}>
              {t("backup.another")}
            </Button>
          </footer>
        </div>
      </Dialog>
    );
  }

  const listed = [...(picked ? [picked] : []), ...(copies ?? [])];
  const when = chosen ? copyTime(chosen.copy.created_at, t, i18n.language, true) : "";
  const copyCount = chosen ? t("backup.bookmarks", { count: chosen.copy.bookmarks ?? 0 }) : "";
  return (
    <>
      <Dialog title={t("backup.title")} onClose={onClose} width={480} locked={busy}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">{t("backup.lead")}</p>
          {copies === null ? (
            <p role="status" className="text-sm text-muted">
              {t("backup.loading")}
            </p>
          ) : listed.length === 0 ? (
            <p className="rounded-xl bg-secondary px-3 py-3 text-sm text-muted">{t("backup.empty")}</p>
          ) : (
            <div
              role="radiogroup"
              aria-label={t("backup.title")}
              className="flex max-h-[270px] flex-col overflow-y-auto rounded-[10px] border border-border"
            >
              {listed.map((copy, index) => {
                const isPicked = picked !== null && index === 0;
                const checked = chosen?.copy === copy;
                const readable = copy.bookmarks !== null;
                return (
                  <button
                    key={`${isPicked ? "picked" : "listed"}-${copy.file_name}`}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    disabled={!readable || busy}
                    data-file={copy.file_name}
                    onClick={() =>
                      setChosen({ copy, source: isPicked ? { from: "picked" } : { from: "listed", file_name: copy.file_name } })
                    }
                    className={`flex min-h-[52px] w-full shrink-0 items-center gap-3 border-t border-divider px-3.5 py-2 text-left first:border-t-0 transition-colors duration-150 disabled:opacity-45 ${checked ? "bg-accent-soft" : "hover:bg-panel"}`}
                  >
                    <span className={`flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] bg-card ${checked ? "border-accent" : "border-subtle"}`}>
                      {checked && <span className="size-2 rounded-full bg-accent" />}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-sm font-medium">{copyTime(copy.created_at, t, i18n.language)}</span>
                      <span className="truncate text-xs text-subtle">
                        {isPicked ? copy.file_name : t(`backup.kind.${copy.kind}`)} · {size(copy.bytes)}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm text-muted tabular-nums">
                      {readable ? t("backup.bookmarks", { count: copy.bookmarks ?? 0 }) : t("backup.unreadable")}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <Failure error={error} />
          <footer className="mt-1 flex gap-2">
            <Button variant="outline" size="lg" disabled={busy} onClick={() => void choose()}>
              {t("backup.choose")}
            </Button>
            <span className="flex-1" />
            <Button variant="outline" size="lg" disabled={busy} onClick={onClose}>
              {t("import.cancel")}
            </Button>
            <Button variant="primary" size="lg" disabled={!chosen || busy} onClick={() => setConfirming(true)}>
              {busy ? t("backup.running") : error && chosen ? t("common.retry") : t("backup.run")}
            </Button>
          </footer>
        </div>
      </Dialog>
      {confirming && chosen && (
        <ConfirmDialog
          title={t("backup.confirmTitle", { when })}
          text={
            current === undefined
              ? t("backup.confirmClosed", { copy: copyCount })
              : t("backup.confirmText", { count: current, copy: number(chosen.copy.bookmarks ?? 0), when })
          }
          confirm={t("backup.confirm")}
          onClose={() => setConfirming(false)}
          onConfirm={run}
        />
      )}
    </>
  );
}

const Failure = ({ error }: { error: string }) =>
  error ? (
    <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2.5 text-sm text-on-danger-soft">
      {error}
    </p>
  ) : null;
