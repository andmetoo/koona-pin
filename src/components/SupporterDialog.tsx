import { useEffect, useState, type ReactNode } from "react";
import { BookOpen, Check, Folder, Heart, RefreshCw, TriangleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BackupFolder, Plan, SupporterStatus, SyncStatus } from "../types";
import { api, desktopOnly } from "../services/api";
import { capabilities } from "../platform/capabilities";
import { copyTime } from "./BackupRestoreDialog";
import { SyncPerkRow } from "./commercial/SyncRows";
import { Icon } from "./icons";
import {
  failureText,
  FALLBACK,
  fiveYearsAfter,
  longDate,
  planBadge,
  planName,
  priceLine,
  useSignIn,
  usePlan,
  useSupporterPurchase,
  whole,
} from "./supporterFlow";
import { Button, IconButton } from "./ui/Button";
import { Field, StatePanels, Switch } from "./ui/Controls";
import { Dialog } from "./ui/Dialog";

export { POLL_MS, whole } from "./supporterFlow";

/** What Supporter gives; «reading» is the themes and fonts of the Aa panel (NP-124). */
const PERKS = ["sync", "backups", "reading", "badge"] as const;
/**
 * «Support Koona Pin» (NP-066, sheet 45): the plan → the payment in the browser → thank you, one
 * height for all three (NP-118). The payment page asks for the email and the card; the server makes
 * the account from that email and the app is signed in as soon as the payment is seen.
 *
 * With `upgrade`, a subscription's «Switch to 5 years»: only the five years, which start when its
 * paid period ends; the server then cancels the subscription at that end.
 */
export function SupporterDialog({
  sandbox,
  email,
  awaitingSignIn = false,
  paid = false,
  planUnknown = false,
  upgrade,
  onClose,
  onSignIn,
  onDelete,
}: {
  /** Signed in without a plan: «Delete account…» on the account's line. */
  onDelete?: () => void;
  /** The subscription being switched to five years. */
  upgrade?: Plan;
  sandbox: boolean;
  email: string | null;
  /** A payment here went through for an existing account: open on «Payment received». */
  awaitingSignIn?: boolean;
  /** Signed in, and the plan could not be checked yet (`plan_unknown`): the plans warn first. */
  planUnknown?: boolean;
  /** This computer has the plan: when it arrives while the dialog is open, the dialog thanks. */
  paid?: boolean;
  onClose: () => void;
  /** «I'm already a Supporter»: the sign-in dialog instead of this one. */
  onSignIn: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { step, interval, setPlan, shown, plans, pay, openAgain, busy, error, checkout, paidEmail } = useSupporterPurchase({
    email,
    awaitingSignIn,
    paid,
    planUnknown,
    upgrade,
    onClose,
  });
  const plansPanel = (failure: string | null, sizing: boolean) => (
    <div className="flex flex-1 flex-col">
      <p className="text-sm text-muted">{t("supporter.intro")}</p>
      <ul className="mt-2.5 flex flex-col gap-1.5 text-sm">
        {PERKS.map((perk) => (
          <li key={perk} className="flex items-start gap-2">
            <Icon icon={Check} className="mt-px shrink-0 text-accent" />
            {t(`supporter.perks.${perk}`)}
          </li>
        ))}
      </ul>
      <div
        role="radiogroup"
        aria-label={sizing ? undefined : t("supporter.plan")}
        aria-busy={!shown || undefined}
        className="mt-5 grid grid-cols-2 gap-3"
      >
        {plans.map((value) => {
          const price = shown?.[value];
          return (
            <PlanCard
              key={value}
              wide={value === "five_years"}
              checked={interval === value}
              onSelect={() => setPlan(value)}
              name={planName(value, t)}
              price={price ? priceLine(value, price.total, t) : <PricePending />}
              badge={planBadge(value, t)}
            />
          );
        })}
      </div>
      {failure ? (
        <FailureNote text={failure} />
      ) : planUnknown && email && !sizing ? (
        // Signed in, but the plan could not be checked: a Supporter must not buy it twice.
        <p role="status" className="mt-3 flex gap-2 rounded-lg bg-amber-soft px-3 py-2.5 text-xs leading-[17px] text-on-amber-soft">
          <Icon icon={TriangleAlert} size={14} className="mt-px shrink-0" />
          {t("supporter.planUnknownNotice", { email })}
        </p>
      ) : email && onDelete && !sizing ? (
        // Signed in without a plan: the account, and deleting it, quietly (as the plan's D1), in the
        // hint's place, so the dialog keeps its one height.
        <p className="mt-3 flex min-w-0 items-center gap-1.5 text-xs leading-[17px] text-muted" data-account-line>
          <span className="truncate" title={email}>
            {t("deleteAccount.signedInAs", { email })}
          </span>
          <span aria-hidden>·</span>
          <button type="button" onClick={onDelete} className="shrink-0 font-medium hover:text-ink">
            {t("deleteAccount.open")}
          </button>
        </p>
      ) : (
        <p className="mt-3 text-xs leading-[17px] text-muted">{t("supporter.paddleHint")}</p>
      )}
      {/* pt-5: the line of reading themes (NP-124) took the 24 px kept for the perk line that went in
          early builds, so this step, the tallest, keeps the one height of the purchase flow (NP-118). */}
      <footer className="mt-auto flex items-center justify-end gap-2 pt-5">
        {/* Paid on another computer: the email of the payment and its code (sheet 45). */}
        <button type="button" onClick={onSignIn} className="mr-auto text-sm font-medium text-accent hover:underline">
          {t("plan.already")}
        </button>
        <Button variant="outline" size="lg" onClick={onClose}>
          {t("supporter.notNow")}
        </Button>
        <Button variant="primary" size="lg" autoFocus disabled={busy} onClick={() => void pay()}>
          {failure ? t("common.retry") : t("supporter.continue")}
        </Button>
      </footer>
    </div>
  );

  // «Switch to 5 years» (sheet 45): the five years and when they start and end, nothing to choose.
  // The amount waits for Paddle's answer, in the text too: no dollars turning into euros.
  const upgradePanel = (plan: Plan, failure: string | null, sizing: boolean) => {
    const price = shown?.five_years;
    // Paddle answered and the server does not sell them (the button is not offered then either).
    const notSold = !!shown && !price;
    return (
      <div className="flex flex-1 flex-col">
        <p className="text-sm text-muted">
          {price || sizing ? (
            t(plan.interval === "month" ? "supporter.upgradeTextMonthly" : "supporter.upgradeTextYearly", {
              date: longDate(plan.valid_until, i18n.language),
              price: whole((price ?? FALLBACK.five_years!).total),
            })
          ) : (
            <span aria-hidden data-price-pending className="block h-9 animate-pulse rounded bg-secondary" />
          )}
        </p>
        <div className="mt-4">
          <PlanCard checked wide name={t("supporter.fiveYears")} price={price ? priceLine("five_years", price.total, t) : <PricePending />} badge={t("supporter.save50")} />
        </div>
        {failure ? (
          <FailureNote text={failure} />
        ) : notSold && !sizing ? (
          // Not a failure: nothing went wrong and the subscription goes on, so a notice, not an alert.
          <p role="status" className="mt-3 flex gap-2 rounded-lg bg-amber-soft px-3 py-2.5 text-xs leading-[17px] text-on-amber-soft">
            <Icon icon={TriangleAlert} size={14} className="mt-px shrink-0" />
            {t("supporter.fiveYearsNotSold")}
          </p>
        ) : (
          <p className="mt-3 text-xs leading-[17px] text-muted">
            {t("supporter.upgradeHint", { date: longDate(fiveYearsAfter(plan.valid_until), i18n.language) })}
          </p>
        )}
        <footer className="mt-auto flex items-center justify-end gap-2 pt-5">
          <Button variant="outline" size="lg" onClick={onClose}>
            {t("supporter.notNow")}
          </Button>
          <Button variant="primary" size="lg" autoFocus disabled={busy || notSold} onClick={() => void pay()}>
            {failure ? t("common.retry") : t("supporter.continue")}
          </Button>
        </footer>
      </div>
    );
  };

  const waitingPanel = () => (
    <div className="flex flex-1 flex-col">
      <p className="text-sm text-muted">{t("supporter.waitingText")}</p>
      <div className="mt-4 flex items-center gap-2.5 rounded-lg bg-secondary px-4 py-3 text-sm">
        <span aria-hidden className="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-line border-t-accent dark:border-border dark:border-t-accent" />
        <span role="status" className="flex-1">
          {t("supporter.waiting")}
        </span>
        <button
          type="button"
          disabled={!checkout}
          onClick={openAgain}
          className="font-medium text-accent hover:underline"
        >
          {t("supporter.openAgain")} ↗
        </button>
      </div>
      <footer className="mt-auto flex justify-end gap-2 pt-5">
        <Button variant="outline" size="lg" autoFocus onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </footer>
    </div>
  );

  const thanksPanel = (who: string | null) => (
    <div className="flex flex-1 flex-col items-center text-center">
      <span className="mt-2 flex size-14 items-center justify-center rounded-full bg-season-soft text-season">
        <Heart size={24} fill="currentColor" aria-hidden />
      </span>
      <p className="mt-4 max-w-[400px] text-sm text-muted">{t("supporter.thanksText", { email: who ?? "" })}</p>
      <footer className="mt-auto flex w-full justify-end gap-2 pt-5">
        <Button variant="primary" size="lg" autoFocus onClick={onClose}>
          {t("supporter.done")}
        </Button>
      </footer>
    </div>
  );

  // Paid with the email of an account that existed before: the purchase never signs it in by
  // itself, the code from that email does (koona-services, billing_fill_claim).
  const signInPanel = () => (
    <div className="flex flex-1 flex-col items-center text-center">
      <span className="mt-2 flex size-14 items-center justify-center rounded-full bg-season-soft text-season">
        <Heart size={24} fill="currentColor" aria-hidden />
      </span>
      <p className="mt-4 max-w-[400px] text-sm text-muted">{t("supporter.paidSignInText")}</p>
      <footer className="mt-auto flex w-full justify-end gap-2 pt-5">
        <Button variant="outline" size="lg" onClick={onClose}>
          {t("supporter.notNow")}
        </Button>
        <Button variant="primary" size="lg" autoFocus onClick={onSignIn}>
          {t("supporter.signIn")}
        </Button>
      </footer>
    </div>
  );

  const title = {
    plans: upgrade ? t("supporter.upgradeTitle") : t("supporter.title"),
    waiting: t("supporter.waitingTitle"),
    thanks: t("supporter.thanksTitle"),
    signIn: t("supporter.paidTitle"),
  }[step];
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={480}
      badge={
        sandbox && step === "plans" ? (
          <span className="rounded-full bg-amber-soft px-2 py-px text-2xs font-medium text-on-amber-soft">{t("supporter.testPayments")}</span>
        ) : null
      }
    >
      <StatePanels value={step} states={["plans", "waiting", "thanks", "signIn"] as const}>
        {(state, sizing) => {
          if (state === "plans" && upgrade) return upgradePanel(upgrade, sizing ? t("supporter.unreachable") : error, sizing);
          if (state === "plans") return plansPanel(sizing ? t("supporter.unreachable") : error, sizing);
          if (state === "waiting") return waitingPanel();
          if (state === "signIn") return signInPanel();
          return thanksPanel(sizing ? "someone.with.a.long.address@example.com" : paidEmail);
        }}
      </StatePanels>
    </Dialog>
  );
}

/** Paddle's answer on its way: a quiet bar in the line's room, no amount to swap. */
function PricePending() {
  return <span aria-hidden data-price-pending className="inline-block h-[1em] w-24 animate-pulse rounded bg-secondary align-middle" />;
}

function FailureNote({ text }: { text: string }) {
  return (
    <p role="alert" className="mt-3 flex gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-xs leading-[17px] text-on-danger-soft">
      <Icon icon={TriangleAlert} size={14} className="mt-px shrink-0" />
      {text}
    </p>
  );
}

/** A plan to choose; without `onSelect`, the one plan of a step, shown chosen and with no radio. */
function PlanCard({
  checked,
  onSelect,
  name,
  price,
  badge,
  wide = false,
}: {
  checked: boolean;
  onSelect?: () => void;
  name: string;
  price: ReactNode;
  badge: string | null;
  /** Across both columns: Supporter · 5 years under the two subscriptions. */
  wide?: boolean;
}) {
  const className = `flex flex-col gap-1.5 rounded-[10px] px-3.5 py-3 text-left transition-colors duration-150 ${wide ? "col-span-2" : ""} ${
    checked ? "bg-accent-soft shadow-[inset_0_0_0_1.5px_var(--np-accent)]" : "border border-border bg-card hover:bg-hover"
  }`;
  const content = (
    <>
      <span className="flex items-center gap-2">
        {onSelect && (
          <span
            aria-hidden
            className={`flex size-4 shrink-0 items-center justify-center rounded-full ${checked ? "bg-accent" : "border-[1.5px] border-faint"}`}
          >
            {checked && <span className="size-1.5 rounded-full bg-on-accent" />}
          </span>
        )}
        <span className="flex-1 text-sm font-medium whitespace-nowrap">{name}</span>
        {/* The wide card not chosen gives its badge a tint (sheet 45): on bg-card a bg-card pill vanishes. */}
        {badge && (
          <span className={`rounded-full px-2 py-px text-2xs font-medium whitespace-nowrap text-accent ${wide && !checked ? "bg-accent-soft" : "bg-card"}`}>
            {badge}
          </span>
        )}
      </span>
      <span className={`${onSelect ? "pl-6" : ""} text-lg font-semibold`}>{price}</span>
    </>
  );
  if (!onSelect) return <div className={className}>{content}</div>;
  return (
    <button type="button" role="radio" aria-checked={checked} onClick={onSelect} className={className}>
      {content}
    </button>
  );
}

/**
 * «Sign in as a Supporter» on another computer (sheet 45): the email of the payment, then the code
 * Supabase sends to it. Opened by «I'm already a Supporter». Signed in to an account with no active
 * plan (it ended or was cancelled), the dialog says so instead of closing as if nothing happened;
 * «See plans» there only where the build sells Supporter.
 */
export function SignInDialog({ onClose, onPlans, onDelete }: { onClose: () => void; onPlans: () => void; onDelete?: () => void }) {
  const { t } = useTranslation();
  const { step, setStep, email, setEmail, code, setCode, error, busy, wait, send, verify, retry, signOut, anotherEmail, unknown, codeReady } = useSignIn({ onClose });

  const noPlanPanel = (failure: string | null, sizing: boolean) => (
    <div className="flex flex-1 flex-col">
      <p className="text-sm text-muted">
        {t(sizing || unknown ? "supporter.planUnknownText" : "supporter.noPlanText", { email: sizing ? "" : email.trim() })}
      </p>
      {failure && (
        <p role={sizing ? undefined : "alert"} className="mt-3 text-xs leading-[17px] font-medium text-danger">
          {failure}
        </p>
      )}
      <footer className="mt-auto flex items-center justify-end gap-2 pt-5">
        <span className="mr-auto flex items-center gap-3">
          <button type="button" disabled={busy} onClick={() => void signOut()} className="text-sm font-medium text-muted hover:text-ink">
            {t("plan.signOut")}
          </button>
          {onDelete && !sizing && (
            <button type="button" disabled={busy} onClick={onDelete} className="text-sm font-medium text-muted hover:text-ink">
              {t("deleteAccount.open")}
            </button>
          )}
        </span>
        <Button variant="outline" size="lg" onClick={onClose}>
          {t("common.close")}
        </Button>
        {unknown ? (
          <Button variant="primary" size="lg" disabled={busy} onClick={() => void retry()}>
            {t("common.retry")}
          </Button>
        ) : capabilities.purchase === "paddle" ? (
          <Button variant="primary" size="lg" onClick={onPlans}>
            {t("supporter.seePlans")}
          </Button>
        ) : null}
      </footer>
    </div>
  );

  const emailPanel = (failure: string | null, sizing: boolean) => (
    <form
      className="flex flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <p className="text-sm text-muted">{t("supporter.signInText")}</p>
      <div className="mt-4">
        {sizing ? (
          <SizingField label={t("supporter.email")} note={failure} />
        ) : (
        <Field label={t("supporter.email")} error={failure ?? undefined}>
          {(id, describedBy) => (
            <input
              id={id}
              aria-describedby={describedBy}
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="field"
            />
          )}
        </Field>
        )}
      </div>
      <footer className="mt-auto flex justify-end gap-2 pt-5">
        <Button variant="outline" size="lg" type="button" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" size="lg" type="submit" disabled={busy || !email.trim()}>
          {t("supporter.sendCode")}
        </Button>
      </footer>
    </form>
  );

  const codePanel = (failure: string | null, sizing: boolean) => (
    <form
      className="flex flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void verify();
      }}
    >
      <p className="text-sm text-muted">{t("supporter.codeText", { email })}</p>
      <div className="mt-4">
        {sizing ? (
          <SizingField label={t("supporter.code")} note={failure} />
        ) : (
        <Field label={t("supporter.code")} error={failure ?? undefined}>
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
              className={`field text-[15px] font-medium tracking-[2px] ${failure ? "border-danger" : ""}`}
            />
          )}
        </Field>
        )}
      </div>
      <p className="mt-3 flex gap-2 text-sm">
        {wait > 0 ? (
          <span className="text-subtle">{t("supporter.sendAgainIn", { time: `0:${String(wait).padStart(2, "0")}` })}</span>
        ) : (
          <button type="button" disabled={busy} onClick={() => void send()} className="font-medium text-accent hover:underline">
            {t("supporter.sendAgain")}
          </button>
        )}
        <span aria-hidden className="text-subtle">
          ·
        </span>
        <button
          type="button"
          onClick={anotherEmail}
          className="font-medium text-accent hover:underline"
        >
          {t("supporter.anotherEmail")}
        </button>
      </p>
      <footer className="mt-auto flex justify-end gap-2 pt-5">
        <Button variant="outline" size="lg" type="button" onClick={() => setStep("email")}>
          {t("supporter.back")}
        </Button>
        <Button variant="primary" size="lg" type="submit" disabled={busy || !codeReady}>
          {t("supporter.signIn")}
        </Button>
      </footer>
    </form>
  );

  return (
    <Dialog
      title={t(step === "email" ? "supporter.signInTitle" : step === "code" ? "supporter.codeTitle" : "supporter.signedInTitle")}
      onClose={onClose}
      width={480}
    >
      <StatePanels value={step} states={["email", "code", "noPlan"] as const}>
        {(state, sizing) =>
          state === "email"
            ? emailPanel(sizing ? t("errors.detail.not_supporter") : error, sizing)
            : state === "code"
              ? codePanel(sizing ? t("errors.detail.wrong_code") : error, sizing)
              : noPlanPanel(sizing ? t("supporter.unreachable") : error, sizing)
        }
      </StatePanels>
    </Dialog>
  );
}

/** A field's room in the unseen sizing copy: no label element, no input, so tests find one field. */
function SizingField({ label, note }: { label: string; note: string | null }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium">{label}</p>
      <div className="field">&nbsp;</div>
      {note && <p className="text-xs">{note}</p>}
    </div>
  );
}
/**
 * The backups perk with its folder (sheet 45, frames «копии в папку»): not chosen yet, chosen with
 * its last copy, or chosen but out of reach. The full path is in the hint of the line.
 */
function FolderRow({ onError }: { onError: (text: string | null) => void }) {
  const { t, i18n } = useTranslation();
  const [folder, setFolder] = useState<BackupFolder | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void api.getBackupFolder().then((current) => alive && setFolder(current), () => {});
    const off = api.onBackupFolder(setFolder);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const act = async (action: () => Promise<BackupFolder | void>) => {
    setBusy(true);
    onError(null);
    try {
      const next = await action();
      if (next) setFolder(next);
    } catch (err) {
      onError(failureText(err, t));
    } finally {
      setBusy(false);
    }
  };
  const choose = () => act(() => desktopOnly().chooseBackupFolder(t("supporter.folder.pickerTitle")));

  const path = folder?.path ?? null;
  let line;
  if (!folder || !path) {
    line = <span className="block text-xs leading-[17px] text-muted">{t("supporter.folder.hint")}</span>;
  } else if (folder?.unreachable) {
    line = (
      <span role="status" title={path} className="block truncate text-xs leading-[17px] font-medium text-danger">
        {t("supporter.folder.unreachable", { path })}
      </span>
    );
  } else {
    const when = folder?.last_copy_at
      ? t("supporter.folder.last", { when: copyTime(folder.last_copy_at, t, i18n.language, true) })
      : t("supporter.folder.none");
    line = (
      <span title={path} className="flex text-xs leading-[17px] text-muted">
        <span className="truncate">{path}</span>
        <span className="shrink-0 whitespace-pre"> · {when}</span>
      </span>
    );
  }

  return (
    <>
      <span
        className="min-w-0 flex-1"
        data-backup-folder={!folder ? "loading" : !path ? "none" : folder.unreachable ? "unreachable" : "chosen"}
      >
        <span className="block text-sm font-medium">{t("supporter.perk.backups")}</span>
        {line}
      </span>
      {/* No control until the folder is known: a chosen one must not look unset for a moment. */}
      {!folder ? null : !path ? (
        <Button variant="outline" disabled={busy} onClick={() => void choose()}>
          {t("supporter.folder.choose")}
        </Button>
      ) : folder?.unreachable ? (
        <Button variant="outline" disabled={busy} onClick={() => void choose()}>
          {t("supporter.folder.chooseAgain")}
        </Button>
      ) : (
        <span className="flex shrink-0 items-center gap-1">
          <IconButton label={t("supporter.folder.open")} title={t("supporter.folder.open")} disabled={busy} onClick={() => void act(() => desktopOnly().openBackupFolder())}>
            <Icon icon={Folder} />
          </IconButton>
          <Button variant="outline" disabled={busy} onClick={() => void choose()}>
            {t("supporter.folder.change")}
          </Button>
          <IconButton label={t("supporter.folder.stop")} title={t("supporter.folder.stop")} disabled={busy} onClick={() => void act(api.stopBackupFolder)}>
            <Icon icon={X} />
          </IconButton>
        </span>
      )}
    </>
  );
}

const PERK_ICONS = { sync: RefreshCw, backups: Folder, reading: BookOpen } as const;

/**
 * «Supporter» (NP-066, sheet 45), opened by the badge in the sidebar: the plan, its state on one
 * line under the email, and the perks with their own controls — apart from the general settings. One
 * height in every state: a renewal, no renewal, a failed payment, a plan that could not be checked.
 */
export function PlanDialog({
  supporter,
  badge,
  onBadge,
  onClose,
  onUpgrade,
  onDelete,
  sync,
  onSync,
}: {
  supporter: SupporterStatus;
  /** Sync between the Supporter's computers: its row in place of «Soon» (sheet 46). */
  sync: SyncStatus | null;
  /** «Set up…» and «Manage…»: the Sync dialog instead of this one. */
  onSync: () => void;
  /** The heart of the badge in the colour of the season; off, the row stays plain. */
  badge: boolean;
  onBadge: (shown: boolean) => void;
  onClose: () => void;
  /** «Switch to 5 years», offered while a subscription renews. */
  onUpgrade?: () => void;
  /** «Delete account…»: its dialog instead of this one. */
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const { status, tone, action: kind, busy, error, setError, offerSwitch, act, signOut } = usePlan({ supporter, onClose, onUpgrade });
  const plan = supporter.plan;
  let action =
    kind === "retry" ? (
      <Button variant="primary" size="lg" disabled={busy} onClick={() => act(kind)}>
        {t("common.retry")}
      </Button>
    ) : kind === "updateCard" ? (
      <Button variant="primary" size="lg" disabled={busy} onClick={() => act(kind)}>
        {t("plan.updateCard")} ↗
      </Button>
    ) : kind === "fixInPlay" ? (
      // A plan paid through Google Play (NP-154): its payment and its management are Google Play's.
      <Button variant="primary" size="lg" disabled={busy} onClick={() => act(kind)}>
        {t("plan.fixInPlay")} ↗
      </Button>
    ) : kind === "manageInPlay" ? (
      <Button variant="outline" size="lg" disabled={busy} onClick={() => act(kind)}>
        {t("plan.manageInPlay")} ↗
      </Button>
    ) : kind === "close" ? (
      <Button variant="outline" size="lg" onClick={onClose}>
        {t("common.close")}
      </Button>
    ) : (
      <Button variant="outline" size="lg" disabled={busy} onClick={() => act(kind)}>
        {t("plan.manage")} ↗
      </Button>
    );
  // A subscription that renews can become five years paid once, from the end of its period.
  if (offerSwitch && kind === "manage")
    action = (
      <>
        <Button variant="outline" size="lg" onClick={offerSwitch}>
          {t("plan.switchToFiveYears")}
        </Button>
        {action}
      </>
    );
  const toneClass = { muted: "text-muted", danger: "font-medium text-danger", amber: "font-medium text-amber" }[tone];

  return (
    <Dialog title="Supporter" onClose={onClose} width={480}>
      <div className="flex flex-col" data-plan-dialog={plan ? (supporter.check_failed ? "unchecked" : plan.status) : "none"}>
        <div className="flex items-center gap-3.5">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-season-soft text-season">
            <Heart size={20} fill="currentColor" aria-hidden />
          </span>
          <div className="min-w-0 text-xs leading-[17px]">
            <p className="text-[15px] leading-5 font-semibold text-ink">{t(plan?.interval === "five_years" ? "plan.fiveYears" : plan?.interval === "month" ? "plan.monthly" : "plan.yearly")}</p>
            <p className="truncate text-muted">{supporter.email}</p>
            {/* The state of the plan always takes this one line, so the dialog keeps its height. */}
            <p role={tone === "muted" ? undefined : "status"} className={`min-h-[17px] ${toneClass}`}>
              {error ?? status}
            </p>
          </div>
        </div>
        <hr className="my-4 border-divider" />
        <h3 className="text-2xs font-semibold text-subtle uppercase">{t("supporter.perksTitle")}</h3>
        <ul className="mt-2.5 flex flex-col gap-4">
          {PERKS.map((perk) => {
            const PerkIcon = perk === "badge" ? null : PERK_ICONS[perk];
            return (
              <li key={perk} className="flex items-center gap-3">
                <span className={`flex shrink-0 self-start pt-0.5 ${perk === "badge" ? "text-season" : "text-icon"}`}>
                  {PerkIcon ? <Icon icon={PerkIcon} /> : <Heart size={16} strokeWidth={1.5} fill="currentColor" aria-hidden />}
                </span>
                {/* The folder picker is a desktop's (NP-151): a phone shows the perk as text. */}
                {perk === "backups" && plan && capabilities.folder_picker ? (
                  <FolderRow onError={setError} />
                ) : perk === "sync" ? (
                  <SyncPerkRow status={sync} onOpen={onSync} />
                ) : (
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{t(`supporter.perk.${perk}`)}</span>
                    <span className="block text-xs leading-[17px] text-muted">{t(`supporter.perk.${perk}Hint`)}</span>
                  </span>
                )}
                {(perk === "backups" && plan) || perk === "sync" || perk === "reading" ? null : perk === "badge" ? (
                  <Switch label={t("supporter.perk.badge")} checked={badge} onChange={onBadge} />
                ) : (
                  <span className="shrink-0 rounded-full bg-secondary px-2.5 py-0.5 text-2xs font-medium text-subtle">{t("supporter.soon")}</span>
                )}
              </li>
            );
          })}
        </ul>
        <footer className="mt-6 flex items-center justify-end gap-2">
          <span className="mr-auto flex items-center gap-3">
            <button type="button" disabled={busy} onClick={signOut} className="text-sm font-medium text-muted hover:text-ink">
              {t("plan.signOut")}
            </button>
            {onDelete && (
              <button type="button" disabled={busy} onClick={onDelete} className="text-sm font-medium text-muted hover:text-ink">
                {t("deleteAccount.open")}
              </button>
            )}
          </span>
          {action}
        </footer>
      </div>
    </Dialog>
  );
}
