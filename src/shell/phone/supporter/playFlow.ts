import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { failureText, useResendWait } from "../../../components/supporterFlow";
import { api } from "../../../services/api";
import { toCommandError } from "../../../services/errors";
import type { PlanInterval, PlayOffer, PlayPrice, PlayProgress, PlayState, SupporterStatus } from "../../../types";

// Supporter through Google Play Billing in the Play build (NP-154, flow B), apart from how its
// sheet looks (./SupporterSheet.tsx): Play's sheet first, then the server's verdict
// (src-tauri/src/billing/play.rs) — paid when signed in, else the email that claims the purchase
// and the code sent to it. Nothing here names where else Supporter is sold.

/**
 * The sheet's steps: the plans; the email and the code that claim a purchase; a slow payment;
 * thanks; a Supporter buying again (Play refunds it); a purchase of this Google account that
 * belongs to an account to sign in to (`otherAccount` while signed in to another one, `owner`
 * signed out).
 */
export type PlayStep = "plans" | "email" | "code" | "pending" | "paid" | "alreadySupporter" | "otherAccount" | "owner";
/** Why the plans are back with a line under them. */
export type PlayFailure = "failed" | "invalid" | "unavailable";

/**
 * Where a verdict leads. `sign_in` is the code step once an email took the code (`email` known);
 * without one it is a purchase already bound to an account, or owned by this Google account for one,
 * with nobody signed in here: the sheet asks to sign in to it. Cancelled goes back to the plans
 * without a word.
 */
export function playStep(state: PlayState, email: string | null = null): { step: PlayStep; failure: PlayFailure | null } {
  switch (state) {
    case "paid":
      return { step: "paid", failure: null };
    case "email":
      return { step: "email", failure: null };
    case "sign_in":
      return { step: email ? "code" : "owner", failure: null };
    case "pending":
      return { step: "pending", failure: null };
    case "already_supporter":
      return { step: "alreadySupporter", failure: null };
    case "other_account":
      return { step: "otherAccount", failure: null };
    case "canceled":
      return { step: "plans", failure: null };
    case "invalid":
      return { step: "plans", failure: "invalid" };
    case "unavailable":
      return { step: "plans", failure: "unavailable" };
    case "error":
      return { step: "plans", failure: "failed" };
  }
}

/**
 * The step the sheet opens on: a purchase still waiting here — for its email, its code or a slow
 * payment, kept over restarts — resumes it; one that finished does not, nor does nothing.
 */
export function resumedStep(play: PlayProgress | null | undefined): PlayStep {
  if (!play) return "plans";
  const waiting = play.state === "email" || play.state === "pending" || (play.state === "sign_in" && !!play.email);
  return waiting ? playStep(play.state, play.email).step : "plans";
}

const PLAY_PLANS: readonly PlanInterval[] = ["year", "month", "five_years"];

/** The plans the sheet shows: all three while Play's prices are on their way, then those Play sells. */
export const playPlans = (offer: PlayOffer | null): PlanInterval[] => (offer ? PLAY_PLANS.filter((value) => !!offer[value]) : [...PLAY_PLANS]);

/**
 * A plan's price as its card says it, as Play formats it, cents and all («€20.00 a year»): the
 * price Google Play charges, to the letter.
 */
export const playPriceLine = (value: PlanInterval, price: PlayPrice, t: TFunction) =>
  t(value === "year" ? "supporter.perYear" : value === "month" ? "supporter.perMonth" : "supporter.once", { price: price.price });

/**
 * The badge of a card, only where Play's prices make it true: «2 months free» for a year at most ten
 * months' price, «Save 50%» for five years at most half of five yearly payments. Prices in another
 * currency than the yearly one say nothing.
 */
export function playBadge(value: PlanInterval, offer: PlayOffer | null, t: TFunction): string | null {
  const year = offer?.year;
  if (!year) return null;
  const same = (other: PlayPrice | null) => other && other.currency === year.currency && other.micros > 0;
  if (value === "year" && same(offer.month) && year.micros <= offer.month!.micros * 10) return t("supporter.twoMonthsFree");
  if (value === "five_years" && same(offer.five_years) && offer.five_years!.micros * 2 <= year.micros * 5) return t("supporter.save50");
  return null;
}

/** The words of a failure under the plans. */
export function failureLine(failure: PlayFailure, t: TFunction): string {
  return t(failure === "invalid" ? "phone.supporter.play.invalid" : failure === "unavailable" ? "phone.supporter.play.unavailable" : "phone.supporter.play.failed");
}

/**
 * The purchase in the Play build: Play's prices, a plan bought, the server's verdict and the steps
 * that follow it. The app follows a purchase by itself too (a slow payment confirmed, a purchase
 * verified again when the app comes back): `supporter.play` changing moves the open sheet on.
 */
export function usePlayPurchase(supporter: SupporterStatus | null) {
  const { t } = useTranslation();
  const play = supporter?.play ?? null;
  const [step, setStep] = useState<PlayStep>(() => resumedStep(play));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState(play?.email ?? "");
  const [code, setCode] = useState("");
  const { wait, countdown } = useResendWait();
  /** The plan of the last purchase started, for «Try again». */
  const [last, setLast] = useState<PlanInterval | null>(null);

  // Play's prices: asked when the sheet opens, and again by «Try again».
  const [offer, setOffer] = useState<PlayOffer | null>(null);
  const [offerFailed, setOfferFailed] = useState(false);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    let alive = true;
    setOfferFailed(false);
    api
      .getPlayOffer()
      .then((answer) => alive && setOffer(answer))
      .catch(() => alive && setOfferFailed(true));
    return () => {
      alive = false;
    };
  }, [asked]);
  const askOffer = () => setAsked((n) => n + 1);

  const show = (state: PlayState, known: string | null) => {
    const next = playStep(state, known);
    setStep(next.step);
    setError(next.failure ? failureLine(next.failure, t) : null);
  };

  // What the app saw by itself moves the sheet on; the state it opened with is already shown.
  const seen = useRef(`${play?.state}|${play?.email}`);
  useEffect(() => {
    const now = `${play?.state}|${play?.email}`;
    if (now === seen.current) return;
    seen.current = now;
    if (!play) return;
    if (play.email) setEmail(play.email);
    show(play.state, play.email);
  }, [play?.state, play?.email]);

  const run = async (action: () => Promise<void>, purchase = false) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      // A purchase may be paid when the server could not be asked: it is kept and asked about
      // again when the app comes back (billing/play.rs).
      setError(purchase && toCommandError(err).code === "network" ? t("phone.supporter.play.unreachable") : failureText(err, t));
    } finally {
      setBusy(false);
    }
  };
  /** «Subscribe» or «Buy» on a plan: Google Play's sheet, then the verdict. */
  const buy = (interval: PlanInterval) => {
    setLast(interval);
    return run(async () => show(await api.startPlayPurchase(interval), null), true);
  };
  /** The email step: the code goes there. */
  const claim = () =>
    run(async () => {
      const state = await api.playClaimEmail(email);
      if (state === "sign_in") {
        setCode("");
        countdown();
      }
      show(state, email.trim());
    });
  /** The code: it signs in, and the purchase waiting for it is bound to the account. */
  const verify = () =>
    run(async () => {
      const status = await api.verifySignInCode(email, code);
      show(status.play?.state ?? (status.plan ? "paid" : "error"), status.play?.email ?? email.trim());
    });
  const resend = () =>
    run(async () => {
      await api.sendSignInCode(email);
      countdown();
    });
  /** «Use another email» and Back: the email step again, without the last failure. */
  const anotherEmail = () => {
    setError(null);
    setStep("email");
  };
  const codeReady = code.replace(/\D/g, "").length >= 6;

  return { step, setStep, error, busy, offer, offerFailed, askOffer, last, buy, email, setEmail, claim, code, setCode, verify, resend, wait, anotherEmail, codeReady };
}
