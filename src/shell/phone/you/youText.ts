import type { TFunction } from "i18next";
import { activeDevices, hubDevice, statusBanner } from "../../../components/commercial/syncText";
import { capabilities } from "../../../platform/capabilities";
import type { Plan, SupporterStatus, SyncDevice, SyncStatus } from "../../../types";
import { type SyncState, syncState } from "../ui/accountState";

// What "You & sync" (A1) and the phone's Settings say of Supporter and sync (NP-072b), apart from
// the components so Vitest reads them. The words of sync's states are the desktop's
// (components/commercial/syncText.ts); only the phone's own lines are here.

/** "9 Oct 2027" in the interface's language. */
const day = (iso: string, language: string) => new Date(iso).toLocaleDateString(language, { day: "numeric", month: "short", year: "numeric" });

/**
 * The Supporter card's second line from the plan as kept: "Thank you · yearly plan, renews 9 Oct
 * 2027", "… ends 3 Nov 2026" when it does not renew, "… Lifetime, paid once" for Lifetime;
 * a renewal that failed and a subscription still renewing beside Lifetime say so, as the plan
 * dialog does. Where the build sells nothing (`sells` false: the store build until NP-154) those two
 * say so without sending anyone to update a card or to Manage: no way to pay is named. A plan paid
 * through Google Play (NP-154) sends the person to Google Play, which the plan sheet links to.
 */
export function planLine(plan: Plan, t: TFunction, language: string, sells = capabilities.purchase === "paddle"): string {
  const play = plan.store === "play";
  if (plan.status === "past_due")
    return play ? t("supporter.pastDuePlay") : sells ? t("supporter.pastDue") : t("phone.supporter.pastDue", { date: day(plan.valid_until!, language) });
  if (plan.interval === "lifetime") {
    if (plan.also_renews) return t(play ? "supporter.alsoRenewsPlay" : sells ? "supporter.alsoRenews" : "phone.supporter.alsoRenews");
    // No end, but a license tester's test purchase on Play has its one day.
    const when = plan.valid_until ? t("phone.you.until", { date: day(plan.valid_until, language) }) : t("phone.you.paidOnce");
    return t("phone.you.planLine", { plan: t("phone.you.plan.lifetime"), when });
  }
  const kind = t(plan.interval === "month" ? "phone.you.plan.monthly" : "phone.you.plan.yearly");
  const when =
    plan.status === "canceling" || !plan.renews_at
      ? t("phone.you.ends", { date: day(plan.valid_until!, language) })
      : t("phone.you.renews", { date: day(plan.renews_at, language) });
  return t("phone.you.planLine", { plan: kind, when });
}

/**
 * What the Sync shelf shows. `hidden`: the build sells no Supporter or has no relay; `free`: sync
 * is a Supporter perk, explained with the way to it; `off`: a Supporter who has not turned sync on
 * here; `on`: the state with its circle, a title, a line and the devices.
 */
export type SyncCard =
  | { kind: "hidden" }
  | { kind: "free" }
  | { kind: "off" }
  | { kind: "on"; circle: SyncState; title: string; body?: string; devices: SyncDevice[]; busy: boolean };

export function syncCard(supporter: SupporterStatus | null, sync: SyncStatus | null, t: TFunction, language: string): SyncCard {
  if (!supporter?.available || !sync?.available) return { kind: "hidden" };
  if (!supporter.plan) return { kind: "free" };
  if (!sync.enabled || sync.phase.state === "off") return { kind: "off" };
  const banner = statusBanner(sync, t, language);
  let body = banner.body;
  // Online and nothing to say: how many devices, and which one is the main computer (A1).
  if (banner.id === "online") {
    const devices = t("phone.you.devices", { count: Math.max(1, activeDevices(sync).length) });
    const hub = hubDevice(sync);
    body = hub ? t("phone.you.mainIs", { devices, name: hub.name }) : devices;
  }
  return {
    kind: "on",
    circle: syncState(sync),
    title: banner.title,
    body,
    devices: deviceChips(sync),
    busy: sync.phase.state === "syncing" || sync.phase.state === "connecting",
  };
}

/** The devices as chips: this one first, then the others that sync (removed and pending aside). */
export function deviceChips(sync: SyncStatus): SyncDevice[] {
  const own = sync.devices.find((d) => d.id === sync.device.id) ?? sync.device;
  return [own, ...activeDevices(sync).filter((d) => d.id !== own.id)];
}

/** The reader's text size by name for a row's value (FL3 "Text size · Large"): the slider's px in four steps. */
export function sizeName(size: number): "small" | "default" | "large" | "largest" {
  if (size <= 16) return "small";
  if (size <= 18) return "default";
  if (size <= 20) return "large";
  return "largest";
}
