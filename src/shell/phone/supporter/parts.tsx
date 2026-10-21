import { useId, type CSSProperties, type ReactNode } from "react";
import { CircleAlert, Heart, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/buttons";
import { Field } from "../ui/controls";
import { PhIcon } from "../ui/icons";

/** The Supporter heart, filled, in the season's colour on its soft disc (A1). */
export function SeasonHeart({ size = 48 }: { size?: number }) {
  return (
    <span className="ys-heart sp-heart" style={{ "--sp-heart": `${size}px` } as CSSProperties} aria-hidden="true">
      <Heart size={Math.round(size / 2)} strokeWidth={1.75} absoluteStrokeWidth fill="currentColor" />
    </span>
  );
}

/** A person on a neutral well, the size of the heart beside it: an account to sign in to (P7). */
export function AccountWell({ size = 72 }: { size?: number }) {
  return (
    <span className="sp-heart sp-account-well" style={{ "--sp-heart": `${size}px` } as CSSProperties} aria-hidden="true">
      <User size={Math.round(size * 0.4)} strokeWidth={1.75} absoluteStrokeWidth />
    </span>
  );
}

/**
 * A line that needs attention: a failure (danger, read out at once) or a notice (amber, a status).
 * Errors only are red (doc/mobile-design.md).
 */
export function Note({ tone, children }: { tone: "danger" | "amber"; children: ReactNode }) {
  return (
    <p role={tone === "danger" ? "alert" : "status"} className="sp-note" data-tone={tone}>
      {children}
    </p>
  );
}

/**
 * A notice on paper (the Play sheet's P8): a round well with an alert glyph — red for what went
 * wrong, amber for what waits — an optional title, the words, and an action under them (Try
 * again). `live` makes the words a live region: «alert» for a failure, «status» for a notice.
 */
export function Notice({
  tone,
  title,
  live,
  action,
  children,
}: {
  tone: "danger" | "amber";
  title?: ReactNode;
  live?: "alert" | "status";
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="ys-card sp-notice" data-tone={tone}>
      <span className="sp-notice-well" aria-hidden="true">
        <PhIcon icon={CircleAlert} at="field" />
      </span>
      <span className="sp-notice-text">
        {title && <span className="sp-notice-title">{title}</span>}
        <span role={live} className="sp-notice-body">
          {children}
        </span>
        {action}
      </span>
    </div>
  );
}

/**
 * The email and the code by which an email is proven (the sign-in, and the email that claims a
 * Google Play purchase): the step's words, its field, its failure, and on the code step «Send
 * again» after a minute and «Use another email». The sheet's footer submits it through `id`.
 */
export function CodeForm({
  id,
  step,
  text,
  email,
  onEmail,
  code,
  onCode,
  error,
  busy,
  wait,
  onSubmit,
  onResend,
  onAnotherEmail,
}: {
  id: string;
  step: "email" | "code";
  text: ReactNode;
  email: string;
  onEmail: (email: string) => void;
  code: string;
  onCode: (code: string) => void;
  error: string | null;
  busy: boolean;
  /** Seconds before a new code may be sent. */
  wait: number;
  onSubmit: () => void;
  onResend: () => void;
  /** «Use another email»; none where the email is the account's own (deleting it). */
  onAnotherEmail?: () => void;
}) {
  const { t } = useTranslation();
  const noteId = useId();
  const onEmailStep = step === "email";
  return (
    <form
      id={id}
      className="sp-form"
      data-sign-in-step={step}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <p className="sp-text">{text}</p>
      {onEmailStep ? (
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
          onChange={onEmail}
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
          onChange={onCode}
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
      {!onEmailStep && (
        <p className="sp-resend">
          {wait > 0 ? (
            <span className="sp-wait">{t("supporter.sendAgainIn", { time: `0:${String(wait).padStart(2, "0")}` })}</span>
          ) : (
            <Button kind="ghost" compact disabled={busy} onClick={onResend}>
              {t("supporter.sendAgain")}
            </Button>
          )}
          {onAnotherEmail && (
            <Button kind="ghost" compact onClick={onAnotherEmail}>
              {t("supporter.anotherEmail")}
            </Button>
          )}
        </p>
      )}
    </form>
  );
}
