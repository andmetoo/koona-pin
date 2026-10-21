import "../you/you.css";
import "./supporter.css";
import { useId } from "react";
import { capabilities } from "../../../platform/capabilities";
import { useSignIn } from "../../../components/supporterFlow";
import { usePhone } from "../PhoneContext";
import { Button } from "../ui/buttons";
import { Sheet, useCloseSheet } from "../ui/Sheet";
import { CodeForm, Note } from "./parts";

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
  const signIn = useSignIn({ onClose: close });
  const { step, setStep, email, setEmail, code, setCode, error, busy, wait, send, verify, retry, signOut, anotherEmail, unknown, codeReady } = signIn;
  const title = t(step === "email" ? "supporter.signInTitle" : step === "code" ? "supporter.codeTitle" : "supporter.signedInTitle");

  if (step === "noPlan") {
    const sells = capabilities.purchase !== "none";
    return (
      <Sheet
        label={title}
        title={title}
        className="sp-sheet"
        footer={
          <div className="sp-footer">
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
          <Button kind="ghost" compact disabled={busy} className="sp-sign-out sp-sign-out-under" onClick={() => setSurface("deleteAccount")}>
            {t("deleteAccount.open")}
          </Button>
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
      <CodeForm
        id={formId}
        step={onEmail ? "email" : "code"}
        text={onEmail ? t("phone.supporter.signInText") : t("supporter.codeText", { email })}
        email={email}
        onEmail={setEmail}
        code={code}
        onCode={setCode}
        error={error}
        busy={busy}
        wait={wait}
        onSubmit={() => void (onEmail ? send() : verify())}
        onResend={() => void send()}
        onAnotherEmail={anotherEmail}
      />
    </Sheet>
  );
}
