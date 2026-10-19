import { CircleAlert, CloudOff, Heart, RefreshCw, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SyncState } from "./accountState";
import { glass } from "./Glass";
import { CloudCheck, PhIcon } from "./icons";

const SYNC_ICONS = { synced: CloudCheck, syncing: RefreshCw, offline: CloudOff, error: CircleAlert } as const;

/**
 * The account cluster at the top right of every top-level screen (owner, 18 October): for a
 * Supporter one chrome-glass capsule 80 × 40 with the Supporter heart in the season's colour and
 * a flat green circle 32 for sync (synced, syncing, offline as a hairline circle, error with a red
 * dot); for everyone else a 40 glass gear circle. A tap opens "You & sync" (A1).
 */
export function AccountCluster({
  supporter,
  sync,
  badge = true,
  onOpen,
}: {
  supporter: boolean;
  sync: SyncState;
  /** The Supporter badge (PlanDialog turns it off): off, the heart is a plain outline. */
  badge?: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  if (!supporter)
    return (
      <button type="button" data-account="free" data-free className={`ph-account ph-hit ${glass()}`} aria-label={t("phone.account.open")} onClick={onOpen}>
        <PhIcon icon={Settings} />
      </button>
    );
  return (
    <button
      type="button"
      data-account="supporter"
      data-sync={sync}
      className={`ph-account ph-hit ${glass()}`}
      aria-label={`${t("phone.account.open")}, ${t(`phone.account.${sync}`)}`}
      onClick={onOpen}
    >
      <span className="ph-account-heart" style={badge ? undefined : { color: "var(--ph-icon)" }}>
        <Heart size={20} strokeWidth={1.75} absoluteStrokeWidth fill={badge ? "currentColor" : "none"} aria-hidden="true" />
      </span>
      <span className="ph-account-sync" data-state={sync}>
        <PhIcon icon={SYNC_ICONS[sync]} at="field" size={17} />
      </span>
    </button>
  );
}
