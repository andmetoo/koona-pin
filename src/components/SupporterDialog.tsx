import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, FlaskConical, Folder, Heart, RefreshCw, TriangleAlert, X } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { BackupFolder, PlanInterval, SupporterPrices, SupporterStatus } from "../types";
import { api } from "../services/api";
import { describeError, toCommandError } from "../services/errors";
import { savePreference, storedValue } from "../services/preferences";
import { copyTime } from "./BackupRestoreDialog";
import { Icon } from "./icons";
import { Button, IconButton } from "./ui/Button";
import { Field, StatePanels, Switch } from "./ui/Controls";
import { Dialog } from "./ui/Dialog";

/**
 * What a failed request says here: the details of feedback («your text is kept») do not fit, so a
 * network failure is the server that could not be reached.
 */
function failureText(error: unknown, t: TFunction): string {
  const failure = toCommandError(error);
  if (failure.detail === "too_many_messages") return t("supporter.tooManyCodes");
  if (failure.code === "network") return t("supporter.unreachable");
  return describeError(error);
}

/** How often the payment step asks whether the payment went through; only while it is open. */
export const POLL_MS = 3000;
/** Shown when Paddle's own prices cannot be had and none are remembered (Р-64: $2 a month, $20 a year). */
const FALLBACK: SupporterPrices = {
  month: { price_id: "", total: "$2", currency: "USD" },
  year: { price_id: "", total: "$20", currency: "USD" },
};
/**
 * The prices Paddle gave last time, shown at once next time: dollars turning into euros while the
 * dialog opens looks like a change of price. Kept a week, so a new price or another country's
 * currency is not shown first for long; without them the cards wait for Paddle's answer.
 */
const PRICES_KEY = "supporterPrices";
const PRICES_KEPT_MS = 7 * 86_400_000;
type RememberedPrices = { at: number; prices: SupporterPrices };
function rememberedPrices(): SupporterPrices | null {
  try {
    const kept = JSON.parse(storedValue(PRICES_KEY) ?? "null") as RememberedPrices | null;
    const fresh = kept && Date.now() - kept.at < PRICES_KEPT_MS && kept.at <= Date.now();
    return fresh && kept.prices?.month?.total && kept.prices?.year?.total ? kept.prices : null;
  } catch {
    return null;
  }
}
const rememberPrices = (prices: SupporterPrices) =>
  savePreference(PRICES_KEY, JSON.stringify({ at: Date.now(), prices } satisfies RememberedPrices));
const PERKS = ["sync", "backups", "badge", "early"] as const;
/** «$20.00» → «$20», «20,00 €» → «20 €»: whole prices without their cents, as on the page of prices. */
export const whole = (price: string) => price.replace(/([.,])00(?!\d)/, "");

type Step = "plans" | "waiting" | "thanks" | "signIn";
/** Steps where the dialog has not heard how the payment ended. */
const unanswered = (s: Step) => s === "plans" || s === "waiting";

/**
 * «Support Koona Pin» (NP-066, sheet 45): the plan → the payment in the browser → thank you, one
 * height for all three (NP-118). The payment page asks for the email and the card; the server makes
 * the account from that email and the app is signed in as soon as the payment is seen.
 */
export function SupporterDialog({
  sandbox,
  email,
  awaitingSignIn = false,
  paid = false,
  planUnknown = false,
  onClose,
  onSignIn,
}: {
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
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>(awaitingSignIn ? "signIn" : "plans");
  // The app follows a purchase by itself (billing.rs, start) and may see it before this dialog
  // asks: what it found moves the open dialog on, from the plans or the waiting step.
  useEffect(() => {
    if (awaitingSignIn) setStep((s) => (unanswered(s) ? "signIn" : s));
  }, [awaitingSignIn]);
  const paidAtOpen = useRef(paid);
  // Opened while the plan is not known yet: ask now. The notice goes when the answer comes, and a
  // plan found this way closes the dialog — there was no purchase here to thank for.
  const unknownAtOpen = useRef(planUnknown);
  const stepNow = useRef(step);
  stepNow.current = step;
  useEffect(() => {
    if (unknownAtOpen.current) void api.refreshSupporter(true).catch(() => {});
  }, []);
  useEffect(() => {
    if (!paid || paidAtOpen.current) return;
    if (unknownAtOpen.current && stepNow.current === "plans") {
      onClose();
      return;
    }
    setPaidEmail(email);
    setStep((s) => (unanswered(s) || s === "signIn" ? "thanks" : s));
  }, [paid, email]);
  const [interval, setPlan] = useState<PlanInterval>("year");
  const [prices, setPrices] = useState<SupporterPrices | null>(rememberedPrices);
  const [pricesFailed, setPricesFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkout, setCheckout] = useState<string | null>(null);
  const [paidEmail, setPaidEmail] = useState(email);

  useEffect(() => {
    let alive = true;
    api
      .getSupporterPrices()
      .then((p) => {
        rememberPrices(p);
        if (alive) setPrices(p);
      })
      .catch(() => alive && setPricesFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  // The payment step asks every few seconds; closing the dialog or leaving the step stops it. The
  // app keeps following the purchase by itself, less often (billing.rs, start), and signs in when
  // it sees the payment.
  useEffect(() => {
    if (step !== "waiting") return;
    let alive = true;
    const timer = window.setInterval(() => {
      api
        .pollCheckout()
        .then(async (state) => {
          if (!alive) return;
          if (state === "paid") {
            setPaidEmail((await api.getSupporterStatus()).email);
            setStep("thanks");
          } else if (state === "sign_in") {
            setStep("signIn");
          } else if (state === "none") {
            // The app follows the payment by itself too (billing.rs): when it was first to see it
            // paid, the purchase is gone here but the plan is already in place.
            const status = await api.getSupporterStatus();
            if (!alive) return;
            if (status.plan) {
              setPaidEmail(status.email);
              setStep("thanks");
            } else {
              setStep("plans");
            }
          }
        })
        .catch(() => {});
    }, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [step]);

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      setCheckout(await api.startCheckout(interval));
      setStep("waiting");
    } catch (err) {
      setError(failureText(err, t));
    } finally {
      setBusy(false);
    }
  };

  // Nothing remembered and no answer yet: the cards keep their room with no price in it.
  const shown = prices ?? (pricesFailed ? FALLBACK : null);
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
        {(["year", "month"] as const).map((value) => (
          <PlanCard
            key={value}
            checked={interval === value}
            onSelect={() => setPlan(value)}
            name={t(value === "year" ? "supporter.yearly" : "supporter.monthly")}
            price={
              shown ? (
                t(value === "year" ? "supporter.perYear" : "supporter.perMonth", { price: whole(shown[value].total) })
              ) : (
                // Paddle's answer on its way: a quiet bar in the line's room, no amount to swap.
                <span aria-hidden data-price-pending className="inline-block h-[1em] w-24 animate-pulse rounded bg-secondary align-middle" />
              )
            }
            badge={value === "year" ? t("supporter.twoMonthsFree") : null}
          />
        ))}
      </div>
      {failure ? (
        <p role="alert" className="mt-3 flex gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-xs leading-[17px] text-on-danger-soft">
          <Icon icon={TriangleAlert} size={14} className="mt-px shrink-0" />
          {failure}
        </p>
      ) : planUnknown && email && !sizing ? (
        // Signed in, but the plan could not be checked: a Supporter must not buy it twice.
        <p role="status" className="mt-3 flex gap-2 rounded-lg bg-amber-soft px-3 py-2.5 text-xs leading-[17px] text-on-amber-soft">
          <Icon icon={TriangleAlert} size={14} className="mt-px shrink-0" />
          {t("supporter.planUnknownNotice", { email })}
        </p>
      ) : (
        <p className="mt-3 text-xs leading-[17px] text-muted">{t("supporter.paddleHint")}</p>
      )}
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
          onClick={() => checkout && void api.openCheckout(checkout).catch((err) => setError(failureText(err, t)))}
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
    plans: t("supporter.title"),
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
          if (state === "plans") return plansPanel(sizing ? t("supporter.unreachable") : error, sizing);
          if (state === "waiting") return waitingPanel();
          if (state === "signIn") return signInPanel();
          return thanksPanel(sizing ? "someone.with.a.long.address@example.com" : paidEmail);
        }}
      </StatePanels>
    </Dialog>
  );
}

function PlanCard({
  checked,
  onSelect,
  name,
  price,
  badge,
}: {
  checked: boolean;
  onSelect: () => void;
  name: string;
  price: ReactNode;
  badge: string | null;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={`flex flex-col gap-1.5 rounded-[10px] px-3.5 py-3 text-left transition-colors duration-150 ${
        checked ? "bg-accent-soft shadow-[inset_0_0_0_1.5px_var(--np-accent)]" : "border border-border bg-card hover:bg-hover"
      }`}
    >
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className={`flex size-4 shrink-0 items-center justify-center rounded-full ${checked ? "bg-accent" : "border-[1.5px] border-faint"}`}
        >
          {checked && <span className="size-1.5 rounded-full bg-on-accent" />}
        </span>
        <span className="flex-1 text-sm font-medium whitespace-nowrap">{name}</span>
        {badge && <span className="rounded-full bg-card px-2 py-px text-2xs font-medium whitespace-nowrap text-accent">{badge}</span>}
      </span>
      <span className="pl-6 text-lg font-semibold">{price}</span>
    </button>
  );
}

type SignInStep = "email" | "code" | "noPlan";

/**
 * «Sign in as a Supporter» on another computer (sheet 45): the email of the payment, then the code
 * Supabase sends to it. Opened by «I'm already a Supporter». Signed in to an account with no active
 * plan (it ended or was cancelled), the dialog says so instead of closing as if nothing happened.
 */
export function SignInDialog({ onClose, onPlans }: { onClose: () => void; onPlans: () => void }) {
  const { t } = useTranslation();
  const [step, setStep] = useState<SignInStep>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const timer = useRef<number | null>(null);

  useEffect(() => () => void (timer.current && window.clearInterval(timer.current)), []);
  const countdown = () => {
    setWait(60);
    if (timer.current) window.clearInterval(timer.current);
    timer.current = window.setInterval(() => setWait((left) => Math.max(0, left - 1)), 1000);
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(failureText(err, t));
    } finally {
      setBusy(false);
    }
  };
  const send = () =>
    run(async () => {
      await api.sendSignInCode(email);
      setCode("");
      setStep("code");
      countdown();
    });
  // Signed in with no plan here: `unknown` when the server could not be asked about it, which is
  // not the same as «this account has none».
  const [unknown, setUnknown] = useState(false);
  const signedIn = (status: SupporterStatus) => {
    if (status.plan) {
      onClose();
      return;
    }
    setUnknown(status.plan_unknown);
    setStep("noPlan");
  };
  const verify = () => run(async () => signedIn(await api.verifySignInCode(email, code)));
  const retry = () => run(async () => signedIn(await api.refreshSupporter()));
  const signOut = () =>
    run(async () => {
      await api.signOutSupporter();
      onClose();
    });

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
        <button type="button" disabled={busy} onClick={() => void signOut()} className="mr-auto text-sm font-medium text-muted hover:text-ink">
          {t("plan.signOut")}
        </button>
        <Button variant="outline" size="lg" onClick={onClose}>
          {t("common.close")}
        </Button>
        {unknown ? (
          <Button variant="primary" size="lg" disabled={busy} onClick={() => void retry()}>
            {t("common.retry")}
          </Button>
        ) : (
          <Button variant="primary" size="lg" onClick={onPlans}>
            {t("supporter.seePlans")}
          </Button>
        )}
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
          onClick={() => {
            setError(null);
            setStep("email");
          }}
          className="font-medium text-accent hover:underline"
        >
          {t("supporter.anotherEmail")}
        </button>
      </p>
      <footer className="mt-auto flex justify-end gap-2 pt-5">
        <Button variant="outline" size="lg" type="button" onClick={() => setStep("email")}>
          {t("supporter.back")}
        </Button>
        <Button variant="primary" size="lg" type="submit" disabled={busy || code.replace(/\D/g, "").length < 6}>
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
  const choose = () => act(() => api.chooseBackupFolder(t("supporter.folder.pickerTitle")));

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
          <IconButton label={t("supporter.folder.open")} title={t("supporter.folder.open")} disabled={busy} onClick={() => void act(api.openBackupFolder)}>
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

const PERK_ICONS = { sync: RefreshCw, backups: Folder, early: FlaskConical } as const;

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
}: {
  supporter: SupporterStatus;
  /** The heart of the badge in the colour of the season; off, the row stays plain. */
  badge: boolean;
  onBadge: (shown: boolean) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plan = supporter.plan;
  const date = (iso: string) => new Date(iso).toLocaleDateString(i18n.language, { day: "numeric", month: "long", year: "numeric" });

  const run = async (action: () => Promise<unknown>, closeAfter = false) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      if (closeAfter) onClose();
    } catch (err) {
      setError(failureText(err, t));
    } finally {
      setBusy(false);
    }
  };

  // The plan as the server has it now: a change or a cancellation in the portal shows here, not
  // only in the last days of the period. Asked when the dialog opens and each time the window
  // comes back into focus, as after «Manage» (the app skips an answer seconds old); a failure says
  // nothing here, the background asks again.
  useEffect(() => {
    const recheck = () => void api.refreshSupporter(true).catch(() => {});
    recheck();
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, []);

  let status: string;
  let tone: "muted" | "danger" | "amber" = "muted";
  let action = (
    <Button variant="outline" size="lg" disabled={busy} onClick={() => void run(api.openSupporterPortal)}>
      {t("plan.manage")} ↗
    </Button>
  );
  if (!plan) {
    status = "";
  } else if (supporter.check_failed) {
    // Until when the signed plan is kept without the server (billing.rs, `offline_until`).
    status = t("supporter.unchecked", { date: date(plan.offline_until) });
    tone = "amber";
    action = (
      <Button variant="primary" size="lg" disabled={busy} onClick={() => void run(() => api.refreshSupporter())}>
        {t("common.retry")}
      </Button>
    );
  } else if (plan.status === "past_due") {
    status = t("supporter.pastDue");
    tone = "danger";
    action = (
      <Button variant="primary" size="lg" disabled={busy} onClick={() => void run(api.openSupporterPortal)}>
        {t("plan.updateCard")} ↗
      </Button>
    );
  } else if (plan.status === "canceling") {
    status = t("supporter.endsOn", { date: date(plan.valid_until) });
  } else {
    status = plan.renews_at ? t("supporter.renewsOn", { date: date(plan.renews_at) }) : "";
  }
  const toneClass = { muted: "text-muted", danger: "font-medium text-danger", amber: "font-medium text-amber" }[tone];

  return (
    <Dialog title="Supporter" onClose={onClose} width={480}>
      <div className="flex flex-col" data-plan-dialog={plan ? (supporter.check_failed ? "unchecked" : plan.status) : "none"}>
        <div className="flex items-center gap-3.5">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-season-soft text-season">
            <Heart size={20} fill="currentColor" aria-hidden />
          </span>
          <div className="min-w-0 text-xs leading-[17px]">
            <p className="text-[15px] leading-5 font-semibold text-ink">{t(plan?.interval === "month" ? "plan.monthly" : "plan.yearly")}</p>
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
          {(["sync", "backups", "badge", "early"] as const).map((perk) => {
            const PerkIcon = perk === "badge" ? null : PERK_ICONS[perk];
            return (
              <li key={perk} className="flex items-center gap-3">
                <span className={`flex shrink-0 self-start pt-0.5 ${perk === "badge" ? "text-season" : "text-icon"}`}>
                  {PerkIcon ? <Icon icon={PerkIcon} /> : <Heart size={16} strokeWidth={1.5} fill="currentColor" aria-hidden />}
                </span>
                {perk === "backups" && plan ? (
                  <FolderRow onError={setError} />
                ) : (
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{t(`supporter.perk.${perk}`)}</span>
                    <span className="block text-xs leading-[17px] text-muted">{t(`supporter.perk.${perk}Hint`)}</span>
                  </span>
                )}
                {perk === "backups" && plan ? null : perk === "badge" ? (
                  <Switch label={t("supporter.perk.badge")} checked={badge} onChange={onBadge} />
                ) : (
                  <span className="shrink-0 rounded-full bg-secondary px-2.5 py-0.5 text-2xs font-medium text-subtle">{t("supporter.soon")}</span>
                )}
              </li>
            );
          })}
        </ul>
        <footer className="mt-6 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(api.signOutSupporter, true)}
            className="mr-auto text-sm font-medium text-muted hover:text-ink"
          >
            {t("plan.signOut")}
          </button>
          {action}
        </footer>
      </div>
    </Dialog>
  );
}
