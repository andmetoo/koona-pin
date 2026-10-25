import "../you/you.css";
import "./supporter.css";
import { useId, useRef, type ReactNode } from "react";
import { Check, X } from "lucide-react";
import { cancelsPlay, paymentsKey, radioKeys, refundKey, useAccountDeletion } from "../../../components/accountDeletion";
import { longDate } from "../../../components/supporterFlow";
import type { DeleteWhen } from "../../../types";
import { usePhone } from "../PhoneContext";
import { Button } from "../ui/buttons";
import { Sheet, useCloseSheet } from "../ui/Sheet";
import { Shelf, ShelfRow } from "../ui/Shelf";
import { CodeForm, Note, SeasonHeart } from "./parts";

export type DeleteAccountSheetProps = Record<string, never>;

const TIMES = ["now", "period_end"] as const satisfies readonly DeleteWhen[];

/**
 * «Delete account» on a phone (frames D2–D7; `app.surface` "deleteAccount", from the plan sheet's
 * quiet «Delete account…» (D1), the Supporter sheet of an account without a plan, and the signed-in
 * step of the sign-in): the shared flow (components/accountDeletion.ts) — what is deleted and what
 * stays (D2), a code when the sign-in here is too old, when, only while the server says paid time is
 * left (D3), the one red «Delete account» (D4's button), then deleted (D5), or the date with «Keep my
 * account» (D6); payments that could not be stopped (D7), or an answer that did not come. It takes
 * the plan sheet's place, and stays when the account is gone to say so.
 */
export function DeleteAccountSheet(_: { props: DeleteAccountSheetProps }) {
  const { app } = usePhone();
  // The account as the sheet opened: signed out after the deletion, it still says what happened.
  const opened = useRef(app.supporter);
  if (!opened.current?.email && !opened.current?.delete_at && !opened.current?.deletion_pending) return null;
  return <DeleteBody supporter={opened.current} />;
}

function DeleteBody({ supporter }: { supporter: NonNullable<ReturnType<typeof usePhone>["app"]["supporter"]> }) {
  const { app } = usePhone();
  const { t, i18n } = app;
  const close = useCloseSheet();
  const formId = useId();
  const flow = useAccountDeletion({ supporter });
  const { step, email, plan, waitUntil, when, setWhen, purpose, deleteAt, code, setCode, codeReady, error, failure, busy, wait } = flow;
  const date = (iso: string | null) => (iso ? longDate(iso, i18n.language) : "");
  const pair = (left: ReactNode, right: ReactNode) => (
    <div className="sp-actions">
      {left}
      {right}
    </div>
  );
  const backButton = (
    <Button kind="clear" onClick={flow.back}>
      {t("supporter.back")}
    </Button>
  );

  if (step === "about")
    return (
      <Sheet
        label={t("deleteAccount.title")}
        title={t("deleteAccount.title")}
        className="sp-sheet sp-delete"
        footer={pair(
          <Button kind="clear" onClick={close}>
            {t("common.cancel")}
          </Button>,
          <Button kind="primary" disabled={busy} onClick={flow.start}>
            {t("deleteAccount.continue")}
          </Button>,
        )}
      >
        <div data-delete-step="about">
          <section className="ys-section sp-delete-first">
            <h3 className="ys-label">{t("deleteAccount.deletedLabel")}</h3>
            <Shelf className="ys-shelf sp-shelf sp-delete-gone">
              <ShelfRow icon={X} title={t("deleteAccount.account")} subtitle={<span data-user-text>{email}</span>} />
              <ShelfRow icon={X} title={t("deleteAccount.purchases")} subtitle={t("deleteAccount.purchasesHint")} />
              <ShelfRow icon={X} title={t("deleteAccount.sync")} subtitle={t("deleteAccount.syncHint")} />
            </Shelf>
          </section>
          <section className="ys-section">
            <h3 className="ys-label">{t("deleteAccount.staysLabel")}</h3>
            <Shelf className="ys-shelf sp-shelf sp-delete-stays">
              <ShelfRow icon={Check} title={t("deleteAccount.library")} subtitle={t("deleteAccount.libraryHintPhone")} />
              <ShelfRow icon={Check} title={t("deleteAccount.records")} subtitle={t("deleteAccount.recordsHint")} />
            </Shelf>
          </section>
          {plan && (
            <p className="sp-text sp-delete-payments">
              {[t(paymentsKey(plan)), cancelsPlay(plan) ? t("deleteAccount.paymentsPlay") : null, t(refundKey(plan))].filter(Boolean).join(" ")}
            </p>
          )}
          {error && <Note tone="danger">{error}</Note>}
        </div>
      </Sheet>
    );

  if (step === "code") {
    const keep = purpose === "keep";
    const title = keep ? t("deleteAccount.keepCodeTitle") : t("supporter.codeTitle");
    return (
      <Sheet
        label={title}
        title={title}
        className="sp-sheet sp-delete"
        footer={pair(
          backButton,
          <Button kind="primary" type="submit" form={formId} disabled={busy || !codeReady}>
            {keep ? t("deleteAccount.keep") : t("deleteAccount.continue")}
          </Button>,
        )}
      >
        <CodeForm
          id={formId}
          step="code"
          text={keep ? t("deleteAccount.codeTextKeep", { email }) : t("deleteAccount.codeTextContinue", { email })}
          email={email}
          onEmail={() => {}}
          code={code}
          onCode={setCode}
          error={error}
          busy={busy}
          wait={wait}
          onSubmit={flow.confirm}
          onResend={flow.resend}
        />
      </Sheet>
    );
  }

  if (step === "when")
    return (
      <Sheet
        label={t("deleteAccount.whenTitle")}
        title={t("deleteAccount.whenTitle")}
        className="sp-sheet sp-delete"
        footer={pair(
          backButton,
          <Button kind="primary" disabled={busy} onClick={flow.toConfirm}>
            {t("deleteAccount.continue")}
          </Button>,
        )}
      >
        <div data-delete-step="when">
          <p className="sp-text sp-delete-lead">{t("deleteAccount.paidUntil", { date: date(waitUntil) })}</p>
          <div role="radiogroup" aria-label={t("deleteAccount.whenTitle")} onKeyDown={radioKeys(TIMES, when, setWhen)} className="sp-plans sp-delete-when">
            {(
              [
                ["now", t("deleteAccount.now"), t("deleteAccount.nowHint")],
                ["period_end", t("deleteAccount.periodEnd"), t("deleteAccount.periodEndHint", { date: date(waitUntil) })],
              ] as const
            ).map(([value, name, hint]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={when === value}
                tabIndex={when === value ? 0 : -1}
                className="sp-plan"
                onClick={() => setWhen(value)}
              >
                <span className="sp-radio" aria-hidden="true" />
                <span className="sp-plan-text">
                  <span className="sp-plan-name">{name}</span>
                  <span className="sp-delete-hint">{hint}</span>
                </span>
              </button>
            ))}
          </div>
          <p className="sp-text sp-delete-note">{t("deleteAccount.eitherWay")}</p>
          {error && <Note tone="danger">{error}</Note>}
        </div>
      </Sheet>
    );

  if (step === "confirm")
    return (
      <Sheet
        label={t("deleteAccount.codeTitle")}
        title={t("deleteAccount.codeTitle")}
        className="sp-sheet sp-delete"
        footer={pair(
          backButton,
          <Button kind="primary" disabled={busy} className="sp-danger" onClick={flow.remove}>
            {t("deleteAccount.delete")}
          </Button>,
        )}
      >
        <div data-delete-step="confirm">
          <p className="sp-text">{when === "period_end" ? t("deleteAccount.confirmLater", { date: date(waitUntil) }) : t("deleteAccount.confirmNow")}</p>
          {error && <Note tone="danger">{error}</Note>}
        </div>
      </Sheet>
    );

  if (step === "failed" || step === "unknown") {
    const unknown = step === "unknown";
    const title = unknown ? t("deleteAccount.unknownTitle") : failure === "payments" ? t("deleteAccount.failedTitle") : t("deleteAccount.notDeletedTitle");
    return (
      <Sheet
        label={title}
        title={title}
        className="sp-sheet sp-delete"
        footer={pair(
          <Button kind="clear" onClick={close}>
            {unknown ? t("common.close") : t("common.cancel")}
          </Button>,
          <Button kind="primary" disabled={busy} onClick={unknown ? flow.check : flow.retry}>
            {unknown ? t("deleteAccount.checkAgain") : t("common.retry")}
          </Button>,
        )}
      >
        <div data-delete-step={step}>
          {unknown ? (
            <>
              <p role="status" className="sp-text">
                {t("deleteAccount.unknownText")}
              </p>
              {error && <Note tone="danger">{error}</Note>}
            </>
          ) : failure === "payments" ? (
            <p role="alert" className="sp-text">
              {t("deleteAccount.failedText")}
            </p>
          ) : (
            error && <Note tone="danger">{error}</Note>
          )}
        </div>
      </Sheet>
    );
  }

  if (step === "scheduled") {
    const title = t("deleteAccount.scheduledTitle", { date: date(deleteAt) });
    return (
      <Sheet
        label={title}
        title={title}
        className="sp-sheet sp-delete"
        footer={
          <div className="sp-footer">
            {pair(
              <Button kind="clear" disabled={busy} className="sp-keep" onClick={flow.keep}>
                {t("deleteAccount.keep")}
              </Button>,
              <Button kind="primary" onClick={close}>
                {t("supporter.done")}
              </Button>,
            )}
            <Button kind="ghost" compact disabled={busy} className="sp-sign-out sp-sign-out-under" onClick={flow.deleteNow}>
              {t("deleteAccount.deleteNowInstead")}
            </Button>
          </div>
        }
      >
        <div data-delete-step="scheduled">
          <p className="sp-text sp-delete-lead">{t("deleteAccount.scheduledLead")}</p>
          {plan && (
            <div className="ys-card ys-supporter sp-delete-plan">
              <SeasonHeart />
              <span className="ys-supporter-text">
                <span className="ph-headline">{t(plan.interval === "lifetime" ? "plan.lifetime" : plan.interval === "month" ? "plan.monthly" : "plan.yearly")}</span>
                <span className="ph-meta sp-email" data-user-text>
                  {email}
                </span>
                <span className="sp-status">{t("deleteAccount.endsOn", { date: date(deleteAt) })}</span>
              </span>
            </div>
          )}
          <p className="sp-text sp-delete-note">{t("deleteAccount.scheduledText")}</p>
          <p className="sp-text sp-delete-more">{t("deleteAccount.buyKeeps")}</p>
          {error && <Note tone="danger">{error}</Note>}
        </div>
      </Sheet>
    );
  }

  const deleted = step === "deleted";
  const title = deleted ? t("deleteAccount.doneTitle") : step === "signedOut" ? t("deleteAccount.signedOutTitle") : t("deleteAccount.keptTitle");
  return (
    <Sheet
      label={title}
      title={title}
      className="sp-sheet sp-delete"
      footer={
        <Button kind="primary" block onClick={close}>
          {t("supporter.done")}
        </Button>
      }
    >
      <p role="status" className="sp-text" data-delete-step={step}>
        {deleted
          ? t("deleteAccount.doneTextPhone")
          : step === "signedOut"
            ? t("deleteAccount.signedOutText")
            : t("deleteAccount.keptText", { date: date(deleteAt) })}
      </p>
    </Sheet>
  );
}
