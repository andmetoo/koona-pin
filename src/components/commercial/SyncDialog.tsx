// Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Monitor, RefreshCw, Smartphone, Tablet, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Plan, SyncAccount, SyncDevice, SyncStatus } from "../../types";
import { api } from "../../services/api";
import { describeError, toCommandError } from "../../services/errors";
import { Icon } from "../icons";
import { ConfirmDialog } from "../library/Dialogs";
import { Button } from "../ui/Button";
import { Dot, Field } from "../ui/Controls";
import { Dialog } from "../ui/Dialog";
import {
  deviceDetail,
  deviceKind,
  hubDevice,
  hubName,
  otherDevices,
  overviewBanners,
  problemBanner,
  spacedCode,
  syncDetails,
  syncView,
  type SyncAction,
  type SyncBanner,
  type SyncTone,
} from "./syncText";
import { HelpLink } from "../ui/HelpLink";

/** A screen the person opened from the overview, over what the status asks for. */
type Opened = { kind: "details" } | { kind: "remove"; device: SyncDevice } | { kind: "startOver" };

const TONE_COLOR: Record<SyncTone, string> = { ok: "var(--np-accent)", warn: "var(--np-amber)", sync: "var(--np-update)" };
const BANNER_CLASS: Record<SyncTone, { box: string; icon: string; action: string }> = {
  ok: { box: "bg-accent-soft text-ink", icon: "text-accent", action: "text-accent" },
  warn: { box: "bg-amber-soft text-on-amber-soft", icon: "text-amber", action: "text-amber" },
  sync: { box: "bg-update-soft text-on-update-soft", icon: "text-update", action: "text-update" },
};

/**
 * «Sync» (NP-059, NP-063, sheet 46): the first turn-on, the overview of this computer and the
 * others, and the screens sync asks for by itself — a computer to approve on the main one (05), the
 * wait on a new one (06), the library arriving (07), a request to hand the main computer over (12).
 * Each screen is a dialog of its own size, as in the mockups; the overview opens Details (09),
 * Remove (08) and Start over (13).
 */
export function SyncDialog({
  status,
  plan,
  onStatus,
  onClose,
  onCopy,
  onUpdate,
  onRenew,
  onSignIn,
}: {
  status: SyncStatus;
  /** Supporter's plan here: «Sync stops on…» when it ends soon. */
  plan: Plan | null;
  /** Every command answers the new status. */
  onStatus: (status: SyncStatus) => void;
  onClose: () => void;
  onCopy: (text: string) => void;
  /** «Update»: the app's update dialog. */
  onUpdate: () => void;
  /** «Renew…»: the Supporter dialog. */
  onRenew: () => void;
  /** «Sign in…»: the Supporter sign-in. */
  onSignIn: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [opened, setOpened] = useState<Opened | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState("");
  // «Review» of a computer added: its row is marked until the dialog closes.
  const [reviewed, setReviewed] = useState<string | null>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  // «Make this the main computer» sent, its answer not in yet.
  const [asked, setAsked] = useState(false);
  // The session shows the request a moment after the command: whether it was seen under way yet.
  const sawAsking = useRef(false);
  useEffect(() => {
    void api.getVersion().then(setVersion).catch(() => {});
  }, []);

  /** The help on sync (NP-092) in the browser; a browser that does not open is said in the dialog. */
  const openHelp = (url: string) => void api.openUrl(url).catch((err) => setError(describeError(err)));

  /** Runs a command; its status is shown, a failure stays in the dialog. Returns whether it worked. */
  const run = async (action: () => Promise<SyncStatus | void>): Promise<SyncStatus | null> => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (next) onStatus(next);
      return next ?? status;
    } catch (err) {
      setError(describeError(err));
      return null;
    } finally {
      setBusy(false);
    }
  };
  // Stable: the screens it closes wait on it in effects (the start-over timeout).
  const back = useCallback(() => {
    setError(null);
    setOpened(null);
  }, []);

  const hub = hubDevice(status);
  // «Make this the main computer»: asked of the main one while it is online; away, starting over by
  // email is the way, and so is a request that finds it offline.
  const makeMain = async () => {
    if (!hub?.online) {
      setOpened({ kind: "startOver" });
      return;
    }
    sawAsking.current = false;
    if (await run(api.requestMain)) setAsked(true);
  };
  // The main computer turns out offline only when the relay answers, after the command: the
  // request's status leads to starting over, as an offline main computer does from the start.
  const askingRole = status.hub_change?.role ?? null;
  useEffect(() => {
    if (!asked) return;
    if (status.error === "hub_offline") {
      setAsked(false);
      setOpened({ kind: "startOver" });
    } else if (status.error) setAsked(false);
    else if (askingRole === "asking") sawAsking.current = true;
    // The request was under way and ended (allowed, or given up): nothing more to wait for.
    else if (sawAsking.current) setAsked(false);
  }, [asked, status.error, askingRole]);
  const act = (banner: SyncBanner) => {
    const kind: SyncAction | undefined = banner.action?.kind;
    if (kind === "retry") void run(api.syncNow);
    else if (kind === "update") onUpdate();
    else if (kind === "renew") onRenew();
    else if (kind === "signIn") onSignIn();
    else if (kind === "join") void run(api.joinSyncAgain);
    else if (kind === "addAgain") void run(() => api.enableSync(status.device.name));
    else if (kind === "startOver") setOpened({ kind: "startOver" });
    else if (kind === "review" && banner.notice) {
      const notice = status.notices.find((n) => n.id === banner.notice);
      if (notice?.kind === "device_added") setReviewed(notice.device);
      // The banner and its button go: focus stays in the footer, not on the dialog itself.
      doneRef.current?.focus();
      void run(() => api.dismissSyncNotice(banner.notice!));
    }
  };

  const view = syncView(status);
  // A screen opened from the overview gives way to one sync asks for: a code to compare comes first.
  const shown = opened && (view === "overview" || (opened.kind === "details" && view !== "pairHub" && view !== "mainAsked")) ? opened : null;
  // Leaving the screen the person opened when sync takes over.
  useEffect(() => {
    if (opened && !shown) setOpened(null);
  }, [opened, shown]);

  if (shown?.kind === "remove")
    return (
      <ConfirmDialog
        key="remove"
        title={t("sync.removeTitle", { name: shown.device.name })}
        text={t("sync.removeText")}
        confirm={t("sync.removeConfirm")}
        onClose={back}
        onConfirm={async () => {
          onStatus(await api.removeDevice(shown.device.id));
          back();
        }}
      />
    );
  if (shown?.kind === "details") return <DetailsDialog key="details" status={status} onCopy={onCopy} onClose={back} />;
  if (shown?.kind === "startOver")
    return (
      <StartOverDialog
        key="startOver"
        status={status}
        onStatus={onStatus}
        onClose={back}
      />
    );

  if (view === "setup") return <SetupDialog key="setup" status={status} busy={busy} error={error} onClose={onClose} onOpen={openHelp} onTurnOn={(name) => void run(() => api.enableSync(name))} />;

  if (view === "pairHub" && status.pairing?.code) {
    const pairing = status.pairing;
    return (
      <Dialog key="pairHub" title={t("sync.pair.joinTitle", { name: pairing.peer_name })} onClose={onClose} width={480}>
        <div className="flex flex-col" data-sync-view="pairHub">
          <p className="text-sm leading-[18px]">{t("sync.pair.joinLead", { name: pairing.peer_name })}</p>
          <CodeBox code={pairing.code!} label={t("sync.pair.code")} />
          <p className="mt-3 text-xs leading-4 text-muted">{t("sync.pair.joinHint")}</p>
          <ErrorNote text={error} />
          <Footer>
            <Button variant="outline" size="lg" disabled={busy} onClick={() => void run(() => api.rejectDevice(pairing.peer))}>
              {t("sync.pair.reject")}
            </Button>
            <Button variant="primary" size="lg" autoFocus disabled={busy} onClick={() => void run(() => api.approveDevice(pairing.peer))}>
              {t("sync.pair.match")}
            </Button>
          </Footer>
        </div>
      </Dialog>
    );
  }

  if (view === "mainAsked" && status.hub_change) {
    const asking = status.hub_change;
    const peer = status.devices.find((d) => d.id === asking.peer);
    return (
      <Dialog key="mainAsked" title={t("sync.hubChange.title", { name: asking.peer_name })} onClose={onClose} width={480}>
        <div className="flex flex-col" data-sync-view="mainAsked">
          <p className="text-sm leading-[18px]">{t("sync.hubChange.lead", { hub: status.device.name })}</p>
          <div className="mt-4">
            <DeviceRow
              device={peer ?? { id: asking.peer, name: asking.peer_name, online: true, is_hub: false, status: "active", last_seen: null, platform: null, app: null, last_sync_at: null }}
            />
          </div>
          <p className="mt-2 text-xs leading-4 text-muted">{t("sync.hubChange.hint")}</p>
          <ErrorNote text={error} />
          <Footer>
            <Button variant="outline" size="lg" disabled={busy} onClick={() => void run(() => api.answerMainRequest(false))}>
              {t("sync.hubChange.deny")}
            </Button>
            <Button variant="primary" size="lg" autoFocus disabled={busy} onClick={() => void run(() => api.answerMainRequest(true))}>
              {t("sync.hubChange.allow")}
            </Button>
          </Footer>
        </div>
      </Dialog>
    );
  }

  if (view === "waiting") {
    const name = hubName(status, t);
    const code = status.pairing?.role === "asking" ? status.pairing.code : null;
    const away = status.error === "hub_offline" || (hub ? !hub.online : false);
    const problem = status.error && status.error !== "hub_offline" ? problemBanner(status.error, status, t) : null;
    return (
      <Dialog key="waiting" title={t("sync.pair.waitTitle", { name })} onClose={onClose} width={480}>
        <div className="flex flex-col" data-sync-view="waiting">
          <p className="text-sm leading-[18px]">{t("sync.pair.waitLead", { name })}</p>
          {code ? (
            <CodeBox code={code} label={t("sync.pair.code")} />
          ) : (
            <div className="mt-4 flex h-[76px] items-center justify-center gap-2.5 rounded-[10px] border border-border bg-panel text-sm text-muted">
              <Spinner />
              {t("sync.pair.waitNoCode", { name })}
            </div>
          )}
          <p className="mt-3 flex gap-2 text-xs leading-4 text-muted">
            <Icon icon={RefreshCw} className="mt-px shrink-0 text-update" />
            {away ? t("sync.pair.waitOffline", { name }) : t("sync.pair.waitHint")}
          </p>
          {problem && (
            <div className="mt-3">
              <BannerView banner={problem} busy={busy} onAction={act} />
            </div>
          )}
          <ErrorNote text={error} />
          <Footer>
            <Button
              variant="outline"
              size="lg"
              autoFocus
              disabled={busy}
              onClick={() =>
                void run(api.disableSync).then((next) => {
                  if (next) onClose();
                })
              }
            >
              {t("common.cancel")}
            </Button>
          </Footer>
        </div>
      </Dialog>
    );
  }

  if (view === "receiving" && status.phase.state === "syncing") {
    const { done, total } = status.phase;
    const share = total > 0 ? Math.min(1, done / total) : 0;
    return (
      <Dialog key="receiving" title={t("sync.title")} onClose={onClose} width={480}>
        <div className="flex flex-col" data-sync-view="receiving">
          <p className="text-sm font-medium">{t("sync.receive.lead", { name: hubName(status, t) })}</p>
          <div
            role="progressbar"
            aria-label={t("sync.receive.lead", { name: hubName(status, t) })}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            className="mt-3 h-1 overflow-hidden rounded-full bg-update-soft dark:bg-update-track"
          >
            <span className="block h-full rounded-full bg-update transition-[width] duration-300" style={{ width: `${share * 100}%` }} />
          </div>
          <p className="mt-2 text-xs leading-4 text-muted">
            {t("sync.receive.count", { done: done.toLocaleString(i18n.language), total: total.toLocaleString(i18n.language) })}
          </p>
          <p className="mt-2 text-xs leading-4 text-muted">{t("sync.receive.hint")}</p>
          <Footer>
            <Button variant="outline" size="lg" autoFocus onClick={onClose}>
              {t("sync.receive.hide")}
            </Button>
          </Footer>
        </div>
      </Dialog>
    );
  }

  // The overview: this computer, the others, and what sync is doing (frames 03, 04).
  const banners = overviewBanners(status, plan, t, i18n.language);
  const others = otherDevices(status);
  // Removed from the account: only «Add again» (its banner) leads back, so no Rename or Sync now.
  const removed = status.phase.state === "paused" && status.phase.reason === "revoked";
  // Handing the main computer over needs this one in the account and connected.
  const running = status.phase.state === "online" || status.phase.state === "syncing";
  return (
    <Dialog key="overview" title={t("sync.title")} onClose={onClose} width={480}>
      <div className="flex min-h-0 flex-col" data-sync-view="overview" data-sync-hub={status.is_hub || undefined}>
        <div className="-m-1 flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto p-1">
          <div className="flex flex-col gap-2">
            {banners.map((banner) => (
              <BannerView key={banner.id} banner={banner} busy={busy} onAction={act} />
            ))}
          </div>
          <h3 className="mt-4 text-2xs font-semibold text-subtle uppercase">{t("sync.thisComputer")}</h3>
          <ThisComputer status={status} version={version} busy={busy} removed={removed} onRename={(name) => run(() => api.renameDevice(status.device.id, name))} />
          {!status.is_hub && running && (
            <div className="flex items-center gap-3 pl-7">
              <Button variant="outline" disabled={busy || status.hub_change?.role === "asking"} onClick={() => void makeMain()}>
                {t("sync.makeMain")}
              </Button>
              {hub && !hub.online && <span className="text-xs leading-4 text-muted">{t("sync.makeMainOffline")}</span>}
            </div>
          )}
          {others.length > 0 && (
            <>
              <h3 className="mt-4 text-2xs font-semibold text-subtle uppercase">{t("sync.otherComputers")}</h3>
              <ul className="flex flex-col">
                {others.map((device, i) => (
                  <li key={device.id} className={i > 0 ? "ml-7 border-t border-divider" : ""}>
                    <div className={i > 0 ? "-ml-7" : ""}>
                      <DeviceRow
                        device={device}
                        highlight={device.id === reviewed}
                        action={
                          status.is_hub ? (
                            <Button variant="outline" disabled={busy} onClick={() => setOpened({ kind: "remove", device })}>
                              {t("sync.remove")}
                            </Button>
                          ) : null
                        }
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          {status.is_hub ? (
            <div className="mt-4 rounded-lg border border-dashed border-border px-3 py-2.5">
              <p className="text-sm font-medium">{t("sync.addTitle")}</p>
              <p className="mt-0.5 text-xs leading-4 text-muted">{t("sync.addHint")}</p>
            </div>
          ) : (
            <p className="mt-3 text-xs leading-4 text-muted">{t("sync.onlyMain")}</p>
          )}
          <ErrorNote text={error} />
        </div>
        {/* Long labels (Russian, German) don't fit one line of 480 px: then the buttons take a
            line of their own, right-aligned, and no label breaks. */}
        <footer className="mt-5 flex flex-wrap items-center justify-end gap-x-2 gap-y-3 border-t border-divider pt-4">
          <div className="mr-auto flex items-center gap-5">
            <button type="button" onClick={() => setOpened({ kind: "details" })} className="text-sm font-medium whitespace-nowrap text-muted hover:text-ink">
              {t("sync.details")}
            </button>
            <button type="button" disabled={busy} onClick={() => void run(api.disableSync)} className="text-sm font-medium whitespace-nowrap text-muted hover:text-ink">
              {t("sync.turnOff")}
            </button>
            <HelpLink topic="sync" label="help" look="sm" onOpen={openHelp} className="whitespace-nowrap" />
          </div>
          <div className="flex items-center gap-2">
            {!removed && (
              <Button variant="outline" size="lg" disabled={busy || status.phase.state === "syncing"} onClick={() => void run(api.syncNow)}>
                {t("sync.syncNow")}
              </Button>
            )}
            <Button ref={doneRef} variant="outline" size="lg" autoFocus onClick={onClose}>
              {t("sync.done")}
            </Button>
          </div>
        </footer>
      </div>
    </Dialog>
  );
}

/** At the bottom of a screen, under a line (sheet 46). */
function Footer({ children }: { children: ReactNode }) {
  return <footer className="mt-5 flex items-center justify-end gap-2 border-t border-divider pt-4">{children}</footer>;
}

function ErrorNote({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="mt-3 rounded-lg bg-danger-soft px-3 py-2.5 text-xs leading-[17px] text-on-danger-soft">
      {text}
    </p>
  );
}

function Spinner() {
  return <span aria-hidden className="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-line border-t-update dark:border-border dark:border-t-update" />;
}

/** The six digits both computers show, 40 px (frames 05, 06). */
function CodeBox({ code, label }: { code: string; label: string }) {
  return (
    <div
      role="group"
      aria-label={label}
      data-sync-code
      className="mt-4 flex h-[76px] items-center justify-center rounded-[10px] border border-border bg-panel text-[40px] leading-[48px] font-semibold tracking-[2px] tabular-nums"
    >
      {spacedCode(code)}
    </div>
  );
}

/** One banner of the overview (frame 11): tone, title, a line and the one thing to do about it. */
function BannerView({ banner, busy, onAction }: { banner: SyncBanner; busy: boolean; onAction: (banner: SyncBanner) => void }) {
  const tone = BANNER_CLASS[banner.tone];
  return (
    <div role="status" data-sync-banner={banner.id} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 ${tone.box}`}>
      <Icon icon={banner.tone === "warn" ? TriangleAlert : banner.tone === "ok" ? Check : RefreshCw} className={`shrink-0 self-start ${tone.icon}`} />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <span className="block text-sm leading-[18px] font-medium">{banner.title}</span>
        {banner.body && <span className="block text-xs leading-4">{banner.body}</span>}
      </span>
      {banner.action && (
        <button type="button" disabled={busy} onClick={() => onAction(banner)} className={`shrink-0 text-sm font-medium hover:underline ${tone.action}`}>
          {banner.action.label}
        </button>
      )}
    </div>
  );
}

const DEVICE_ICON = { computer: Monitor, phone: Smartphone, tablet: Tablet } as const;

/**
 * A computer: icon, name, the Main badge, its system and when it was seen («Windows · online»), its
 * dot and a visible button (no menu). Whether a computer is a laptop is not known: a monitor for all.
 */
function DeviceRow({ device, detail, action, highlight = false, name }: { device: SyncDevice; detail?: string; action?: ReactNode; highlight?: boolean; name?: ReactNode }) {
  const { t, i18n } = useTranslation();
  const dot = device.status === "pending" ? "var(--np-amber)" : device.online ? "var(--np-accent)" : "var(--np-faint)";
  return (
    <div
      data-sync-device={device.name}
      data-highlight={highlight || undefined}
      className={`flex min-h-11 items-center gap-3 rounded-md py-1.5 ${highlight ? "-mx-1 bg-accent-soft px-1" : ""}`}
    >
      <Icon icon={DEVICE_ICON[deviceKind(device.platform)]} className="shrink-0 text-icon" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          {name ?? <span className="truncate text-sm font-medium">{device.name}</span>}
          {device.is_hub && <span className="shrink-0 rounded-full bg-accent-soft px-2 py-px text-2xs font-medium text-accent">{t("sync.main")}</span>}
        </span>
        <span className="block truncate text-xs leading-4 text-muted">{detail ?? deviceDetail(device, t, i18n.language)}</span>
      </span>
      <span role="img" aria-label={device.online ? t("sync.onlineStatus") : t("sync.offlineStatus")} className="flex shrink-0">
        <Dot color={dot} />
      </span>
      {action}
    </div>
  );
}

/** This computer with «Rename…», which turns its name into a field. */
function ThisComputer({
  status,
  version,
  busy,
  removed,
  onRename,
}: {
  status: SyncStatus;
  version: string;
  busy: boolean;
  /** Removed from the account: no name to change there; «Add again» is the way back. */
  removed: boolean;
  onRename: (name: string) => Promise<SyncStatus | null>;
}) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const save = async () => {
    const name = editing?.trim();
    if (!name || name === status.device.name) {
      setEditing(null);
      return;
    }
    if (await onRename(name)) setEditing(null);
  };
  return (
    <DeviceRow
      device={status.device}
      detail={deviceDetail(status.device, t, i18n.language, { version }) || undefined}
      name={
        editing !== null ? (
          <input
            ref={input}
            autoFocus
            aria-label={t("sync.renameLabel", { name: status.device.name })}
            value={editing}
            maxLength={64}
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void save();
              } else if (e.key === "Escape") {
                // The field gives up, not the dialog.
                e.preventDefault();
                e.stopPropagation();
                setEditing(null);
              }
            }}
            className="field h-7 min-w-0 flex-1 py-0.5"
          />
        ) : undefined
      }
      action={
        removed ? null : editing !== null ? (
          <Button variant="outline" disabled={busy || !editing.trim()} onClick={() => void save()}>
            {t("sync.save")}
          </Button>
        ) : (
          <Button variant="outline" disabled={busy} onClick={() => setEditing(status.device.name)}>
            {t("sync.rename")}
          </Button>
        )
      }
    />
  );
}

/**
 * The first turn-on on this computer: its name and what the server sees. The account is asked first:
 * without a main computer this one becomes it (frame 02), with one this one joins it (frame 14).
 * Until the answer, and when it cannot come (offline, signed out), the lead says both.
 */
function SetupDialog({
  status,
  busy,
  error,
  onClose,
  onOpen,
  onTurnOn,
}: {
  status: SyncStatus;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onOpen: (url: string) => void;
  onTurnOn: (name: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(status.device.name);
  // undefined while asking; null when the account could not be asked.
  const [account, setAccount] = useState<SyncAccount | null | undefined>(status.available ? undefined : null);
  // The one failure of asking worth telling before «Turn on sync»: this app is too old for the relay.
  const [outdated, setOutdated] = useState<string | null>(null);
  useEffect(() => {
    if (!status.available) return;
    let live = true;
    api
      .getSyncAccount()
      .then((answer) => live && setAccount(answer))
      .catch((err) => {
        if (!live) return;
        setAccount(null);
        if (toCommandError(err).detail === "update_needed") setOutdated(describeError(err));
      });
    return () => {
      live = false;
    };
  }, [status.available]);
  const main = account?.main_name ?? null;
  const known = account === undefined ? "loading" : account === null ? "unknown" : main ? "join" : "main";
  // Every lead the answer may bring takes the same cell, the shown one visible: the tallest sets the
  // height, so the answer moves nothing (the dialog is centred). Until a name comes, this computer's
  // stands in for the main one's.
  const leads = [
    { key: "main", text: t("sync.setup.lead") },
    { key: "join", text: t("sync.setup.leadJoin", { name: main ?? status.device.name }) },
    { key: "unknown", text: t("sync.setup.leadNeutral") },
  ];
  const shownLead = known === "loading" ? "unknown" : known;
  return (
    <Dialog title={t("sync.title")} onClose={onClose} width={480}>
      <form
        className="flex flex-col"
        data-sync-view="setup"
        onSubmit={(e) => {
          e.preventDefault();
          onTurnOn(name.trim());
        }}
      >
        <div className="grid text-sm leading-[18px]">
          {leads.map((lead) =>
            lead.key === shownLead ? (
              <p
                key={lead.key}
                data-sync-account={known}
                aria-busy={known === "loading" || undefined}
                className={`[grid-area:1/1] transition-opacity duration-150 ${known === "loading" ? "opacity-50" : ""}`}
              >
                {lead.text}
              </p>
            ) : (
              <p key={lead.key} aria-hidden className="invisible [grid-area:1/1]">
                {lead.text}
              </p>
            ),
          )}
        </div>
        <div className="mt-4">
          <Field label={t("sync.setup.name")}>
            {(id, describedBy) => (
              <input id={id} aria-describedby={describedBy} autoFocus maxLength={64} value={name} placeholder={status.device.name} onChange={(e) => setName(e.target.value)} className="field" />
            )}
          </Field>
        </div>
        <div className="mt-4 rounded-lg bg-panel px-3 py-2.5 text-xs leading-4">
          <p className="font-medium">{t("sync.setup.privacyTitle")}</p>
          <p className="mt-1 text-muted">
            {t("sync.setup.privacyText")} <HelpLink topic="sync" onOpen={onOpen} />
          </p>
        </div>
        <ErrorNote text={error ?? outdated} />
        <Footer>
          <Button variant="outline" size="lg" type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" size="lg" type="submit" disabled={busy || !status.available || outdated !== null}>
            {t("sync.setup.turnOn")}
          </Button>
        </Footer>
      </form>
    </Dialog>
  );
}

/** «Sync details» (frame 09): what support asks about, what each other computer has, and the report to copy. */
function DetailsDialog({ status, onCopy, onClose }: { status: SyncStatus; onCopy: (text: string) => void; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const details = syncDetails(status, t, i18n.language);
  const row = (key: string, label: string, value: string) => (
    <div key={key} data-sync-detail={key} className="grid grid-cols-[150px_minmax(0,1fr)] gap-2 text-xs leading-4">
      <dt className="text-muted [overflow-wrap:anywhere]">{label}</dt>
      <dd className="font-medium [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
  return (
    <Dialog title={t("sync.detailsDialog.title")} onClose={onClose} width={480}>
      <div className="flex min-h-0 flex-col" data-sync-view="details">
        <div className="-m-1 flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto p-1">
          <dl className="flex flex-col gap-2">
            {row("state", t("sync.detailsDialog.state"), details.state)}
            {row("main", t("sync.detailsDialog.main"), details.main)}
            {row("this", t("sync.detailsDialog.this"), details.device)}
            {row("clock", t("sync.detailsDialog.clock"), details.clock)}
            {row("key", t("sync.detailsDialog.key"), details.key)}
          </dl>
          {details.computers.length > 0 && (
            <>
              <hr className="my-3 border-divider" />
              <h3 className="text-2xs font-semibold text-subtle uppercase">{t("sync.detailsDialog.computers")}</h3>
              <dl className="mt-2 flex flex-col gap-2">{details.computers.map((d) => row(`device:${d.id}`, d.name, d.value))}</dl>
            </>
          )}
          <p className="mt-3 text-xs leading-4 text-muted">{t("sync.detailsDialog.note")}</p>
          <ErrorNote text={error} />
        </div>
        <Footer>
          <Button
            variant="outline"
            size="lg"
            onClick={() =>
              void api
                .copySyncReport()
                .then(onCopy)
                .catch((err) => setError(describeError(err)))
            }
          >
            {t("sync.detailsDialog.copy")}
          </Button>
          <Button variant="outline" size="lg" autoFocus onClick={onClose}>
            {t("sync.done")}
          </Button>
        </Footer>
      </div>
    </Dialog>
  );
}

/**
 * «Start over from this computer?» (frame 13): the main computer is away. The code goes to the
 * account's email as the dialog opens; with it this computer becomes the main one.
 */
/** How long the start-over dialog waits for the relay's answer before it gives way. */
const START_OVER_WAIT_MS = 20_000;

function StartOverDialog({ status, onStatus, onClose }: { status: SyncStatus; onStatus: (status: SyncStatus) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      setEmail(await api.sendStartOverCode());
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    void send();
  }, []);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      onStatus(await api.startOver(code.replace(/\D/g, "")));
      // The relay answers later, in the status: this computer becomes the main one, or the sign-in
      // was too old (the effect below).
      setWaiting(true);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    if (status.error === "stale_sign_in") {
      setWaiting(false);
      setBusy(false);
      // The code is spent: a new one is needed.
      setCode("");
      setError(`${t("sync.problem.stale_sign_in")}. ${t("sync.problem.stale_sign_inBody")}`);
    } else if (status.is_hub) onClose();
  }, [waiting, status.error, status.is_hub, onClose, t]);
  // No answer in time (offline): the dialog gives way; the overview tells what sync is doing. The
  // timer starts once, whatever renders the status brings meanwhile.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => close.current(), START_OVER_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
  const hub = hubDevice(status);
  const hubLabel = hub?.name ?? t("sync.pair.mainComputer");
  const days = hub?.last_seen ? Math.floor((Date.now() - hub.last_seen) / 86_400_000) : 0;
  const lead =
    days >= 1
      ? t("sync.startOver.leadDays", { count: days, hub: hubLabel, name: status.device.name })
      : t("sync.startOver.lead", { hub: hubLabel, name: status.device.name });
  return (
    <Dialog title={t("sync.startOver.title")} onClose={onClose} width={480}>
      <form
        className="flex flex-col"
        data-sync-view="startOver"
        onSubmit={(e) => {
          e.preventDefault();
          void confirm();
        }}
      >
        <p className="text-sm leading-[18px]">{lead}</p>
        <div className="mt-4 rounded-lg bg-panel px-3 py-2.5 text-xs leading-4">
          <p className="font-medium">{t("sync.startOver.keepTitle")}</p>
          <p className="mt-1 text-muted">{t("sync.startOver.keepText")}</p>
        </div>
        <div className="mt-4">
          <Field label={email ? t("sync.startOver.code", { email }) : t("sync.startOver.codeSending")} hint={!email && busy ? t("sync.startOver.sending") : undefined}>
            {(id, describedBy) => (
              <input
                id={id}
                aria-describedby={describedBy}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={7}
                style={{ width: 180 }}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="field text-[15px] font-medium tracking-[2px]"
              />
            )}
          </Field>
        </div>
        <p className="mt-2 text-xs">
          <button type="button" disabled={busy} onClick={() => void send()} className="font-medium text-accent hover:underline">
            {t("sync.startOver.resend")}
          </button>
        </p>
        <ErrorNote text={error} />
        <Footer>
          <Button variant="outline" size="lg" type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" size="lg" type="submit" disabled={busy || code.replace(/\D/g, "").length < 6}>
            {t("sync.startOver.confirm")}
          </Button>
        </Footer>
      </form>
    </Dialog>
  );
}

/** The colour of a summary's dot: green synced, ochre waiting, blue under way. */
export const toneColor = (tone: SyncTone) => TONE_COLOR[tone];
