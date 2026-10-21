import { useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { DeleteWhen, Plan, SupporterStatus } from "../types";
import { api } from "../services/api";
import { capabilities } from "../platform/capabilities";
import { toCommandError } from "../services/errors";
import { failureText, useResendWait } from "./supporterFlow";

// Deleting the account (billing/deletion.rs), apart from how it looks: the desktop's dialog
// (./AccountDeletionDialog.tsx) and the phone's sheet (src/shell/phone/supporter) draw it.

/**
 * The steps: what happens and when → the code sent to the account's email → done (deleted), or
 * the date it will be (scheduled) with «Keep my account» → kept. `failed` is a deletion the server
 * refused after the code (payments not stopped, no connection): nothing was deleted, Try again.
 */
export type DeleteStep = "about" | "code" | "failed" | "deleted" | "scheduled" | "kept";

/** Paid time is left on this plan, so the account may stay until it ends (the server decides). */
export const paidTimeLeft = (plan: Plan | null, now = Date.now()) => !!plan && new Date(plan.valid_until).getTime() > now;

/** The plan still charges: a subscription that renews, or five years with a subscription renewing too. */
export const stillCharges = (plan: Plan | null) => !!plan && plan.status !== "canceling" && (plan.interval !== "five_years" || plan.also_renews);

/** A plan or a build of Google Play: the texts say Google Play subscriptions are stopped by us. */
export const viaPlay = (plan: Plan | null) => plan?.store === "play" || capabilities.purchase === "play";

/** Errors a code step shows on its field: the code itself, or a sign-in too old for the server. */
/** What a failure says here: the deletion's own reasons first (payments is a server failure that has words). */
function deletionFailure(error: unknown, t: TFunction): string {
  const detail = toCommandError(error).detail;
  if (detail === "payments_not_stopped" || detail === "fresh_sign_in" || detail === "review_account" || detail === "no_paid_time")
    return t(`errors.detail.${detail}`);
  return failureText(error, t);
}

const onCodeStep = (detail: string | undefined) => detail === "wrong_code" || detail === "too_many_messages" || detail === "fresh_sign_in";

export function useAccountDeletion({ supporter }: { supporter: SupporterStatus }) {
  const { t } = useTranslation();
  // What the dialog opened with: signed out after a deletion, it still says whose account it was.
  const opened = useRef(supporter);
  const plan = opened.current.plan;
  const email = opened.current.email ?? "";
  const [step, setStep] = useState<DeleteStep>(supporter.delete_at ? "scheduled" : "about");
  const [deleteAt, setDeleteAt] = useState<string | null>(supporter.delete_at ?? null);
  const [canWait, setCanWait] = useState(() => paidTimeLeft(plan));
  const [waitUntil, setWaitUntil] = useState<string | null>(plan?.valid_until ?? null);
  const [when, setWhen] = useState<DeleteWhen>("now");
  /** What the code is for: deleting, or keeping a scheduled deletion. */
  const [purpose, setPurpose] = useState<"delete" | "keep">("delete");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A code worked in this dialog: the next actions go without one until the server says otherwise. */
  const verified = useRef(false);
  const { wait, countdown } = useResendWait();

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(deletionFailure(err, t));
    } finally {
      setBusy(false);
    }
  };

  /** Sends a code for `next` and opens its step. */
  const askCode = async (next: "delete" | "keep") => {
    await api.sendAccountCode();
    setPurpose(next);
    setCode("");
    setStep("code");
    countdown();
  };

  /** A failure after the code: on the code step when it is about the code, else the failed step. */
  const failed = (err: unknown) => {
    const detail = toCommandError(err).detail;
    if (detail === "fresh_sign_in") verified.current = false;
    if (detail === "fresh_sign_in") setCode("");
    if (detail === "no_paid_time") {
      // The paid period ended meanwhile: back to the choice, now only.
      setCanWait(false);
      setWhen("now");
      setStep("about");
    } else if (!onCodeStep(detail)) setStep("failed");
    else setStep("code");
    setError(deletionFailure(err, t));
  };

  /** The server's answer with `code` (or the fresh sign-in already here), then the deletion. */
  const proceed = async (withCode: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const info = await api.getAccountDeletion(withCode);
      verified.current = true;
      if (info.scheduled) {
        // Scheduled elsewhere already (the web form, another device): said, with «Keep my account».
        setDeleteAt(info.scheduled);
        setStep("scheduled");
        return;
      }
      setCanWait(info.can_wait);
      setWaitUntil(info.wait_until);
      if (when === "period_end" && !info.can_wait) {
        setWhen("now");
        setStep("about");
        setError(t("errors.detail.no_paid_time"));
        return;
      }
      const outcome = await api.deleteAccount(null, when);
      if (outcome.status === "deleted") setStep("deleted");
      else {
        setDeleteAt(outcome.delete_at);
        setStep("scheduled");
      }
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
    }
  };

  /** «Keep my account»: without a code while the sign-in is fresh, else after one. */
  const keep = async (withCode: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await api.keepAccount(withCode);
      verified.current = true;
      setStep("kept");
    } catch (err) {
      const detail = toCommandError(err).detail;
      if (detail === "fresh_sign_in" && withCode === null) {
        try {
          await askCode("keep");
        } catch (sendError) {
          setError(failureText(sendError, t));
        }
      } else if (onCodeStep(detail)) {
        setStep("code");
        setError(deletionFailure(err, t));
      } else setError(deletionFailure(err, t));
    } finally {
      setBusy(false);
    }
  };

  /** «Continue» of the first step: the code, or straight on after a code that already worked. */
  const start = () => (verified.current ? void proceed(null) : void run(() => askCode("delete")));
  /** The code step's action. */
  const confirm = () => void (purpose === "keep" ? keep(code) : proceed(code));
  const resend = () => void run(() => askCode(purpose));
  /** Try again on the failed step: the sign-in is likely still fresh; if not, a new code. */
  const retry = () => void proceed(null);
  /** The code as typed is whole: six digits. */
  const codeReady = code.replace(/\D/g, "").length >= 6;
  /** Leaves the code step for the one before it. */
  const back = () => {
    setError(null);
    setStep(purpose === "keep" ? "scheduled" : "about");
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
    busy,
    wait,
    start,
    confirm,
    resend,
    retry,
    back,
    keep: () => void keep(null),
  };
}
