import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DOWNLOAD_PAGE, megabytes, notesUrl, Offer, percent } from "../services/update";
import { Icon } from "./icons";
import { Button } from "./ui/Button";
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

  if (update.state === "downloading") {
    const share = percent(update);
    return (
      <Dialog title={t("update.downloadingTitle", { version })} onClose={onClose}>
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
              {update.total
                ? t("update.size", { received: megabytes(update.received, i18n.language), total: megabytes(update.total, i18n.language) })
                : megabytes(update.received, i18n.language)}
            </span>
            {share !== null && <span className="font-medium text-ink">{share}%</span>}
          </p>
        </div>
        <p className="mt-4 text-sm text-muted">{t("update.hideHint")}</p>
        <footer className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="lg" onClick={onCancel}>
            {t("update.cancel")}
          </Button>
          <Button variant="primary" size="lg" autoFocus onClick={onClose}>
            {t("update.hide")}
          </Button>
        </footer>
      </Dialog>
    );
  }

  if (update.state === "installing") {
    return (
      <Dialog title={t("update.installingTitle", { version })} onClose={onClose}>
        <p role="status" className="flex items-center gap-2.5 text-sm font-medium">
          <span aria-hidden className="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-line border-t-accent dark:border-divider dark:border-t-accent" />
          {t(linux ? "update.passwordAsked" : "update.closing")}
        </p>
        {linux && <p className="mt-3 text-sm text-muted">{t("update.installingKeep", { current })}</p>}
      </Dialog>
    );
  }

  if (update.state === "failed") {
    return (
      <Dialog title={t("update.failedTitle")} onClose={onClose}>
        <p className="text-sm text-muted">{t("update.keepsWorking", { current })}</p>
        <div role="alert" className="mt-3 flex gap-2.5 rounded-lg bg-amber-soft px-3 py-2.5 text-sm text-on-amber-soft">
          <Icon icon={TriangleAlert} className="mt-px shrink-0 text-amber" />
          <span className="flex flex-col items-start gap-1">
            {t(`update.problem.${update.problem}`)}
            {update.problem === "install_failed" && (
              <button type="button" onClick={() => onOpen(DOWNLOAD_PAGE)} className="font-medium underline">
                koona.app/pin ↗
              </button>
            )}
          </span>
        </div>
        <footer className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="lg" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button variant="primary" size="lg" autoFocus onClick={onInstall}>
            {t("common.retry")}
          </Button>
        </footer>
      </Dialog>
    );
  }

  return (
    <Dialog title={t("update.title", { version })} onClose={onClose}>
      <p className="text-sm text-muted">{t("update.current", { current })}</p>
      <button type="button" onClick={() => onOpen(notesUrl(update))} className="mt-2.5 text-sm font-medium text-accent hover:underline">
        {t("update.whatsNew", { version })} ↗
      </button>
      <p className="mt-3.5 rounded-lg bg-secondary px-3 py-2.5 text-xs leading-[17px] text-muted">{t(linux ? "update.linuxHint" : "update.windowsHint")}</p>
      <footer className="mt-5 flex justify-end gap-2">
        <Button variant="outline" size="lg" onClick={onClose}>
          {t("update.later")}
        </Button>
        <Button variant="primary" size="lg" autoFocus onClick={onInstall}>
          {t("update.update")}
        </Button>
      </footer>
    </Dialog>
  );
}
