import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UpdateProblem } from "../types";
import { DOWNLOAD_PAGE, megabytes, notesUrl, Offer, percent } from "../services/update";
import { Icon } from "./icons";
import { Button } from "./ui/Button";
import { StatePanels } from "./ui/Controls";
import { Dialog } from "./ui/Dialog";

/**
 * The update of the app (NP-038, NP-102, sheet 42), opened from the row in the sidebar or «Update…»
 * in Settings, never by itself. It follows the status Rust reports: the offer, the download, the
 * installation and a failure; the caller closes it when no version is in play any more.
 */
export function UpdateDialog({
  update,
  current,
  linux,
  onClose,
  onInstall,
  onCancel,
  onOpen,
}: {
  update: Offer;
  /** The version that runs now. */
  current: string;
  /** Linux asks for the password through polkit; Windows restarts through the installer. */
  linux: boolean;
  onClose: () => void;
  onInstall: () => void;
  onCancel: () => void;
  onOpen: (url: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { version } = update;
  // What changed is known only with the offer; the dialog keeps the room for it through the download.
  const [notes] = useState(() => (update.state === "available" ? update.notes : []));

  const downloadingPanel = (share: number | null, received: number, total: number | null) => (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-col gap-2">
        <div
          role="progressbar"
          aria-label={t("update.downloadingTitle", { version })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={share ?? undefined}
          className="h-1.5 overflow-hidden rounded-full bg-line dark:bg-divider"
        >
          <span className="block h-full rounded-full bg-accent" style={{ width: `${share ?? 0}%` }} />
        </div>
        <p className="flex justify-between text-xs text-muted">
          <span>
            {total
              ? t("update.size", { received: megabytes(received, i18n.language), total: megabytes(total, i18n.language) })
              : megabytes(received, i18n.language)}
          </span>
          {share !== null && <span className="font-medium text-ink">{share}%</span>}
        </p>
      </div>
      <p className="mt-4 text-sm text-muted">{t("update.hideHint")}</p>
      <footer className="mt-auto flex justify-end gap-2 pt-5">
        <Button variant="outline" size="lg" onClick={onCancel}>
          {t("update.cancel")}
        </Button>
        <Button variant="primary" size="lg" autoFocus onClick={onClose}>
          {t("update.hide")}
        </Button>
      </footer>
    </div>
  );

  const installingPanel = () => (
    <div className="flex flex-col">
      <p role="status" className="flex items-center gap-2.5 text-sm font-medium">
        <span aria-hidden className="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-line border-t-accent dark:border-divider dark:border-t-accent" />
        {t(linux ? "update.passwordAsked" : "update.closing")}
      </p>
      {linux && <p className="mt-3 text-sm text-muted">{t("update.installingKeep", { current })}</p>}
    </div>
  );

  const failedPanel = (problem: UpdateProblem) => (
    <div className="flex flex-1 flex-col">
      <p className="text-sm text-muted">{t("update.keepsWorking", { current })}</p>
      <div role="alert" className="mt-3 flex gap-2.5 rounded-lg bg-amber-soft px-3 py-2.5 text-sm text-on-amber-soft">
        <Icon icon={TriangleAlert} className="mt-px shrink-0 text-amber" />
        <span className="flex flex-col items-start gap-1">
          {t(`update.problem.${problem}`)}
          {problem === "install_failed" && (
            <button type="button" onClick={() => onOpen(DOWNLOAD_PAGE)} className="font-medium underline">
              koona.app/pin ↗
            </button>
          )}
        </span>
      </div>
      <footer className="mt-auto flex justify-end gap-2 pt-5">
        <Button variant="outline" size="lg" onClick={onClose}>
          {t("common.close")}
        </Button>
        <Button variant="primary" size="lg" autoFocus onClick={onInstall}>
          {t("common.retry")}
        </Button>
      </footer>
    </div>
  );

  // What changed, from latest.json (NP-040, sheet 42a): English, as the site's changelog; a long list
  // scrolls, and gives way when the dialog is shorter than it.
  const availablePanel = (shownNotes: string[]) => (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="text-sm text-muted">{t("update.current", { current })}</p>
      {shownNotes.length > 0 && (
        <section aria-labelledby="update-notes" className="mt-3.5 flex min-h-0 flex-col">
          <h3 id="update-notes" className="text-sm font-semibold">
            {t("update.whatsNew", { version })}
          </h3>
          <ul lang="en" className="mt-1.5 max-h-[120px] min-h-0 overflow-y-auto text-sm leading-5 text-muted">
            {shownNotes.map((note) => (
              <li key={note} className="flex gap-2">
                <span aria-hidden>•</span>
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <button type="button" onClick={() => onOpen(notesUrl(update))} className="mt-2 self-start text-sm font-medium text-accent hover:underline">
        {t("update.fullChangelog")} ↗
      </button>
      <p className="mt-3.5 rounded-lg bg-secondary px-3 py-2.5 text-xs leading-[17px] text-muted">{t(linux ? "update.linuxHint" : "update.windowsHint")}</p>
      <footer className="mt-auto flex justify-end gap-2 pt-5">
        <Button variant="outline" size="lg" onClick={onClose}>
          {t("update.later")}
        </Button>
        <Button variant="primary" size="lg" autoFocus onClick={onInstall}>
          {t("update.update")}
        </Button>
      </footer>
    </div>
  );

  const state = update.state;
  const title = {
    available: t("update.title", { version }),
    downloading: t("update.downloadingTitle", { version }),
    installing: t("update.installingTitle", { version }),
    failed: t("update.failedTitle"),
  }[state];
  return (
    <Dialog title={title} onClose={onClose}>
      <StatePanels value={state} states={["available", "downloading", "installing", "failed"] as const}>
        {(shown, sizing) => {
          if (shown === "available") return availablePanel(sizing ? notes : update.state === "available" ? update.notes : []);
          if (shown === "downloading")
            return sizing
              ? downloadingPanel(100, 0, 0)
              : update.state === "downloading" && downloadingPanel(percent(update), update.received, update.total);
          if (shown === "installing") return installingPanel();
          return sizing ? failedPanel("install_failed") : update.state === "failed" && failedPanel(update.problem);
        }}
      </StatePanels>
    </Dialog>
  );
}
