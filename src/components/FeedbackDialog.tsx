import { useEffect, useId, useRef, useState } from "react";
import { Check, CircleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FeedbackKind } from "../types";
import { api } from "../services/api";
import { CommandError, describeError, toCommandError } from "../services/errors";
import { draftText, emailShape, emptyDraft, FeedbackDraft, length, MAX_MESSAGE, privacyUrl } from "../services/feedback";
import { Icon } from "./icons";
import { Button } from "./ui/Button";
import { Field, Segmented, StatePanels } from "./ui/Controls";
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
  // `undefined` while it is being prepared, `null` when it could not be.
  const [report, setReport] = useState<string | null | undefined>(undefined);
  const reportLoad = useRef<Promise<string | null> | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<CommandError | null>(null);
  const [emailWrong, setEmailWrong] = useState(false);
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const failureRef = useRef<HTMLParagraphElement>(null);
  const ids = { attach: useId(), report: useId(), count: useId() };
  const language = i18n.resolvedLanguage ?? i18n.language;

  useEffect(() => {
    let current = true;
    setReport(undefined);
    const load = api.feedbackReport(language).catch(() => null);
    reportLoad.current = load;
    void load.then((text) => current && setReport(text));
    return () => {
      current = false;
    };
  }, [language]);
  // In a low window the form scrolls: a failure comes into view above the buttons.
  useEffect(() => {
    if (failure) failureRef.current?.scrollIntoView({ block: "nearest" });
  }, [failure]);
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
  // A report that could not be prepared is not offered: nothing would be attached.
  const attach = draft.attach && report !== null;

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
      // Sent right after opening: the report the person asked for is waited for, not dropped —
      // but not for ever, the dialog is locked meanwhile.
      const attached = attach ? (report ?? (await withTimeout(reportLoad.current, REPORT_WAIT_MS))) : null;
      await api.sendFeedback({
        kind: draft.kind,
        message: draft.message.trim(),
        email: email || null,
        report: attached,
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
      await navigator.clipboard.writeText(draftText(draft, kindLabel, attach ? (report ?? null) : null));
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  };

  const sentPanel = () => (
    <>
      <div className="flex flex-col items-center gap-2 pt-1 text-center" role="status">
        <span className="mb-2 flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Icon icon={Check} size={22} strokeWidth={2.4} />
        </span>
        <p className="text-lg font-semibold">{t("feedback.sentTitle")}</p>
        <p className="max-w-[360px] text-sm text-muted">{t("feedback.sentBody")}</p>
      </div>
      <footer className="mt-auto flex justify-end pt-1">
        <Button variant="primary" size="lg" autoFocus onClick={onClose}>
          {t("feedback.done")}
        </Button>
      </footer>
    </>
  );

  // The unseen copy has the report shown at its full height and no error. In the form shown, the
  // message takes the room the report, an error or the note under the address leave.
  const formPanel = (sizing: boolean) => {
    const own = sizing ? { attach: undefined, report: undefined, count: undefined } : ids;
    const reportShown = sizing || showReport;
    const wrongEmail = !sizing && emailWrong;
    return (
      <form
        className="flex min-h-0 flex-1 flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {/* In a low window this scrolls and the buttons stay below it. */}
        <div className={sizing ? "flex flex-col gap-4" : "-m-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-1"}>
          <p className="-mt-1 text-sm text-muted">{t("feedback.lead")}</p>
          <div className="flex">
            <Segmented<FeedbackKind>
              label={t("feedback.kind")}
              value={draft.kind}
              onChange={(kind) => change({ kind })}
              options={(["bug", "idea", "question"] as const).map((value) => ({ value, label: t(`feedback.${value}`) }))}
            />
          </div>
          <div className={sizing ? "relative" : "relative flex min-h-24 flex-1 flex-col"}>
            <textarea
              aria-label={t("feedback.message")}
              aria-describedby={own.count}
              aria-invalid={tooLong || undefined}
              autoFocus={!sizing}
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
              className={`field block resize-none pb-6 ${sizing ? "min-h-[132px]" : "min-h-0 flex-1"}`}
            />
            {/* Read with the field, not on every keystroke; going over the limit is said once. */}
            <span id={own.count} className={`pointer-events-none absolute right-3 bottom-2 text-2xs ${tooLong ? "text-danger" : "text-subtle"}`}>
              {t("feedback.count", { count, max: MAX_MESSAGE })}
            </span>
            {!sizing && (
              <span role="status" className="sr-only">
                {tooLong ? t("errors.detail.message_too_long") : ""}
              </span>
            )}
          </div>
          <Field label={t("feedback.email")} error={wrongEmail ? t("errors.detail.invalid_email") : undefined}>
            {(id, note) => (
              <input
                id={id}
                ref={sizing ? undefined : emailRef}
                type="email"
                inputMode="email"
                autoComplete="email"
                value={draft.email}
                disabled={sending}
                placeholder={t("feedback.emailPlaceholder")}
                aria-invalid={wrongEmail || undefined}
                aria-describedby={note}
                onChange={(e) => {
                  setEmailWrong(false);
                  change({ email: e.target.value });
                }}
                className={`field ${wrongEmail ? "border-danger" : ""}`}
              />
            )}
          </Field>
          <div className="flex shrink-0 flex-col gap-1">
            <div className="flex items-center gap-2">
              <input
                id={own.attach}
                type="checkbox"
                checked={attach}
                disabled={sending || report === null}
                onChange={(e) => change({ attach: e.target.checked })}
                className="size-4 shrink-0 accent-accent"
              />
              <label htmlFor={own.attach} className="flex-1 text-sm font-medium">
                {t("feedback.attach")}
              </label>
              <button
                type="button"
                aria-expanded={showReport}
                aria-controls={own.report}
                onClick={() => setShowReport((shown) => !shown)}
                className="text-sm font-medium text-accent hover:underline"
              >
                {showReport ? t("feedback.hideReport") : t("feedback.showReport")}
              </button>
            </div>
            <p className="pl-6 text-xs text-subtle">{report === null ? t("feedback.reportFailed") : t("feedback.attachHint")}</p>
            {reportShown && (
              <pre
                id={own.report}
                aria-label={sizing ? undefined : t("feedback.report")}
                tabIndex={sizing ? undefined : 0}
                className={`mt-2 overflow-auto rounded-lg bg-secondary px-3 py-2.5 font-mono text-2xs leading-4 whitespace-pre-wrap text-icon [overflow-wrap:anywhere] ${sizing ? "h-[160px]" : "max-h-[160px]"}`}
              >
                {sizing ? "" : report === undefined ? "…" : (report ?? t("feedback.reportFailed"))}
              </pre>
            )}
          </div>
          <p className="text-xs text-subtle">
            {t("feedback.privacy")}{" "}
            <button
              type="button"
              onClick={() => void api.openUrl(privacyUrl(language)).catch((err) => setFailure(toCommandError(err)))}
              className="text-accent hover:underline"
            >
              {t("feedback.privacyLink")}
            </button>
          </p>
          {!sizing && failure && (
            <p ref={failureRef} role="alert" className="flex gap-2.5 rounded-xl bg-danger-soft px-3 py-2.5 text-sm text-on-danger-soft">
              <Icon icon={CircleAlert} className="mt-px shrink-0" />
              <span>{describeError(failure)}</span>
            </p>
          )}
        </div>
        <footer className="flex shrink-0 justify-end gap-2">
          <Button variant="outline" size="lg" disabled={sending} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {!sizing && failure ? (
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
    );
  };

  return (
    <Dialog title={t("feedback.title")} onClose={onClose} width={480} locked={sending}>
      <StatePanels value={sent ? "sent" : "form"} states={["form", "sent"] as const}>
        {(shown, sizing) => (shown === "sent" ? !sizing && sentPanel() : formPanel(sizing))}
      </StatePanels>
    </Dialog>
  );
}

/** How long «Send» waits for a report still being prepared before sending without it. */
const REPORT_WAIT_MS = 3000;

function withTimeout<T>(promise: Promise<T | null> | null, ms: number): Promise<T | null> {
  if (!promise) return Promise.resolve(null);
  return Promise.race([promise, new Promise<null>((resolve) => window.setTimeout(() => resolve(null), ms))]);
}
