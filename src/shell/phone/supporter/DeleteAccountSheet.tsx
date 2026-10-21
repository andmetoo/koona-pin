import "../you/you.css";
import "./supporter.css";
import { useId, useRef, type CSSProperties } from "react";
import { CalendarClock, Check, Trash2 } from "lucide-react";
import { stillCharges, useAccountDeletion, viaPlay } from "../../../components/accountDeletion";
import { longDate } from "../../../components/supporterFlow";
import { usePhone } from "../PhoneContext";
import { Button } from "../ui/buttons";
import { PhIcon } from "../ui/icons";
import { Sheet, useCloseSheet } from "../ui/Sheet";
import { CodeForm, Note } from "./parts";

export type DeleteAccountSheetProps = Record<string, never>;

/**
 * «Delete account» on a phone (`app.surface` "deleteAccount", from the plan sheet and the signed-in
 * step of the sign-in): the shared flow (components/accountDeletion.ts) in the Supporter sheets'
 * Paper & Glass — what happens and when, the code (as the sign-in's), then deleted, or the date with
 * «Keep my account». Opened over nothing else: it takes the plan sheet's place, and stays when the
 * account is gone to say so.
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
  const { step, email, plan, canWait, waitUntil, when, setWhen, purpose, deleteAt, code, setCode, codeReady, error, busy, wait } = flow;
  const date = (iso: string | null) => (iso ? longDate(iso, i18n.language) : "");

  if (step === "about")
    return (
      <Sheet
        label={t("deleteAccount.title")}
        title={t("deleteAccount.title")}
        className="sp-sheet"
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
          <p className="sp-text">{t("deleteAccount.intro", { email })}</p>
          <ul className="ys-card sp-delete-list">
            {stillCharges(plan) && <li>{t("deleteAccount.payments")}</li>}
            {plan && <li>{t("deleteAccount.refund")}</li>}
            {viaPlay(plan) && <li>{t("deleteAccount.paymentsPlay")}</li>}
            <li>{t("deleteAccount.deleted")}</li>
            <li>{t("deleteAccount.kept")}</li>
          </ul>
          {canWait && (
            <section className="ys-section">
              <h3 className="ys-label">{t("deleteAccount.when")}</h3>
              <div role="radiogroup" aria-label={t("deleteAccount.when")} className="sp-plans">
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
            </section>
          )}
          {error && <Note tone="danger">{error}</Note>}
        </div>
      </Sheet>
    );

  if (step === "code") {
    const text =
      purpose === "keep"
        ? t("deleteAccount.codeTextKeep", { email })
        : when === "period_end"
          ? t("deleteAccount.codeTextLater", { email, date: date(waitUntil) })
          : t("deleteAccount.codeText", { email });
    return (
      <Sheet
        label={t("deleteAccount.codeTitle")}
        title={t("deleteAccount.codeTitle")}
        className="sp-sheet"
        footer={
          <div className="sp-actions">
            <Button kind="clear" onClick={flow.back}>
              {t("supporter.back")}
            </Button>
            <Button kind="primary" type="submit" form={formId} disabled={busy || !codeReady}>
              {purpose === "keep" ? t("deleteAccount.keep") : t("deleteAccount.delete")}
            </Button>
          </div>
        }
      >
        <CodeForm
          id={formId}
          step="code"
          text={text}
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

  if (step === "failed")
    return (
      <Sheet
        label={t("deleteAccount.failedTitle")}
        title={t("deleteAccount.failedTitle")}
        className="sp-sheet"
        footer={
          <div className="sp-actions">
            <Button kind="clear" onClick={close}>
              {t("common.close")}
            </Button>
            <Button kind="primary" disabled={busy} onClick={flow.retry}>
              {t("common.retry")}
            </Button>
          </div>
        }
      >
        <div data-delete-step="failed">{error && <Note tone="danger">{error}</Note>}</div>
      </Sheet>
    );

  const result =
    step === "deleted"
      ? { title: t("deleteAccount.doneTitle"), icon: Trash2, text: t("deleteAccount.doneText") }
      : step === "scheduled"
        ? { title: t("deleteAccount.scheduledTitle"), icon: CalendarClock, text: t("deleteAccount.scheduledText", { date: date(deleteAt) }) }
        : { title: t("deleteAccount.keptTitle"), icon: Check, text: t("deleteAccount.keptText", { date: date(deleteAt) }) };
  return (
    <Sheet
      label={result.title}
      title={result.title}
      className="sp-sheet"
      footer={
        step === "scheduled" ? (
          <div className="sp-actions">
            <Button kind="clear" disabled={busy} onClick={flow.keep}>
              {t("deleteAccount.keep")}
            </Button>
            <Button kind="primary" onClick={close}>
              {t("supporter.done")}
            </Button>
          </div>
        ) : (
          <Button kind="primary" block onClick={close}>
            {t("supporter.done")}
          </Button>
        )
      }
    >
      <div className="sp-done" data-delete-step={step}>
        <span className="sp-heart sp-account-well" style={{ "--sp-heart": "64px" } as CSSProperties} aria-hidden="true">
          <PhIcon icon={result.icon} at="field" />
        </span>
        <p role="status" className="sp-text">
          {result.text}
        </p>
      </div>
      {error && <Note tone="danger">{error}</Note>}
    </Sheet>
  );
}
