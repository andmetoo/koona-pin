import "../you/you.css";
import "./supporter.css";
import { useId, useRef } from "react";
import { Check, X } from "lucide-react";
import { useAccountDeletion } from "../../../components/accountDeletion";
import { longDate } from "../../../components/supporterFlow";
import { capabilities } from "../../../platform/capabilities";
import { usePhone } from "../PhoneContext";
import { Button } from "../ui/buttons";
import { Sheet, useCloseSheet } from "../ui/Sheet";
import { Shelf, ShelfRow } from "../ui/Shelf";
import { CodeForm, Note, SeasonHeart } from "./parts";

export type DeleteAccountSheetProps = Record<string, never>;

/**
 * «Delete account» on a phone (frames D2–D7; `app.surface` "deleteAccount", from the plan sheet's
 * quiet «Delete account…» (D1) and the signed-in step of the sign-in): the shared flow
 * (components/accountDeletion.ts) — what is deleted and what stays (D2), when, only while paid time
 * is left (D3), the code with the one destructive button (D4), then deleted (D5), or the date with
 * «Keep my account» (D6); payments that could not be stopped (D7). It takes the plan sheet's place,
 * and stays when the account is gone to say so.
 */
export function DeleteAccountSheet(_: { props: DeleteAccountSheetProps }) {
  const { app } = usePhone();
  // The account as the sheet opened: signed out after the deletion, it still says what happened.
  const opened = useRef(app.supporter);
  if (!opened.current?.email && !opened.current?.delete_at) return null;
  return <DeleteBody supporter={opened.current} />;
}

function DeleteBody({ supporter }: { supporter: NonNullable<ReturnType<typeof usePhone>["app"]["supporter"]> }) {
  const { app } = usePhone();
  const { t, i18n } = app;
  const close = useCloseSheet();
  const formId = useId();
  const flow = useAccountDeletion({ supporter });
  const { step, email, plan, waitUntil, when, setWhen, purpose, deleteAt, code, setCode, codeReady, error, paymentsFailed, busy, wait } = flow;
  const date = (iso: string | null) => (iso ? longDate(iso, i18n.language) : "");

  if (step === "about")
    return (
      <Sheet
        label={t("deleteAccount.title")}
        title={t("deleteAccount.title")}
        className="sp-sheet sp-delete"
        footer={
          <div className="sp-actions">
            <Button kind="clear" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button kind="primary" disabled={busy} onClick={flow.start}>
              {t("deleteAccount.continue")}
            </Button>
          </div>
        }
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
              {[t("deleteAccount.payments"), capabilities.purchase === "play" ? t("deleteAccount.paymentsPlay") : null, t("deleteAccount.refund")]
                .filter(Boolean)
                .join(" ")}
            </p>
          )}
          {error && <Note tone="danger">{error}</Note>}
        </div>
      </Sheet>
    );

  if (step === "when")
    return (
      <Sheet
        label={t("deleteAccount.whenTitle")}
        title={t("deleteAccount.whenTitle")}
        className="sp-sheet sp-delete"
        footer={
          <div className="sp-actions">
            <Button kind="clear" onClick={flow.toAbout}>
              {t("supporter.back")}
            </Button>
            <Button kind="primary" disabled={busy} onClick={flow.toCode}>
              {t("deleteAccount.continue")}
            </Button>
          </div>
        }
      >
        <div data-delete-step="when">
          <p className="sp-text sp-delete-lead">{t("deleteAccount.paidUntil", { date: date(waitUntil) })}</p>
          <div role="radiogroup" aria-label={t("deleteAccount.whenTitle")} className="sp-plans sp-delete-when">
            {(
              [
                ["now", t("deleteAccount.now"), t("deleteAccount.nowHint")],
                ["period_end", t("deleteAccount.periodEnd"), t("deleteAccount.periodEndHint", { date: date(waitUntil) })],
              ] as const
            ).map(([value, name, hint]) => (
              <button key={value} type="button" role="radio" aria-checked={when === value} className="sp-plan" onClick={() => setWhen(value)}>
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

  if (step === "code") {
    const keep = purpose === "keep";
    const title = keep ? t("deleteAccount.keepCodeTitle") : t("deleteAccount.codeTitle");
    return (
      <Sheet
        label={title}
        title={title}
        className="sp-sheet sp-delete"
        footer={
          <Button kind="primary" block type="submit" form={formId} disabled={busy || !codeReady} className={keep ? "" : "sp-danger"}>
            {keep ? t("deleteAccount.keep") : t("deleteAccount.delete")}
          </Button>
        }
      >
        <CodeForm
          id={formId}
          step="code"
          text={keep ? t("deleteAccount.codeTextKeep", { email }) : t("deleteAccount.codeText", { email })}
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

  if (step === "failed") {
    const title = paymentsFailed ? t("deleteAccount.failedTitle") : t("deleteAccount.notDeletedTitle");
    return (
      <Sheet
        label={title}
        title={title}
        className="sp-sheet sp-delete"
        footer={
          <div className="sp-actions">
            <Button kind="clear" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button kind="primary" disabled={busy} onClick={flow.retry}>
              {t("common.retry")}
            </Button>
          </div>
        }
      >
        <div data-delete-step="failed">
          {paymentsFailed ? <p role="alert" className="sp-text">{t("deleteAccount.failedText")}</p> : error && <Note tone="danger">{error}</Note>}
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
          <div className="sp-actions">
            <Button kind="clear" disabled={busy} className="sp-keep" onClick={flow.keep}>
              {t("deleteAccount.keep")}
            </Button>
            <Button kind="primary" onClick={close}>
              {t("supporter.done")}
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
                <span className="ph-headline">{t(plan.interval === "five_years" ? "plan.fiveYears" : plan.interval === "month" ? "plan.monthly" : "plan.yearly")}</span>
                <span className="ph-meta sp-email" data-user-text>
                  {email}
                </span>
                <span className="sp-status">{t("deleteAccount.endsOn", { date: date(deleteAt) })}</span>
              </span>
            </div>
          )}
          <p className="sp-text sp-delete-note">{t("deleteAccount.scheduledText")}</p>
          {error && <Note tone="danger">{error}</Note>}
        </div>
      </Sheet>
    );
  }

  const deleted = step === "deleted";
  const title = deleted ? t("deleteAccount.doneTitle") : t("deleteAccount.keptTitle");
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
        {deleted ? t("deleteAccount.doneTextPhone") : t("deleteAccount.keptText", { date: date(deleteAt) })}
      </p>
    </Sheet>
  );
}
