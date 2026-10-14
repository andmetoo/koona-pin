// Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//
// What each state of sync says (NP-059, NP-063, sheet 46): the banners of the Sync dialog and the
// one line of the Supporter dialog and of Settings. Rust has no words for people: every phase,
// pause, problem and notice of `SyncStatus` gets its text here.
import type { TFunction } from "i18next";
import type { Plan, SyncDevice, SyncNotice, SyncProblem, SyncStatus } from "../../types";

/** Green of collections — synced; ochre — waiting or needs the person; blue of the update row — under way. */
export type SyncTone = "ok" | "warn" | "sync";

/** What a banner's button does; the dialog runs it. */
export type SyncAction = "retry" | "update" | "renew" | "join" | "signIn" | "addAgain" | "review" | "startOver";

export interface SyncBanner {
  /** Stable, for tests and for keys: the phase, the reason, the problem or the notice. */
  id: string;
  tone: SyncTone;
  title: string;
  body?: string;
  action?: { kind: SyncAction; label: string };
  /** The notice a «Review» dismisses. */
  notice?: string;
}

/** «just now», «5 minutes ago», «3 hours ago», «2 days ago», in the interface's language. */
export function ago(ms: number, t: TFunction, language: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - ms) / 1000);
  if (seconds < 60) return t("sync.justNow");
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  if (seconds < 3600) return format.format(-Math.round(seconds / 60), "minute");
  if (seconds < 86_400) return format.format(-Math.round(seconds / 3600), "hour");
  return format.format(-Math.round(seconds / 86_400), "day");
}

/** The system a device said it runs: «macOS», «Windows», «Linux», another word as it came; none unknown. */
export function platformName(platform: string | null | undefined): string | null {
  const word = platform?.trim();
  if (!word) return null;
  return { macos: "macOS", windows: "Windows", linux: "Linux" }[word.toLowerCase()] ?? word;
}

/** What kind of device it is, for its icon: a phone or a tablet if it says so, else a computer. */
export function deviceKind(platform: string | null | undefined): "computer" | "phone" | "tablet" {
  const word = platform?.trim().toLowerCase();
  if (word === "ios" || word === "android") return "phone";
  if (word === "ipados") return "tablet";
  return "computer";
}

/**
 * The line under a computer's name. This one: «macOS · Koona Pin 0.13.0» (its version, else the
 * running app's); another: «Windows · online», «Linux · last seen 3 hours ago». Without a platform,
 * as before: «Koona Pin 0.13.0», «Online», «Last seen 3 hours ago».
 */
export function deviceDetail(device: SyncDevice, t: TFunction, language: string, own: { version?: string } | null = null, now = Date.now()): string {
  const platform = platformName(device.platform);
  if (own) {
    const version = device.app || own.version;
    const app = version ? t("sync.version", { version }) : "";
    if (!platform) return app;
    return app ? t("sync.platformDetail", { platform, detail: app }) : platform;
  }
  if (!platform) return seenText(device, t, language, false, now);
  return t("sync.platformDetail", { platform, detail: seenText(device, t, language, true, now) });
}

/** «Online», «Last seen 3 hours ago», «Waiting for approval»; `inLine` after a platform, lower case. */
export function seenText(device: SyncDevice, t: TFunction, language: string, inLine = false, now = Date.now()): string {
  const key = inLine ? "sync.inLine" : "sync";
  if (device.status === "pending") return t(inLine ? "sync.inLine.pending" : "sync.pendingDevice");
  if (device.online) return t(`${key}.online`);
  if (device.last_seen) return t(`${key}.lastSeen`, { when: ago(device.last_seen, t, language, now) });
  return t(inLine ? "sync.inLine.never" : "sync.neverSeen");
}

/** A clock's offset in the largest unit that reads well: under 90 s in seconds, then minutes, hours, days. */
function clockUnit(ms: number): { value: number; unit: "second" | "minute" | "hour" | "day" } {
  const seconds = ms / 1000;
  const size = Math.abs(seconds);
  if (size < 90) return { value: seconds, unit: "second" };
  if (size < 90 * 60) return { value: Math.round(seconds / 60), unit: "minute" };
  if (size < 36 * 3600) return { value: Math.round(seconds / 3600), unit: "hour" };
  return { value: Math.round(seconds / 86_400), unit: "day" };
}

/** How far off a clock is, without its sign: «45 sec», «7 min», «3 hr», «2 days» (the language's short units). */
export function clockAmount(ms: number, language: string): string {
  const { value, unit } = clockUnit(ms);
  const size = unit === "second" ? Math.max(1, Math.round(Math.abs(value))) : Math.abs(value);
  return new Intl.NumberFormat(language, { style: "unit", unit, unitDisplay: "short" }).format(size);
}

/** The offset of Details, signed: «+0.4 sec», «-7 min»; to a tenth below ten seconds. */
export function clockOffset(ms: number, language: string): string {
  const { value, unit } = clockUnit(ms);
  const shown = unit !== "second" ? value : Math.abs(value) < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return new Intl.NumberFormat(language, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: 1, signDisplay: "exceptZero" }).format(shown);
}

/** A moment of Details: «14:02» today, «yesterday 18:40», else «12 Oct, 18:40». */
export function detailTime(iso: string, t: TFunction, language: string, now = Date.now()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(language, { hour: "numeric", minute: "2-digit" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(at)) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return t("sync.detailsDialog.yesterday", { time });
  return at.toLocaleString(language, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/** «Sync details» (frame 09): the rows above, and what each other computer has. */
export function syncDetails(status: SyncStatus, t: TFunction, language: string, now = Date.now()) {
  const phase = status.phase;
  const word =
    phase.state === "paused" || phase.state === "unavailable"
      ? (syncSummary(status, t, language, "settings")?.text ?? t(`sync.detailsDialog.phase.${phase.state}`))
      : t(`sync.detailsDialog.phase.${phase.state}`);
  const state = status.last_sync_at
    ? t("sync.detailsDialog.stateSynced", { state: word, when: detailTime(status.last_sync_at, t, language, now) })
    : t("sync.detailsDialog.stateNever", { state: word });
  const id = status.device.id;
  const shortId = id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
  const unknown = t("sync.detailsDialog.unknown");
  return {
    state,
    main: hubDevice(status)?.name ?? "—",
    device: `${status.device.name} · ${shortId}`,
    clock: status.clock_offset_ms === null ? unknown : t("sync.detailsDialog.clockValue", { offset: clockOffset(status.clock_offset_ms, language) }),
    key: status.epoch === null ? unknown : t("sync.detailsDialog.generation", { epoch: status.epoch }),
    computers: otherDevices(status).map((d) => {
      const has = d.last_sync_at ? t("sync.detailsDialog.upTo", { when: detailTime(d.last_sync_at, t, language, now) }) : t("sync.detailsDialog.nothingYet");
      return { id: d.id, name: d.name, value: d.online ? has : t("sync.detailsDialog.offline", { detail: has }) };
    }),
  };
}

/** Six digits as both screens show them: «482 913». */
export const spacedCode = (code: string) => code.replace(/\D/g, "").replace(/^(\d{3})(\d{3})$/, "$1 $2");

/** The account's computers that sync: removed and not yet approved ones aside. */
export const activeDevices = (status: SyncStatus) => status.devices.filter((d) => d.status === "active");
export const otherDevices = (status: SyncStatus) => status.devices.filter((d) => d.id !== status.device.id && d.status !== "revoked");
export const hubDevice = (status: SyncStatus): SyncDevice | undefined =>
  status.devices.find((d) => d.id === status.hub) ?? status.devices.find((d) => d.is_hub);
/** The main computer's name, or «the main computer» while it is not known. */
export const hubName = (status: SyncStatus, t: TFunction) =>
  status.pairing?.role === "asking" ? status.pairing.peer_name : (hubDevice(status)?.name ?? t("sync.pair.mainComputer"));

const computers = (status: SyncStatus, t: TFunction) => t("sync.computers", { count: Math.max(1, activeDevices(status).length) });
/** Others exist and none of them is online: changes wait here. */
const othersAway = (status: SyncStatus) => {
  const others = activeDevices(status).filter((d) => d.id !== status.device.id);
  return others.length > 0 && others.every((d) => !d.online);
};

/** A sync started over elsewhere: who did it, from the notice when there is one. */
function startedOverBy(status: SyncStatus): string | null {
  const notice = status.notices.find((n) => n.kind === "started_over");
  return notice?.by_name ?? null;
}

/**
 * The one line of the Supporter dialog («Synced · 3 computers · just now») and of Settings → Data
 * («On · 3 computers · synced just now»); none while sync is off here.
 */
export function syncSummary(status: SyncStatus, t: TFunction, language: string, place: "supporter" | "settings"): { tone: SyncTone; text: string } | null {
  if (!status.enabled) return null;
  if (status.error && status.error !== "stale_sign_in") return { tone: "warn", text: t("sync.short.problem") };
  const phase = status.phase;
  switch (phase.state) {
    case "off":
      return null;
    case "unavailable":
      return { tone: "warn", text: t(phase.reason === "not_supporter" ? "sync.short.plan" : "sync.short.stopped") };
    case "paused": {
      const key = {
        offline: "offline",
        clock_skew: "clock",
        update_needed: "update",
        started_over: "startedOver",
        plan: "plan",
        revoked: "removed",
        signed_out: "signedOut",
        device_limit: "deviceLimit",
      } as const;
      const short = key[phase.reason as keyof typeof key];
      return { tone: "warn", text: t(`sync.short.${short ?? "stopped"}`) };
    }
    case "pending":
      return { tone: "warn", text: t("sync.short.waitingMain", { name: hubName(status, t) }) };
    case "connecting":
      return { tone: "sync", text: t("sync.short.connecting") };
    case "syncing":
      return { tone: "sync", text: t("sync.short.syncing") };
    case "online": {
      if (othersAway(status)) return { tone: "warn", text: t("sync.short.othersOffline") };
      const when = status.last_sync_at ? ago(Date.parse(status.last_sync_at), t, language) : null;
      if (!when) return { tone: "ok", text: t("sync.short.notYet", { computers: computers(status, t) }) };
      return { tone: "ok", text: t(place === "supporter" ? "sync.short.synced" : "sync.short.on", { computers: computers(status, t), when }) };
    }
  }
}

/** Every problem has its title and its line (the test keeps it so). */
export const PROBLEMS: readonly SyncProblem[] = [
  "pairing_rejected",
  "pairing_timeout",
  "pairing_bad_signature",
  "hub_offline",
  "untrusted_hub",
  "not_allowed",
  "relay_refused",
  "peer_error",
  "library_failed",
  "library_replaced",
  "hub_change_denied",
  "hub_change_timeout",
  "stale_sign_in",
  "key_lost",
];
/** What the person can do about a problem, from the banner. */
const PROBLEM_ACTIONS: Partial<Record<SyncProblem, SyncAction>> = {
  pairing_rejected: "retry",
  pairing_timeout: "retry",
  pairing_bad_signature: "retry",
  hub_offline: "startOver",
  untrusted_hub: "startOver",
  relay_refused: "retry",
  peer_error: "retry",
  library_failed: "retry",
  library_replaced: "addAgain",
};

export function problemBanner(problem: SyncProblem, status: SyncStatus, t: TFunction): SyncBanner {
  const name = hubName(status, t);
  const kind = PROBLEM_ACTIONS[problem];
  // Starting over is for a computer that is not the main one.
  const action = kind && !(kind === "startOver" && status.is_hub) ? { kind, label: actionLabel(kind, t) } : undefined;
  return { id: `problem:${problem}`, tone: "warn", title: t(`sync.problem.${problem}`, { name }), body: t(`sync.problem.${problem}Body`, { name }), action };
}

function actionLabel(kind: SyncAction, t: TFunction): string {
  return {
    retry: t("common.retry"),
    update: t("sync.banner.updateAction"),
    renew: t("sync.banner.renew"),
    join: t("sync.banner.join"),
    signIn: t("sync.banner.signIn"),
    addAgain: t("sync.banner.addAgain"),
    review: t("sync.banner.review"),
    startOver: t("sync.banner.startOver"),
  }[kind];
}
const banner = (id: string, tone: SyncTone, title: string, body?: string, kind?: SyncAction, t?: TFunction): SyncBanner => ({
  id,
  tone,
  title,
  body,
  action: kind && t ? { kind, label: actionLabel(kind, t) } : undefined,
});

/** Banners with a title and a line of the same name. */
type BannerKey =
  | "offline"
  | "clock"
  | "update"
  | "revoked"
  | "planEnded"
  | "deviceLimit"
  | "replaced"
  | "signedOut"
  | "noService"
  | "notReady"
  | "connecting"
  | "pending"
  | "askingMain"
  | "othersOffline";

/** The banner of the state of sync at the top of the overview (frames 03, 04, 11). */
export function statusBanner(status: SyncStatus, t: TFunction, language: string): SyncBanner {
  if (status.error && status.error !== "stale_sign_in") return problemBanner(status.error, status, t);
  const phase = status.phase;
  const b = (id: string, tone: SyncTone, key: BannerKey, kind?: SyncAction, values: { name?: string } = {}) =>
    banner(id, tone, t(`sync.banner.${key}`, values), t(`sync.banner.${key}Body`, values), kind, t);
  switch (phase.state) {
    case "paused":
      switch (phase.reason) {
        case "offline":
          return b("paused:offline", "sync", "offline");
        case "clock_skew":
          // «This computer's clock is 7 min off» once the relay's time is known.
          if (status.clock_offset_ms !== null && Math.abs(status.clock_offset_ms) >= 500)
            return banner("paused:clock_skew", "warn", t("sync.banner.clockBy", { amount: clockAmount(status.clock_offset_ms, language) }), t("sync.banner.clockBody"), "retry", t);
          return b("paused:clock_skew", "warn", "clock", "retry");
        case "update_needed": {
          // «Home iMac has a newer version.» when a computer said so, not the relay.
          const from = status.update_from ? status.devices.find((d) => d.id === status.update_from) : undefined;
          if (from) return banner("paused:update_needed", "warn", t("sync.banner.update"), t("sync.banner.updateFrom", { name: from.name }), "update", t);
          return b("paused:update_needed", "warn", "update", "update");
        }
        case "revoked":
          return b("paused:revoked", "warn", "revoked", "addAgain");
        case "plan":
          return b("paused:plan", "warn", "planEnded", "renew");
        case "device_limit":
          return b("paused:device_limit", "warn", "deviceLimit", "retry");
        case "replaced":
          return b("paused:replaced", "warn", "replaced", "retry");
        case "signed_out":
          return b("paused:signed_out", "warn", "signedOut", "signIn");
        case "started_over": {
          const by = startedOverBy(status);
          return banner(
            "paused:started_over",
            "warn",
            by ? t("sync.banner.startedOver", { name: by }) : t("sync.banner.startedOverSomewhere"),
            t("sync.banner.startedOverBody"),
            "join",
            t,
          );
        }
      }
      break;
    case "unavailable":
      if (phase.reason === "not_supporter") return b("unavailable:not_supporter", "warn", "planEnded", "renew");
      if (phase.reason === "no_service") return b("unavailable:no_service", "warn", "noService");
      return b("unavailable:library_not_ready", "sync", "notReady");
    case "connecting":
    case "off":
      return b("connecting", "sync", "connecting");
    case "pending":
      return b("pending", "warn", "pending", "retry", { name: hubName(status, t) });
    case "syncing":
      return banner("syncing", "sync", t("sync.banner.syncing"), t("sync.banner.syncingBody", { done: phase.done.toLocaleString(language), total: phase.total.toLocaleString(language) }));
    case "online":
      break;
  }
  if (status.hub_change?.role === "asking") return b("hub_change:asking", "sync", "askingMain", undefined, { name: status.hub_change.peer_name });
  if (othersAway(status)) return b("online:others_offline", "warn", "othersOffline");
  const when = status.last_sync_at ? ago(Date.parse(status.last_sync_at), t, language) : null;
  const title = when ? t("sync.banner.synced", { when }) : t("sync.banner.notSynced");
  const hub = hubDevice(status);
  // Another computer, the main one away: the others still sync with each other.
  if (!status.is_hub && hub && !hub.online) return banner("online:main_offline", "ok", title, t("sync.banner.mainOffline", { name: hub.name }));
  // «3 computers · 12,480 bookmarks» while the library is open.
  const body = status.bookmarks === null ? computers(status, t) : t("sync.banner.syncedBody", { computers: computers(status, t), bookmarks: t("restore.bookmarks", { count: status.bookmarks }) });
  return banner("online", "ok", title, body);
}

/** A notice until the person dismisses it: a computer added, sync started over elsewhere. */
export function noticeBanner(notice: SyncNotice, t: TFunction, language: string): SyncBanner {
  const when = ago(Date.parse(notice.at), t, language);
  if (notice.kind === "device_added")
    return {
      id: `notice:device_added`,
      tone: "ok",
      title: t("sync.banner.added", { name: notice.name }),
      body: notice.by_name ? t("sync.banner.addedBy", { name: notice.by_name, when }) : t("sync.banner.addedAt", { when }),
      action: { kind: "review", label: actionLabel("review", t) },
      notice: notice.id,
    };
  return {
    id: `notice:started_over`,
    tone: "warn",
    title: notice.by_name ? t("sync.banner.startedOver", { name: notice.by_name }) : t("sync.banner.startedOverSomewhere"),
    body: t("sync.banner.startedOverBody"),
    action: { kind: "join", label: actionLabel("join", t) },
    notice: notice.id,
  };
}

/** Supporter ends within a month and does not renew: sync stops then (frame 11). */
export function planEndsBanner(plan: Plan | null | undefined, t: TFunction, language: string, now = Date.now()): SyncBanner | null {
  if (!plan || plan.status !== "canceling") return null;
  const end = Date.parse(plan.valid_until);
  if (!(end > now) || end - now > 31 * 86_400_000) return null;
  const date = new Date(end).toLocaleDateString(language, { day: "numeric", month: "long" });
  return banner("plan_ends", "warn", t("sync.banner.planEnds", { date }), t("sync.banner.planEndsBody"), "renew", t);
}

/**
 * Every banner of the overview, the state first: the notices, and the end of the plan. A
 * started-over pause and its notice say the same: the notice alone stays.
 */
export function overviewBanners(status: SyncStatus, plan: Plan | null | undefined, t: TFunction, language: string): SyncBanner[] {
  const notices = status.notices.map((n) => noticeBanner(n, t, language));
  const state = statusBanner(status, t, language);
  const list = state.id === "paused:started_over" && notices.some((n) => n.id === "notice:started_over") ? [] : [state];
  const ends = planEndsBanner(plan, t, language);
  return [...list, ...notices, ...(ends ? [ends] : [])];
}

/** Which screen of the dialog the status asks for (frames 02, 03/04, 05, 06, 07, 12). */
export type SyncView = "setup" | "pairHub" | "mainAsked" | "waiting" | "receiving" | "overview";
export function syncView(status: SyncStatus): SyncView {
  if (!status.enabled || status.phase.state === "off") return "setup";
  if (status.pairing?.role === "hub" && status.pairing.code) return "pairHub";
  if (status.hub_change?.role === "hub") return "mainAsked";
  if (status.pairing?.role === "asking" || status.phase.state === "pending") return "waiting";
  // The first transfer on a computer that joined: the library arrives.
  if (status.phase.state === "syncing" && !status.is_hub && !status.last_sync_at) return "receiving";
  return "overview";
}

/** A prompt that opens the dialog by itself on the main computer: a computer to approve, a request to hand over. */
export function syncPrompt(status: SyncStatus | null): string | null {
  if (!status?.enabled) return null;
  if (status.pairing?.role === "hub" && status.pairing.code) return `pair:${status.pairing.peer}:${status.pairing.code}`;
  if (status.hub_change?.role === "hub") return `main:${status.hub_change.peer}`;
  return null;
}
