// Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
import { useTranslation } from "react-i18next";
import type { SyncStatus } from "../../types";
import { Button } from "../ui/Button";
import { Dot } from "../ui/Controls";
import { toneColor } from "./SyncDialog";
import { syncSummary } from "./syncText";

/**
 * The sync perk of the Supporter dialog (sheet 46, frame 01) in place of «Soon»: off with «Set up…»,
 * or its state on one line with «Manage…». A build without a relay keeps «Soon».
 */
export function SyncPerkRow({ status, onOpen }: { status: SyncStatus | null; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  if (!status?.available)
    return (
      <>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t("supporter.perk.sync")}</span>
          <span className="block text-xs leading-[17px] text-muted">{t("supporter.perk.syncHint")}</span>
        </span>
        <span className="shrink-0 rounded-full bg-secondary px-2.5 py-0.5 text-2xs font-medium text-subtle">{t("supporter.soon")}</span>
      </>
    );
  const summary = syncSummary(status, t, i18n.language, "supporter");
  return (
    <>
      <span className="min-w-0 flex-1" data-sync-perk={summary ? summary.tone : "off"}>
        <span className="block text-sm font-medium">{t("supporter.perk.sync")}</span>
        {summary ? (
          <span className={`flex items-center gap-1.5 text-xs leading-[17px] ${summary.tone === "warn" ? "text-on-amber-soft dark:text-amber" : "text-muted"}`}>
            <Dot color={toneColor(summary.tone)} />
            <span className="min-w-0">{summary.text}</span>
          </span>
        ) : (
          <span className="block text-xs leading-[17px] text-muted">{t("sync.perkOff")}</span>
        )}
      </span>
      <Button variant="outline" onClick={onOpen}>
        {summary ? t("sync.manage") : t("sync.setUp")}
      </Button>
    </>
  );
}

/** Settings → Sync and backups «Sync» (frame 10): the state and «Manage…»; without Supporter, «Learn more». */
export function useSyncSettingsLine(status: SyncStatus | null) {
  const { t, i18n } = useTranslation();
  if (!status) return null;
  const summary = syncSummary(status, t, i18n.language, "settings");
  return summary
    ? {
        description: (
          <span className="flex items-center gap-1.5">
            <Dot color={toneColor(summary.tone)} />
            {summary.text}
          </span>
        ),
        button: t("sync.manage"),
      }
    : { description: t("sync.settingsOff"), button: t("sync.setUp") };
}
