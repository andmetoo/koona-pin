import { useState } from "react";
import { CircleAlert, CloudOff, RefreshCw } from "lucide-react";
import { capabilities } from "../../../platform/capabilities";
import { api } from "../../../services/api";
import { describeError } from "../../../services/errors";
import { usePhone } from "../PhoneContext";
import { Button } from "../ui/buttons";
import { CloudCheck, PhIcon } from "../ui/icons";
import { type SyncCard as Card, syncCard } from "./youText";

const CIRCLE_ICONS = { synced: CloudCheck, syncing: RefreshCw, offline: CloudOff, error: CircleAlert } as const;

/** The sync shelf's state for this render: Supporter, the plan and sync as the app keeps them. */
export function useSyncCard(): Card {
  const { app } = usePhone();
  return syncCard(app.supporter, app.sync, app.t, app.i18n.language);
}

/**
 * "Sync now" (the Sync dialog's own action): the answer is the new status; a failure is an alert.
 * Busy while it runs.
 */
export function useSyncNow() {
  const { app } = usePhone();
  const [running, setRunning] = useState(false);
  const run = () => {
    setRunning(true);
    api
      .syncNow()
      .then(app.setSync)
      .catch((err) => app.say(describeError(err), true))
      .finally(() => setRunning(false));
  };
  return { running, run };
}

/**
 * A1's sync card: the green circle with the state as the account cluster shows it (synced, turning
 * arrows, a hairline circle offline, a red dot on a problem), "Synced 2 min ago", the devices and
 * the main computer, and "Sync now"; the state opens the shared Sync dialog to manage it. Sync that
 * is off offers to set it up; without a plan the card explains the perk and leads to Supporter.
 * Below it, the devices as chips with a green dot when online. Nothing in a build without sync.
 */
export function SyncCard({ card, devices = true }: { card: Card; devices?: boolean }) {
  const { app } = usePhone();
  const { t, setSurface } = app;
  const syncNow = useSyncNow();
  if (card.kind === "hidden") return null;
  if (card.kind !== "on") {
    const free = card.kind === "free";
    const paddle = capabilities.purchase === "paddle";
    return (
      <div className="ys-card ys-sync" data-sync-card={card.kind}>
        <div className="ys-sync-status">
          <span className="ys-sync-circle" data-state="offline" aria-hidden="true">
            <PhIcon icon={CloudOff} at="field" />
          </span>
          <span className="ys-sync-text">
            <span className="ys-sync-title">{t(free ? "phone.you.freeTitle" : "phone.you.offTitle")}</span>
            <span className="ph-meta">{t(free ? "phone.you.freeText" : "phone.you.offText")}</span>
          </span>
        </div>
        {/* Without a plan on sale here, the Supporter card above already offers the sign-in. */}
        {(!free || paddle) && (
          <div className="ys-sync-actions">
            <Button kind="clear" compact onClick={() => setSurface(free ? "supporter" : "sync")}>
              {t(free ? "sync.learnMore" : "sync.setUp")}
            </Button>
          </div>
        )}
      </div>
    );
  }
  return (
    <>
      <div className="ys-card ys-sync" data-sync-card="on" data-state={card.circle}>
        <button type="button" className="ys-sync-status" aria-label={`${card.title}. ${t("phone.you.manage")}`} onClick={() => setSurface("sync")}>
          <span className="ys-sync-circle" data-state={card.circle} aria-hidden="true">
            <PhIcon icon={CIRCLE_ICONS[card.circle]} at="field" />
          </span>
          <span className="ys-sync-text">
            <span className="ys-sync-title">{card.title}</span>
            {card.body && <span className="ph-meta">{card.body}</span>}
          </span>
        </button>
        <div className="ys-sync-actions">
          <Button kind="clear" compact icon={RefreshCw} disabled={card.busy || syncNow.running} onClick={syncNow.run}>
            {t("sync.syncNow")}
          </Button>
        </div>
      </div>
      {devices && card.devices.length > 0 && (
        <ul className="ys-devices" aria-label={t("phone.settings.devices")}>
          {card.devices.map((d, i) => (
            <li key={d.id} className="ys-device" data-own={i === 0 || undefined} data-online={d.online || undefined}>
              <span className="ys-device-dot" aria-hidden="true" />
              {d.name}
              <span className="sr-only">, {t(d.online ? "phone.you.online" : "phone.you.away")}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
