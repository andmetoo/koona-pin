import type { ReactNode } from "react";
import { CalendarClock, Check, Trash2, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SupporterStatus } from "../types";
import { stillCharges, useAccountDeletion, viaPlay, type DeleteStep } from "./accountDeletion";
import { Icon } from "./icons";
import { longDate } from "./supporterFlow";
import { Button } from "./ui/Button";
import { Field, StatePanels } from "./ui/Controls";
import { Dialog } from "./ui/Dialog";

const STEPS = ["about", "code", "failed", "deleted", "scheduled", "kept"] as const satisfies readonly DeleteStep[];

/**
 * «Delete account» (Google Play's rule, and the owner's): what happens — payments stop, what is
 * deleted and what stays, the library on this computer included — and when, now or at the end of
 * the paid period; a code sent to the account's email confirms it. Then the account is gone (this
 * computer signed out, sync off here), or the date it will be with «Keep my account». One height
 * for every step, as the Supporter dialogs.
 */
export function AccountDeletionDialog({ supporter, onClose }: { supporter: SupporterStatus; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const flow = useAccountDeletion({ supporter });
  const { step, email, plan, canWait, waitUntil, when, setWhen, purpose, deleteAt, code, setCode, codeReady, error, busy, wait } = flow;
  const date = (iso: string | null) => (iso ? longDate(iso, i18n.language) : "");
  const sizingDate = date(new Date(Date.UTC(2027, 8, 30)).toISOString());

  const aboutPanel = (failure: string | null, sizing: boolean) => {
    const choose = canWait || sizing;
    return (
      <div className="flex flex-1 flex-col">
        <p className="text-sm text-muted">{t("deleteAccount.intro", { email: sizing ? "someone.with.a.long.address@example.com" : email })}</p>
        <ul className="mt-3 flex flex-col gap-1.5 text-sm">
          {(sizing || stillCharges(plan)) && <Line>{t("deleteAccount.payments")}</Line>}
          {(sizing || plan) && <Line>{t("deleteAccount.refund")}</Line>}
          {(sizing || viaPlay(plan)) && <Line>{t("deleteAccount.paymentsPlay")}</Line>}
          <Line>{t("deleteAccount.deleted")}</Line>
          <Line>{t("deleteAccount.kept")}</Line>
        </ul>
        {choose && (
          <div role="radiogroup" aria-label={sizing ? undefined : t("deleteAccount.when")} className="mt-4 flex flex-col gap-2">
            <Choice checked={when === "now"} onSelect={() => setWhen("now")} name={t("deleteAccount.now")} hint={t("deleteAccount.nowHint")} />
            <Choice
              checked={when === "period_end"}
              onSelect={() => setWhen("period_end")}
              name={t("deleteAccount.periodEnd")}
              hint={t("deleteAccount.periodEndHint", { date: sizing ? sizingDate : date(waitUntil) })}
            />
          </div>
        )}
        {failure && <FailureNote text={failure} live={!sizing} />}
        <footer className="mt-auto flex items-center justify-end gap-2 pt-5">
          <Button variant="outline" size="lg" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" size="lg" autoFocus disabled={busy} onClick={flow.start}>
            {t("deleteAccount.continue")}
          </Button>
        </footer>
      </div>
    );
  };

  const codeText = (sizing: boolean) =>
    sizing
      ? t("deleteAccount.codeTextLater", { email: "someone.with.a.long.address@example.com", date: sizingDate })
      : purpose === "keep"
        ? t("deleteAccount.codeTextKeep", { email })
        : when === "period_end"
          ? t("deleteAccount.codeTextLater", { email, date: date(waitUntil) })
          : t("deleteAccount.codeText", { email });

  const codePanel = (failure: string | null, sizing: boolean) => (
    <form
      className="flex flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        flow.confirm();
      }}
    >
      <p className="text-sm text-muted">{codeText(sizing)}</p>
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
      <footer className="mt-auto flex justify-end gap-2 pt-5">
        <Button variant="outline" size="lg" type="button" onClick={flow.back}>
          {t("supporter.back")}
        </Button>
        <Button variant="primary" size="lg" type="submit" disabled={busy || !codeReady}>
          {purpose === "keep" ? t("deleteAccount.keep") : t("deleteAccount.delete")}
        </Button>
      </footer>
    </form>
  );

  const failedPanel = (failure: string | null, sizing: boolean) => (
    <div className="flex flex-1 flex-col">
      {failure && <FailureNote text={failure} live={!sizing} first />}
      <footer className="mt-auto flex justify-end gap-2 pt-5">
        <Button variant="outline" size="lg" onClick={onClose}>
          {t("common.close")}
        </Button>
        <Button variant="primary" size="lg" autoFocus disabled={busy} onClick={flow.retry}>
          {t("common.retry")}
        </Button>
      </footer>
    </div>
  );

  /** A result: its mark, its words, its actions. */
  const resultPanel = (icon: typeof Check, text: string, actions: ReactNode, failure: string | null = null, sizing = false) => (
    <div className="flex flex-1 flex-col items-center text-center">
      <span className="mt-2 flex size-14 items-center justify-center rounded-full bg-secondary text-icon">
        <Icon icon={icon} size={24} />
      </span>
      <p role={sizing ? undefined : "status"} className="mt-4 max-w-[400px] text-sm text-muted">
        {text}
      </p>
      {failure && <FailureNote text={failure} live={!sizing} />}
      <footer className="mt-auto flex w-full justify-end gap-2 pt-5">{actions}</footer>
    </div>
  );

  const done = (
    <Button variant="primary" size="lg" autoFocus onClick={onClose}>
      {t("supporter.done")}
    </Button>
  );

  const title = {
    about: t("deleteAccount.title"),
    code: t("deleteAccount.codeTitle"),
    failed: t("deleteAccount.failedTitle"),
    deleted: t("deleteAccount.doneTitle"),
    scheduled: t("deleteAccount.scheduledTitle"),
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
            if (state === "failed") return failedPanel(failure, sizing);
            if (state === "deleted") return resultPanel(Trash2, t("deleteAccount.doneText"), done, null, sizing);
            if (state === "scheduled")
              return resultPanel(
                CalendarClock,
                t("deleteAccount.scheduledText", { date: sizing ? sizingDate : date(deleteAt) }),
                <>
                  <Button variant="outline" size="lg" disabled={busy} onClick={flow.keep}>
                    {t("deleteAccount.keep")}
                  </Button>
                  {done}
                </>,
                failure,
                sizing,
              );
            return resultPanel(Check, t("deleteAccount.keptText", { date: sizing ? sizingDate : date(deleteAt) }), done, null, sizing);
          }}
        </StatePanels>
      </div>
    </Dialog>
  );
}

function Line({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-faint" />
      {children}
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

/** One of the two times, as the plans' cards are chosen. */
function Choice({ checked, onSelect, name, hint }: { checked: boolean; onSelect: () => void; name: string; hint: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
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
