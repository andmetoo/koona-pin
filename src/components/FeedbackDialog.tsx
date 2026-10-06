import { useEffect, useId, useRef, useState } from "react";
import { Check, CircleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FeedbackKind } from "../types";
import { api } from "../services/api";
import { CommandError, describeError, toCommandError } from "../services/errors";
import { draftText, emailShape, emptyDraft, FeedbackDraft, length, MAX_MESSAGE, PRIVACY_URL } from "../services/feedback";
import { Icon } from "./icons";
import { Button } from "./ui/Button";
import { Segmented } from "./ui/Controls";
import { Dialog } from "./ui/Dialog";

/**
 * «Отправить отзыв» (sheet 39, NP-088). The draft belongs to the caller: closing
 * the dialog or a failed send keeps it; only a sent message clears it. The
 * request goes out from Rust on «Send» and never before.
 */
export function FeedbackDialog({
  draft,
  onDraft,
  onClose,
}: {
  draft: FeedbackDraft;
  onDraft: (draft: FeedbackDraft) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [report, setReport] = useState<string | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<CommandError | null>(null);
  const [emailWrong, setEmailWrong] = useState(false);
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const ids = { message: useId(), email: useId(), emailNote: useId(), attach: useId(), report: useId() };
  const language = i18n.resolvedLanguage ?? i18n.language;

  useEffect(() => {
    let current = true;
    void api
      .feedbackReport(language)
      .then((text) => current && setReport(text))
      .catch(() => current && setReport(null));
    return () => {
      current = false;
    };
  }, [language]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const change = (patch: Partial<FeedbackDraft>) => onDraft({ ...draft, ...patch });
  const count = length(draft.message);
  const tooLong = count > MAX_MESSAGE;
  const canSend = count > 0 && !tooLong && !sending;
  const kindLabel = t(`feedback.${draft.kind}`);

  const send = async () => {
    if (!canSend) return;
    const email = draft.email.trim();
    if (email && !emailShape(email)) {
      setEmailWrong(true);
      emailRef.current?.focus();
      return;
    }
    setSending(true);
    setFailure(null);
    try {
      await api.sendFeedback({
        kind: draft.kind,
        message: draft.message.trim(),
        email: email || null,
        report: draft.attach ? report : null,
        language,
      });
      setSent(true);
      onDraft(emptyDraft);
    } catch (err) {
      const error = toCommandError(err);
      if (error.detail === "invalid_email") {
        setEmailWrong(true);
        emailRef.current?.focus();
      } else setFailure(error);
    } finally {
      setSending(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draftText(draft, kindLabel, draft.attach ? report : null));
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  };

  if (sent) {
    return (
      <Dialog title={t("feedback.title")} onClose={onClose} width={480}>
        <div className="flex flex-col items-center gap-2 pt-1 text-center" role="status">
          <span className="mb-2 flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
            <Icon icon={Check} size={22} strokeWidth={2.4} />
          </span>
          <p className="text-lg font-semibold">{t("feedback.sentTitle")}</p>
          <p className="max-w-[360px] text-sm text-muted">{t("feedback.sentBody")}</p>
        </div>
        <footer className="mt-5 flex justify-end">
          <Button variant="primary" size="lg" data-autofocus onClick={onClose}>
            {t("feedback.done")}
          </Button>
        </footer>
      </Dialog>
    );
  }

  return (
    <Dialog title={t("feedback.title")} onClose={onClose} width={480} locked={sending}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <p className="-mt-1 text-sm text-muted">{t("feedback.lead")}</p>
        <div className="flex">
          <Segmented<FeedbackKind>
            label={t("feedback.kind")}
            value={draft.kind}
            onChange={(kind) => change({ kind })}
            options={(["bug", "idea", "question"] as const).map((value) => ({ value, label: t(`feedback.${value}`) }))}
          />
        </div>
        <div className="relative">
          <textarea
            id={ids.message}
            aria-label={t("feedback.message")}
            data-autofocus
            rows={6}
            value={draft.message}
            disabled={sending}
            placeholder={t("feedback.placeholder")}
            onChange={(e) => change({ message: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void send();
              }
            }}
            className="field block min-h-[132px] resize-y pb-6"
          />
          <span className={`pointer-events-none absolute right-3 bottom-2 text-2xs ${tooLong ? "text-danger" : "text-subtle"}`} aria-live="polite">
            {t("feedback.count", { count, max: MAX_MESSAGE })}
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.email} className="text-xs font-medium text-muted">
            {t("feedback.email")}
          </label>
          <input
            id={ids.email}
            ref={emailRef}
            type="email"
            inputMode="email"
            autoComplete="email"
            value={draft.email}
            disabled={sending}
            placeholder={t("feedback.emailPlaceholder")}
            aria-invalid={emailWrong || undefined}
            aria-describedby={emailWrong ? ids.emailNote : undefined}
            onChange={(e) => {
              setEmailWrong(false);
              change({ email: e.target.value });
            }}
            className={`field ${emailWrong ? "border-danger" : ""}`}
          />
          {emailWrong && (
            <p id={ids.emailNote} className="text-xs text-danger">
              {t("errors.detail.invalid_email")}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <input
              id={ids.attach}
              type="checkbox"
              checked={draft.attach}
              disabled={sending}
              onChange={(e) => change({ attach: e.target.checked })}
              className="size-4 shrink-0 accent-accent"
            />
            <label htmlFor={ids.attach} className="flex-1 text-sm font-medium">
              {t("feedback.attach")}
            </label>
            <button
              type="button"
              aria-expanded={showReport}
              aria-controls={ids.report}
              onClick={() => setShowReport((shown) => !shown)}
              className="text-sm font-medium text-accent hover:underline"
            >
              {showReport ? t("feedback.hideReport") : t("feedback.showReport")}
            </button>
          </div>
          <p className="pl-6 text-xs text-subtle">{t("feedback.attachHint")}</p>
          {showReport && (
            <pre
              id={ids.report}
              aria-label={t("feedback.report")}
              tabIndex={0}
              className="mt-2 max-h-[160px] overflow-auto rounded-lg bg-secondary px-3 py-2.5 font-mono text-2xs leading-4 whitespace-pre-wrap text-icon [overflow-wrap:anywhere]"
            >
              {report ?? "…"}
            </pre>
          )}
        </div>
        <p className="text-xs text-subtle">
          {t("feedback.privacy")}{" "}
          <button
            type="button"
            onClick={() => void api.openUrl(PRIVACY_URL).catch((err) => setFailure(toCommandError(err)))}
            className="text-accent hover:underline"
          >
            {t("feedback.privacyLink")}
          </button>
        </p>
        {failure && (
          <p role="alert" className="flex gap-2.5 rounded-xl bg-danger-soft px-3 py-2.5 text-sm text-on-danger-soft">
            <Icon icon={CircleAlert} className="mt-px shrink-0" />
            <span>{describeError(failure)}</span>
          </p>
        )}
        <footer className="flex justify-end gap-2">
          <Button variant="outline" size="lg" disabled={sending} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {failure ? (
            <>
              <Button variant="outline" size="lg" onClick={() => void copy()}>
                {copied === "done" ? t("feedback.copied") : copied === "failed" ? t("feedback.copyFailed") : t("feedback.copy")}
              </Button>
              <Button variant="primary" size="lg" type="submit" disabled={!canSend}>
                {t("common.retry")}
              </Button>
            </>
          ) : (
            <Button variant="primary" size="lg" type="submit" disabled={!canSend}>
              {sending ? t("feedback.sending") : t("feedback.send")}
            </Button>
          )}
        </footer>
      </form>
    </Dialog>
  );
}
