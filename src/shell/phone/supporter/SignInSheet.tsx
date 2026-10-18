import "../you/you.css";
import "./supporter.css";
import { useId } from "react";
import { capabilities } from "../../../platform/capabilities";
import { useSignIn } from "../../../components/supporterFlow";
import { usePhone } from "../PhoneContext";
import { Button } from "../ui/buttons";
import { Field } from "../ui/controls";
import { Sheet, useCloseSheet } from "../ui/Sheet";
import { Note } from "./parts";

export type SignInSheetProps = Record<string, never>;

/**
 * "Sign in as a Supporter" on a phone (NP-072b; `app.surface` "signIn"): the shared sign-in's
 * steps and errors (components/supporterFlow.ts) — the email, then the 6-digit code sent to it,
 * then, for an account with no active plan, what it is. A detached sheet: the keyboard lifts it, so
 * the step's action under the field stays in view. "See plans" only where the build sells.
 */
export function SignInSheet(_: { props: SignInSheetProps }) {
  const { app } = usePhone();
  const { t, setSurface } = app;
  const close = useCloseSheet();
  const formId = useId();
  const noteId = useId();
  const signIn = useSignIn({ onClose: close });
  const { step, setStep, email, setEmail, code, setCode, error, busy, wait, send, verify, retry, signOut, anotherEmail, unknown, codeReady } = signIn;
  const title = t(step === "email" ? "supporter.signInTitle" : step === "code" ? "supporter.codeTitle" : "supporter.signedInTitle");

  if (step === "noPlan") {
    const sells = capabilities.purchase === "paddle";
    return (
      <Sheet
        label={title}
        title={title}
        className="sp-sheet"
        footer={
          <div className="sp-actions">
            <Button kind="ghost" disabled={busy} className="sp-sign-out" onClick={() => void signOut()}>
              {t("plan.signOut")}
            </Button>
            {unknown ? (
              <Button kind="primary" disabled={busy} onClick={() => void retry()}>
                {t("common.retry")}
              </Button>
            ) : sells ? (
              <Button kind="primary" onClick={() => setSurface("supporter")}>
                {t("supporter.seePlans")}
              </Button>
            ) : (
              <Button kind="clear" onClick={close}>
                {t("common.close")}
              </Button>
            )}
          </div>
        }
      >
        <div data-sign-in-step="noPlan">
          <p className="sp-text">{t(unknown ? "supporter.planUnknownText" : "supporter.noPlanText", { email: email.trim() })}</p>
          {error && <Note tone="danger">{error}</Note>}
        </div>
      </Sheet>
    );
  }

  const onEmail = step === "email";
  return (
    <Sheet
      label={title}
      title={title}
      className="sp-sheet"
      footer={
        onEmail ? (
          <Button kind="primary" block type="submit" form={formId} disabled={busy || !email.trim()}>
            {t("supporter.sendCode")}
          </Button>
        ) : (
          <div className="sp-actions">
            <Button kind="clear" onClick={() => setStep("email")}>
              {t("supporter.back")}
            </Button>
            <Button kind="primary" type="submit" form={formId} disabled={busy || !codeReady}>
              {t("supporter.signIn")}
            </Button>
          </div>
        )
      }
    >
      <form
        id={formId}
        className="sp-form"
        data-sign-in-step={step}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void (onEmail ? send() : verify());
        }}
      >
        <p className="sp-text">{onEmail ? t("phone.supporter.signInText") : t("supporter.codeText", { email })}</p>
        {onEmail ? (
          <Field
            key="email"
            label={t("supporter.email")}
            type="email"
            inputMode="email"
            enterKeyHint="send"
            autoComplete="email"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
            value={email}
            onChange={setEmail}
            aria-invalid={!!error || undefined}
            aria-describedby={error ? noteId : undefined}
            className="sp-field"
          />
        ) : (
          <Field
            key="code"
            label={t("supporter.code")}
            inputMode="numeric"
            enterKeyHint="done"
            autoComplete="one-time-code"
            autoFocus
            maxLength={7}
            value={code}
            onChange={setCode}
            aria-invalid={!!error || undefined}
            aria-describedby={error ? noteId : undefined}
            className="sp-field sp-code"
          />
        )}
        {error && (
          <p id={noteId} role="alert" className="sp-note" data-tone="danger">
            {error}
          </p>
        )}
        {!onEmail && (
          <p className="sp-resend">
            {wait > 0 ? (
              <span className="sp-wait">{t("supporter.sendAgainIn", { time: `0:${String(wait).padStart(2, "0")}` })}</span>
            ) : (
              <Button kind="ghost" compact disabled={busy} onClick={() => void send()}>
                {t("supporter.sendAgain")}
              </Button>
            )}
            <Button kind="ghost" compact onClick={anotherEmail}>
              {t("supporter.anotherEmail")}
            </Button>
          </p>
        )}
      </form>
    </Sheet>
  );
}
