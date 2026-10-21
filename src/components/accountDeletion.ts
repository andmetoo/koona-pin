import { useRef, useState, type KeyboardEvent } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { DeleteInfo, DeleteOutcome, DeleteWhen, Plan, SupporterStatus } from "../types";
import { api } from "../services/api";
import { capabilities } from "../platform/capabilities";
import { toCommandError } from "../services/errors";
import { failureText, useResendWait } from "./supporterFlow";

// Deleting the account (billing/deletion.rs), apart from how it looks: the desktop's dialog
// (./AccountDeletionDialog.tsx) and the phone's sheet (src/shell/phone/supporter) draw it.

/**
 * The steps (frames D2–D7):
 * - `about`: what is deleted and what stays (D2). Its Continue asks the server with the sign-in
 *   here: a fresh one goes on, an old one (or one the server minted) gets a code (`code`), the
 *   review account hears at once that it is not deleted.
 * - `when`: now or at the end of the paid period (D3), only when the server says paid time is left.
 * - `confirm`: the one red «Delete account» (D4's button). Nothing is ever deleted from a Continue.
 * - `deleted` (D5), `scheduled` (D6) with «Keep my account» and «Delete now instead», `kept`.
 * - `failed`: the server refused and said so (payments not stopped, a payment still processing):
 *   nothing was deleted (D7). `unknown`: the answer did not come, so «Check again» asks.
 */
export type DeleteStep = "about" | "code" | "when" | "confirm" | "failed" | "unknown" | "deleted" | "scheduled" | "kept";

/** What the failed step says: payments not stopped (D7), a payment still processing, another refusal. */
export type DeleteFailure = "payments" | "pending" | "other";

/** What the code proves: deleting (after it, the choice), keeping a scheduled deletion, deleting it now instead. */
type Purpose = "delete" | "keep" | "now";

/** The sentence about Google Play: only for a Google Play subscription, in the Play build (D2). */
export const cancelsPlay = (plan: Plan | null) => capabilities.purchase === "play" && plan?.store === "play" && plan.interval !== "five_years";

/** What a failure says here: the deletion's own reasons first (payments is a server failure that has words). */
function deletionFailure(error: unknown, t: TFunction): string {
  const detail = toCommandError(error).detail;
  if (
    detail === "payments_not_stopped" ||
    detail === "payment_pending" ||
    detail === "fresh_sign_in" ||
    detail === "review_account" ||
    detail === "no_paid_time" ||
    detail === "deletion_unknown"
  )
    return t(`errors.detail.${detail}`);
  return failureText(error, t);
}

/**
 * Arrow keys move the choice of a radio group, as native radios do; the chosen one is the group's
 * one Tab stop (`tabIndex` of each radio).
 */
export function radioKeys<T extends string>(values: readonly T[], current: T, choose: (value: T) => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = (values.indexOf(current) + step + values.length) % values.length;
    choose(values[index]);
    event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[index]?.focus();
  };
}

export function useAccountDeletion({ supporter }: { supporter: SupporterStatus }) {
  const { t } = useTranslation();
  // What the dialog opened with: signed out after a deletion, it still says whose account it was.
  const opened = useRef(supporter);
  const plan = opened.current.plan;
  const email = opened.current.email ?? "";
  const [step, setStep] = useState<DeleteStep>(supporter.delete_at ? "scheduled" : "about");
  const [deleteAt, setDeleteAt] = useState<string | null>(supporter.delete_at ?? null);
  // The server's word (delete_info), never the plan here: a payment that failed has no time to wait.
  const [canWait, setCanWait] = useState(false);
  const [waitUntil, setWaitUntil] = useState<string | null>(null);
  const [when, setWhen] = useState<DeleteWhen>("now");
  const [purpose, setPurpose] = useState<Purpose>("delete");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<DeleteFailure>("other");
  const [busy, setBusy] = useState(false);
  const { wait, countdown } = useResendWait();

  /** Runs one request with the step busy; a failure goes to `fail` (by default: said on this step). */
  const run = async (action: () => Promise<void>, fail: (err: unknown) => void | Promise<void> = (err) => setError(deletionFailure(err, t))) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      await fail(err);
    } finally {
      setBusy(false);
    }
  };

  /** Sends a code for `next` and opens its step. */
  const askCode = async (next: Purpose) => {
    await api.sendAccountCode();
    setPurpose(next);
    setCode("");
    setStep("code");
    countdown();
  };
  /** A sign-in too old: a new code is sent at once (said if even that fails). */
  const codeAgain = async (next: Purpose) => {
    try {
      await askCode(next);
    } catch (err) {
      setError(deletionFailure(err, t));
    }
  };

  /** The server's answer about the account: what comes next for `next`. */
  const take = (info: DeleteInfo, next: Purpose) => {
    setCanWait(info.can_wait);
    setWaitUntil(info.wait_until);
    if (next === "now") {
      setWhen("now");
      setStep("confirm");
    } else if (info.scheduled) {
      // Scheduled elsewhere already (the web form, another device): said, with «Keep my account».
      setDeleteAt(info.scheduled);
      setStep("scheduled");
    } else {
      // The end of the paid period is chosen first (D3): the person keeps what they paid for.
      setWhen(info.can_wait ? "period_end" : "now");
      setStep(info.can_wait ? "when" : "confirm");
    }
  };

  /** Asks the server with the sign-in here; a code first when it is too old. */
  const ask = (next: Purpose) =>
    run(
      async () => take(await api.getAccountDeletion(null), next),
      async (err) => {
        if (toCommandError(err).detail === "fresh_sign_in") await codeAgain(next);
        else setError(deletionFailure(err, t));
      },
    );

  const outcome = (result: DeleteOutcome) => {
    if (result.status === "deleted") setStep("deleted");
    else if (result.status === "scheduled") {
      setDeleteAt(result.delete_at);
      setStep("scheduled");
    } else {
      // Still there and nothing scheduled: the choice again, to delete with its red button.
      setStep("confirm");
      setError(t("deleteAccount.stillThere"));
    }
  };

  /** The red «Delete account»: the one place an account is deleted from. */
  const remove = () =>
    run(
      async () => outcome(await api.deleteAccount(when)),
      async (err) => {
        const detail = toCommandError(err).detail;
        if (detail === "fresh_sign_in") await codeAgain(when === "now" && purpose === "now" ? "now" : "delete");
        else if (detail === "no_paid_time") {
          // The paid period ended meanwhile: deleting now is asked again, with its red button.
          setCanWait(false);
          setWhen("now");
          setStep("confirm");
          setError(t("errors.detail.no_paid_time"));
        } else if (detail === "deletion_unknown") setStep("unknown");
        else {
          setFailure(detail === "payments_not_stopped" ? "payments" : detail === "payment_pending" ? "pending" : "other");
          setStep("failed");
          setError(deletionFailure(err, t));
        }
      },
    );

  /** «Check again» after an answer that did not come. */
  const check = () => run(async () => outcome(await api.checkAccountDeletion()));

  /** «Keep my account»: without a code while the sign-in is fresh, else after one. */
  const keep = (withCode: string | null) =>
    run(
      async () => {
        await api.keepAccount(withCode);
        setStep("kept");
      },
      async (err) => {
        if (toCommandError(err).detail === "fresh_sign_in" && withCode === null) await codeAgain("keep");
        else setError(deletionFailure(err, t));
      },
    );

  /** The code step's action: the server's answer with the new sign-in, then the next step. */
  const confirm = () => {
    if (purpose === "keep") return void keep(code);
    void run(async () => take(await api.getAccountDeletion(code), purpose));
  };

  /** The code as typed is whole: six digits. */
  const codeReady = code.replace(/\D/g, "").length >= 6;
  /** Back from a step to the one before it. */
  const back = () => {
    setError(null);
    if (step === "code") setStep(purpose === "delete" ? "about" : "scheduled");
    else if (step === "confirm") setStep(purpose === "now" ? "scheduled" : canWait ? "when" : "about");
    else setStep("about");
  };

  return {
    step,
    email,
    plan,
    canWait,
    waitUntil,
    when,
    setWhen,
    purpose,
    deleteAt,
    code,
    setCode,
    codeReady,
    error,
    failure,
    busy,
    wait,
    /** Continue of what happens (D2). */
    start: () => void ask("delete"),
    /** Continue of the choice (D3): the red confirmation. */
    toConfirm: () => {
      setError(null);
      setStep("confirm");
    },
    confirm,
    remove: () => void remove(),
    resend: () => void run(() => askCode(purpose)),
    /** Try again on the failed step: the red action again. */
    retry: () => void remove(),
    check: () => void check(),
    back,
    keep: () => void keep(null),
    /** «Delete now instead» of a scheduled deletion. */
    deleteNow: () => void ask("now"),
  };
}
