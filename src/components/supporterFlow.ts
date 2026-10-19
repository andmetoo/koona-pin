import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { Plan, PlanInterval, SupporterPrices, SupporterStatus } from "../types";
import { api } from "../services/api";
import { capabilities } from "../platform/capabilities";
import { describeError, toCommandError } from "../services/errors";
import { savePreference, storedValue } from "../services/preferences";

// What Supporter's dialogs do, apart from how they look (NP-066, sheet 45): the purchase and its
// steps, the sign-in with the email code, the plan's state. The desktop's dialogs
// (./SupporterDialog.tsx) and the phone's sheets (src/shell/phone/supporter, NP-072b) draw them.

/**
 * What a failed request says here: the details of feedback («your text is kept») do not fit, so a
 * network failure is the server that could not be reached.
 */
export function failureText(error: unknown, t: TFunction): string {
  const failure = toCommandError(error);
  if (failure.detail === "too_many_messages") return t("supporter.tooManyCodes");
  if (failure.code === "network") return t("supporter.unreachable");
  return describeError(error);
}

/** How often the payment step asks whether the payment went through; only while it is open. */
export const POLL_MS = 3000;
/**
 * Shown when Paddle's own prices cannot be had and none are remembered (Р-64: $2 a month, $20 a
 * year; $50 once for 5 years).
 */
export const FALLBACK: SupporterPrices = {
  month: { price_id: "", total: "$2", currency: "USD" },
  year: { price_id: "", total: "$20", currency: "USD" },
  five_years: { price_id: "", total: "$50", currency: "USD" },
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
    // Kept by 0.10, before five years were sold, the prices say nothing about them (no key, not
    // null): forgotten, or their card would appear only once Paddle answers.
    const complete = kept?.prices?.month?.total && kept.prices.year?.total && "five_years" in kept.prices;
    return fresh && complete ? kept.prices : null;
  } catch {
    return null;
  }
}
const rememberPrices = (prices: SupporterPrices) =>
  savePreference(PRICES_KEY, JSON.stringify({ at: Date.now(), prices } satisfies RememberedPrices));

/**
 * Supporter's prices: the ones remembered at once, then Paddle's answer, remembered for next time.
 * `ask` «if_unknown» keeps the remembered ones without asking (a dialog that only needs to know
 * what is sold), and asks only without any; «never» does not ask at all.
 */
export function useSupporterPrices(ask: "always" | "if_unknown" | "never" = "always") {
  const [prices, setPrices] = useState<SupporterPrices | null>(rememberedPrices);
  const [failed, setFailed] = useState(false);
  const needed = ask === "always" || (ask === "if_unknown" && prices === null);
  useEffect(() => {
    if (!needed) return;
    let alive = true;
    api
      .getSupporterPrices()
      .then((p) => {
        rememberPrices(p);
        if (alive) setPrices(p);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
    // Asked once per dialog: what it shows does not depend on later renders.
  }, []);
  return { prices, failed };
}

/** «$20.00» → «$20», «20,00 €» → «20 €»: whole prices without their cents, as on the page of prices. */
export const whole = (price: string) => price.replace(/([.,])00(?!\d)/, "");

/** A date as the dialogs write it: «October 11, 2027». */
export const longDate = (iso: string, language: string) => new Date(iso).toLocaleDateString(language, { day: "numeric", month: "long", year: "numeric" });

/** Five years after a date, as the server counts them (koona-services `upgrade`). */
export function fiveYearsAfter(iso: string): string {
  const date = new Date(iso);
  date.setUTCFullYear(date.getUTCFullYear() + 5);
  return date.toISOString();
}

/** A plan's price as its card says it: «$20 a year», «$2 a month», «$50 once». */
export const priceLine = (value: PlanInterval, price: string, t: TFunction) =>
  t(value === "year" ? "supporter.perYear" : value === "month" ? "supporter.perMonth" : "supporter.once", { price: whole(price) });
export const planName = (value: PlanInterval, t: TFunction) =>
  t(value === "year" ? "supporter.yearly" : value === "month" ? "supporter.monthly" : "supporter.fiveYears");
export const planBadge = (value: PlanInterval, t: TFunction) =>
  value === "year" ? t("supporter.twoMonthsFree") : value === "five_years" ? t("supporter.save50") : null;

export type PurchaseStep = "plans" | "waiting" | "thanks" | "signIn";
/** Steps where the dialog has not heard how the payment ended. */
const unanswered = (s: PurchaseStep) => s === "plans" || s === "waiting";

/**
 * The purchase (sheet 45): the plan → the payment in the browser → thank you, or «Payment received»
 * with a sign-in when the email of the payment already had an account. The payment page asks for the
 * email and the card; the server makes the account from that email and the app is signed in as soon
 * as the payment is seen. With `upgrade`, a subscription's «Switch to 5 years»: only the five years.
 */
export function useSupporterPurchase({
  email,
  awaitingSignIn = false,
  paid = false,
  planUnknown = false,
  upgrade,
  onClose,
}: {
  email: string | null;
  awaitingSignIn?: boolean;
  paid?: boolean;
  planUnknown?: boolean;
  upgrade?: Plan;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<PurchaseStep>(awaitingSignIn ? "signIn" : "plans");
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
  const [paidEmail, setPaidEmail] = useState(email);
  useEffect(() => {
    if (!paid || paidAtOpen.current) return;
    if (unknownAtOpen.current && stepNow.current === "plans") {
      onClose();
      return;
    }
    setPaidEmail(email);
    setStep((s) => (unanswered(s) || s === "signIn" ? "thanks" : s));
  }, [paid, email]);
  const [interval, setPlan] = useState<PlanInterval>(upgrade ? "five_years" : "year");
  const { prices, failed: pricesFailed } = useSupporterPrices();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkout, setCheckout] = useState<string | null>(null);

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
            // A subscriber switching to five years has a plan all along: only the five years count.
            if (upgrade ? status.plan?.interval === "five_years" : status.plan) {
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
  /** «Open the page again» of the waiting step. */
  const openAgain = () => checkout && void api.openCheckout(checkout).catch((err) => setError(failureText(err, t)));

  // Nothing remembered and no answer yet: the cards keep their room with no price in it.
  const shown = prices ?? (pricesFailed ? FALLBACK : null);
  // Five years paid once, while the server sells them: their card waits for the prices too.
  const fiveYearsSold = !shown || !!shown.five_years;
  const plans = fiveYearsSold ? (["year", "month", "five_years"] as const) : (["year", "month"] as const);
  // Chosen before Paddle's answer said they are not sold: back to the yearly plan, never a hidden choice.
  useEffect(() => {
    if (!fiveYearsSold && !upgrade) setPlan((chosen) => (chosen === "five_years" ? "year" : chosen));
  }, [fiveYearsSold, upgrade]);

  return { step, setStep, interval, setPlan, shown, plans, pay, openAgain, busy, error, checkout, paidEmail };
}

export type SignInStep = "email" | "code" | "noPlan";

/**
 * «Sign in as a Supporter» (sheet 45): the email of the payment, then the code Supabase sends to
 * it. Signed in to an account with no active plan (it ended or was cancelled), the step says so
 * instead of closing as if nothing happened; `unknown` when the server could not be asked about it,
 * which is not the same as «this account has none».
 */
export function useSignIn({ onClose }: { onClose: () => void }) {
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
  /** «Use another email»: back to the first step without the last failure. */
  const anotherEmail = () => {
    setError(null);
    setStep("email");
  };
  /** The code as typed is whole: six digits. */
  const codeReady = code.replace(/\D/g, "").length >= 6;

  return { step, setStep, email, setEmail, code, setCode, error, busy, wait, send, verify, retry, signOut, anotherEmail, unknown, codeReady };
}

/** What the plan's own action is: Manage in Paddle's portal, Try again, Update card, or nothing to do but close. */
export type PlanAction = "manage" | "retry" | "updateCard" | "close";

/**
 * The plan's state on its one line and the action beside it (sheet 45): a renewal, no renewal, a
 * failed payment, a plan that could not be checked, five years paid once.
 */
export function planState(supporter: SupporterStatus, t: TFunction, language: string): { status: string; tone: "muted" | "danger" | "amber"; action: PlanAction } {
  const plan = supporter.plan;
  const date = (iso: string) => longDate(iso, language);
  if (!plan) return { status: "", tone: "muted", action: "manage" };
  // Until when the signed plan is kept without the server (billing.rs, `offline_until`).
  if (supporter.check_failed) return { status: t("supporter.unchecked", { date: date(plan.offline_until) }), tone: "amber", action: "retry" };
  if (plan.status === "past_due") return { status: t("supporter.pastDue"), tone: "danger", action: "updateCard" };
  if (plan.interval === "five_years") {
    // Paid once: nothing to manage in Paddle's portal unless a subscription still renews too.
    if (plan.also_renews) return { status: t("supporter.alsoRenews"), tone: "amber", action: "manage" };
    return { status: t("supporter.paidUntil", { date: date(plan.valid_until) }), tone: "muted", action: "close" };
  }
  if (plan.status === "canceling") return { status: t("supporter.endsOn", { date: date(plan.valid_until) }), tone: "muted", action: "manage" };
  return { status: plan.renews_at ? t("supporter.renewsOn", { date: date(plan.renews_at) }) : "", tone: "muted", action: "manage" };
}

/**
 * The Supporter's plan (sheet 45): its state, its action, «Switch to 5 years» where it is offered,
 * and sign out. The plan is asked of the server when it opens and each time the window comes back
 * into focus, as after «Manage».
 */
export function usePlan({ supporter, onClose, onUpgrade }: { supporter: SupporterStatus; onClose: () => void; onUpgrade?: () => void }) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plan = supporter.plan;
  // «Switch to 5 years» only for a renewing subscription, only where the build sells (a phone's
  // store build does not, NP-154), and only while the server sells them: the prices remembered
  // this week say so, Paddle is asked only without them, and never for a plan that cannot switch
  // (five years, canceling, past due).
  const renewing = !!(plan?.renews_at && plan.status === "active" && plan.interval !== "five_years") && capabilities.purchase === "paddle";
  const { prices } = useSupporterPrices(renewing ? "if_unknown" : "never");
  const offerSwitch = renewing && prices?.five_years ? onUpgrade : undefined;

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

  const state = planState(supporter, t, i18n.language);
  const act = (action: PlanAction) => {
    if (action === "retry") void run(() => api.refreshSupporter());
    else if (action === "close") onClose();
    else void run(api.openSupporterPortal);
  };
  const signOut = () => void run(api.signOutSupporter, true);
  return { ...state, busy, error, setError, offerSwitch, act, signOut };
}
