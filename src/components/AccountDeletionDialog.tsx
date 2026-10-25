import type { ReactNode } from "react";
import { Check, Heart, TriangleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DeleteWhen, SupporterStatus } from "../types";
import { cancelsPlay, radioKeys, useAccountDeletion, type DeleteStep } from "./accountDeletion";
import { Icon } from "./icons";
import { longDate } from "./supporterFlow";
import { Button } from "./ui/Button";
import { Field, StatePanels } from "./ui/Controls";
import { Dialog } from "./ui/Dialog";

const STEPS = ["about", "code", "when", "confirm", "failed", "unknown", "signedOut", "deleted", "scheduled", "kept"] as const satisfies readonly DeleteStep[];
const TIMES = ["now", "period_end"] as const satisfies readonly DeleteWhen[];
const LONG_EMAIL = "someone.with.a.long.address@example.com";
/** The one destructive button is red (D4), the owner's exception to red for errors. */
const RED = "!bg-danger !text-on-accent";

/**
 * «Delete account» (Google Play's rule, and the owner's), the phone's frames D2–D7 on a desktop: what
 * is deleted and what stays — the library on this computer included — then, with a sign-in by code
 * when the one here is too old, when (only while the server says paid time is left), then the one
 * red button. Then the account is gone (signed out here, sync off), or the date it will be with
 * «Keep my account». One height for every step, as the Supporter dialogs.
 */
export function AccountDeletionDialog({ supporter, onClose }: { supporter: SupporterStatus; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const flow = useAccountDeletion({ supporter });
  const { step, email, plan, waitUntil, when, setWhen, purpose, deleteAt, code, setCode, codeReady, error, failure: failed, busy, wait } = flow;
  const date = (iso: string | null) => (iso ? longDate(iso, i18n.language) : "");
  const sizingDate = date(new Date(Date.UTC(2027, 8, 30)).toISOString());
  const footer = (children: ReactNode) => <footer className="mt-auto flex items-center justify-end gap-2 pt-5">{children}</footer>;
  const backButton = (
    <Button variant="outline" size="lg" type="button" onClick={flow.back}>
      {t("supporter.back")}
    </Button>
  );

  const aboutPanel = (failure: string | null, sizing: boolean) => (
    <div className="flex flex-1 flex-col">
      <Group label={t("deleteAccount.deletedLabel")}>
        <Item gone title={t("deleteAccount.account")} hint={sizing ? LONG_EMAIL : email} />
        <Item gone title={t("deleteAccount.purchases")} hint={t("deleteAccount.purchasesHint")} />
        <Item gone title={t("deleteAccount.sync")} hint={t("deleteAccount.syncHint")} />
      </Group>
      <Group label={t("deleteAccount.staysLabel")}>
        <Item title={t("deleteAccount.library")} hint={t("deleteAccount.libraryHintComputer")} />
        <Item title={t("deleteAccount.records")} hint={t("deleteAccount.recordsHint")} />
      </Group>
      {(plan || sizing) && (
        <p className="mt-4 text-sm text-muted">
          {[t("deleteAccount.payments"), cancelsPlay(plan) || sizing ? t("deleteAccount.paymentsPlay") : null, t("deleteAccount.refund")].filter(Boolean).join(" ")}
        </p>
      )}
      {failure && <FailureNote text={failure} live={!sizing} />}
      {footer(
        <>
          <Button variant="outline" size="lg" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" size="lg" autoFocus disabled={busy} onClick={flow.start}>
            {t("deleteAccount.continue")}
          </Button>
        </>,
      )}
    </div>
  );

  const codePanel = (failure: string | null, sizing: boolean) => {
    const keep = purpose === "keep" && !sizing;
    return (
      <form
        className="flex flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          flow.confirm();
        }}
      >
        <p className="text-sm text-muted">{t(keep ? "deleteAccount.codeTextKeep" : "deleteAccount.codeTextContinue", { email: sizing ? LONG_EMAIL : email })}</p>
        <div className="mt-4">
          {sizing ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium">{t("supporter.code")}</p>
              <div className="field">&nbsp;</div>
              {failure && <p className="text-xs">{failure}</p>}
            </div>
          ) : (
            <Field label={t("supporter.code")} error={failure ?? undefined}>
              {(id, describedBy) => (
                <input
                  id={id}
                  aria-describedby={describedBy}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  maxLength={7}
                  style={{ width: 180 }}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className={`field text-[15px] font-medium tracking-[2px] ${failure ? "border-danger" : ""}`}
                />
              )}
            </Field>
          )}
        </div>
        <p className="mt-3 text-sm">
          {wait > 0 ? (
            <span className="text-subtle">{t("supporter.sendAgainIn", { time: `0:${String(wait).padStart(2, "0")}` })}</span>
          ) : (
            <button type="button" disabled={busy} onClick={flow.resend} className="font-medium text-accent hover:underline">
              {t("supporter.sendAgain")}
            </button>
          )}
        </p>
        {footer(
          <>
            {backButton}
            <Button variant="primary" size="lg" type="submit" disabled={busy || !codeReady}>
              {keep ? t("deleteAccount.keep") : t("deleteAccount.continue")}
            </Button>
          </>,
        )}
      </form>
    );
  };

  const whenPanel = (failure: string | null, sizing: boolean) => {
    const until = sizing ? sizingDate : date(waitUntil);
    return (
      <div className="flex flex-1 flex-col">
        <p className="text-sm text-muted">{t("deleteAccount.paidUntil", { date: until })}</p>
        <div role="radiogroup" aria-label={sizing ? undefined : t("deleteAccount.whenTitle")} onKeyDown={radioKeys(TIMES, when, setWhen)} className="mt-4 flex flex-col gap-2">
          <Choice checked={when === "now"} onSelect={() => setWhen("now")} name={t("deleteAccount.now")} hint={t("deleteAccount.nowHint")} />
          <Choice
            checked={when === "period_end"}
            onSelect={() => setWhen("period_end")}
            name={t("deleteAccount.periodEnd")}
            hint={t("deleteAccount.periodEndHint", { date: until })}
          />
        </div>
        <p className="mt-4 text-sm text-muted">{t("deleteAccount.eitherWay")}</p>
        {failure && <FailureNote text={failure} live={!sizing} />}
        {footer(
          <>
            {backButton}
            <Button variant="primary" size="lg" autoFocus disabled={busy} onClick={flow.toConfirm}>
              {t("deleteAccount.continue")}
            </Button>
          </>,
        )}
      </div>
    );
  };

  const confirmPanel = (failure: string | null, sizing: boolean) => (
    <div className="flex flex-1 flex-col">
      <p className="text-sm text-muted">
        {when === "period_end" && !sizing ? t("deleteAccount.confirmLater", { date: date(waitUntil) }) : t("deleteAccount.confirmNow")}
      </p>
      {failure && <FailureNote text={failure} live={!sizing} />}
      {footer(
        <>
          {backButton}
          <Button variant="primary" size="lg" disabled={busy} onClick={flow.remove} className={RED}>
            {t("deleteAccount.delete")}
          </Button>
        </>,
      )}
    </div>
  );

  const failedPanel = (failure: string | null, sizing: boolean) => (
    <div className="flex flex-1 flex-col">
      {failed === "payments" || sizing ? (
        <p role={sizing ? undefined : "alert"} className="text-sm text-muted">
          {t("deleteAccount.failedText")}
        </p>
      ) : (
        failure && <FailureNote text={failure} live first />
      )}
      {footer(
        <>
          <Button variant="outline" size="lg" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" size="lg" autoFocus disabled={busy} onClick={flow.retry}>
            {t("common.retry")}
          </Button>
        </>,
      )}
    </div>
  );

  const unknownPanel = (failure: string | null, sizing: boolean) => (
    <div className="flex flex-1 flex-col">
      <p role={sizing ? undefined : "status"} className="text-sm text-muted">
        {t("deleteAccount.unknownText")}
      </p>
      {failure && <FailureNote text={failure} live={!sizing} />}
      {footer(
        <>
          <Button variant="outline" size="lg" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button variant="primary" size="lg" autoFocus disabled={busy} onClick={flow.check}>
            {t("deleteAccount.checkAgain")}
          </Button>
        </>,
      )}
    </div>
  );

  const done = (
    <Button variant="primary" size="lg" autoFocus onClick={onClose}>
      {t("supporter.done")}
    </Button>
  );

  const scheduledPanel = (failure: string | null, sizing: boolean) => {
    const on = sizing ? sizingDate : date(deleteAt);
    return (
      <div className="flex flex-1 flex-col">
        <p className="text-sm text-muted">{t("deleteAccount.scheduledLead")}</p>
        {(plan || sizing) && (
          <div className="mt-4 flex items-center gap-3.5 rounded-[10px] border border-border px-3.5 py-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-season-soft text-season">
              <Heart size={20} fill="currentColor" aria-hidden />
            </span>
            <div className="min-w-0 text-xs leading-[17px]">
              <p className="text-[15px] leading-5 font-semibold text-ink">
                {t(plan?.interval === "lifetime" ? "plan.lifetime" : plan?.interval === "month" ? "plan.monthly" : "plan.yearly")}
              </p>
              <p className="truncate text-muted">{sizing ? LONG_EMAIL : email}</p>
              <p className="text-muted">{t("deleteAccount.endsOn", { date: on })}</p>
            </div>
          </div>
        )}
        <p className="mt-4 text-sm text-muted">{t("deleteAccount.scheduledText")}</p>
        <p className="mt-2 text-sm text-muted">{t("deleteAccount.buyKeeps")}</p>
        {failure && <FailureNote text={failure} live={!sizing} />}
        {footer(
          <>
            <button type="button" disabled={busy} onClick={flow.deleteNow} className="mr-auto text-sm font-medium text-muted hover:text-ink">
              {t("deleteAccount.deleteNowInstead")}
            </button>
            <Button variant="outline" size="lg" disabled={busy} onClick={flow.keep}>
              {t("deleteAccount.keep")}
            </Button>
            {done}
          </>,
        )}
      </div>
    );
  };

  const textPanel = (text: string, sizing: boolean) => (
    <div className="flex flex-1 flex-col">
      <p role={sizing ? undefined : "status"} className="text-sm text-muted">
        {text}
      </p>
      {footer(done)}
    </div>
  );

  const title = {
    about: t("deleteAccount.title"),
    code: purpose === "keep" ? t("deleteAccount.keepCodeTitle") : t("supporter.codeTitle"),
    when: t("deleteAccount.whenTitle"),
    confirm: t("deleteAccount.codeTitle"),
    failed: failed === "payments" ? t("deleteAccount.failedTitle") : t("deleteAccount.notDeletedTitle"),
    unknown: t("deleteAccount.unknownTitle"),
    signedOut: t("deleteAccount.signedOutTitle"),
    deleted: t("deleteAccount.doneTitle"),
    scheduled: t("deleteAccount.scheduledTitle", { date: date(deleteAt) }),
    kept: t("deleteAccount.keptTitle"),
  }[step];

  return (
    <Dialog title={title} onClose={onClose} width={480} locked={busy}>
      <div className="contents" data-delete-step={step}>
        <StatePanels value={step} states={STEPS}>
          {(state, sizing) => {
            const failure = sizing ? t("errors.detail.payments_not_stopped") : error;
            if (state === "about") return aboutPanel(failure, sizing);
            if (state === "code") return codePanel(failure, sizing);
            if (state === "when") return whenPanel(failure, sizing);
            if (state === "confirm") return confirmPanel(failure, sizing);
            if (state === "failed") return failedPanel(failure, sizing);
            if (state === "unknown") return unknownPanel(failure, sizing);
            if (state === "scheduled") return scheduledPanel(failure, sizing);
            if (state === "deleted") return textPanel(t("deleteAccount.doneTextComputer"), sizing);
            if (state === "signedOut") return textPanel(t("deleteAccount.signedOutText"), sizing);
            return textPanel(t("deleteAccount.keptText", { date: sizing ? sizingDate : date(deleteAt) }), sizing);
          }}
        </StatePanels>
      </div>
    </Dialog>
  );
}

/** «Deleted» or «Stays»: a small label over its lines. */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mt-1 mb-3 last-of-type:mb-0">
      <h3 className="text-2xs font-semibold text-subtle uppercase">{label}</h3>
      <ul className="mt-2 flex flex-col gap-2.5">{children}</ul>
    </section>
  );
}

/** A thing deleted (a cross) or kept (a tick), with what it is. */
function Item({ title, hint, gone = false }: { title: string; hint: string; gone?: boolean }) {
  return (
    <li className="flex items-center gap-3">
      <span className={`flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary ${gone ? "text-icon" : "text-accent"}`}>
        <Icon icon={gone ? X : Check} size={14} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block truncate text-xs leading-[17px] text-muted">{hint}</span>
      </span>
    </li>
  );
}

function FailureNote({ text, live, first = false }: { text: string; live: boolean; first?: boolean }) {
  return (
    <p role={live ? "alert" : undefined} className={`${first ? "" : "mt-3"} flex gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-left text-xs leading-[17px] text-on-danger-soft`}>
      <Icon icon={TriangleAlert} size={14} className="mt-px shrink-0" />
      {text}
    </p>
  );
}

/** One of the two times, as the plans' cards are chosen; the chosen one is the group's Tab stop. */
function Choice({ checked, onSelect, name, hint }: { checked: boolean; onSelect: () => void; name: string; hint: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      tabIndex={checked ? 0 : -1}
      onClick={onSelect}
      className={`flex items-start gap-2.5 rounded-[10px] px-3.5 py-2.5 text-left transition-colors duration-150 ${
        checked ? "bg-accent-soft shadow-[inset_0_0_0_1.5px_var(--np-accent)]" : "border border-border bg-card hover:bg-hover"
      }`}
    >
      <span aria-hidden className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ${checked ? "bg-accent" : "border-[1.5px] border-faint"}`}>
        {checked && <span className="size-1.5 rounded-full bg-on-accent" />}
      </span>
      <span className="flex flex-col">
        <span className="text-sm font-medium">{name}</span>
        <span className="text-xs leading-[17px] text-muted">{hint}</span>
      </span>
    </button>
  );
}
