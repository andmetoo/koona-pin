import { useEffect, useRef, useState } from "react";
import { Check, Heart, TriangleAlert } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { PlanInterval, SupporterPrices } from "../types";
import { api } from "../services/api";
import { describeError, toCommandError } from "../services/errors";
import { Icon } from "./icons";
import { Button } from "./ui/Button";
import { Field, StatePanels } from "./ui/Controls";
import { Dialog } from "./ui/Dialog";

/**
 * What a failed request says here: the details of feedback («your text is kept») do not fit, so a
 * network failure is the server that could not be reached.
 */
function failureText(error: unknown, t: TFunction): string {
  const failure = toCommandError(error);
  if (failure.detail === "too_many_messages") return t("supporter.tooManyCodes");
  if (failure.code === "network") return t("supporter.unreachable");
  return describeError(error);
}

/** How often the payment step asks whether the payment went through; only while it is open. */
export const POLL_MS = 3000;
/** Shown before Paddle's own prices arrive, or when they cannot (Р-64: $2 a month, $20 a year). */
const FALLBACK: SupporterPrices = {
  month: { price_id: "", total: "$2", currency: "USD" },
  year: { price_id: "", total: "$20", currency: "USD" },
};
const PERKS = ["sync", "backups", "badge", "early"] as const;
/** «$20.00» → «$20», «20,00 €» → «20 €»: whole prices without their cents, as on the page of prices. */
export const whole = (price: string) => price.replace(/([.,])00(?!\d)/, "");

type Step = "plans" | "waiting" | "thanks";

/**
 * «Support Koona Pin» (NP-066, sheet 45): the plan → the payment in the browser → thank you, one
 * height for all three (NP-118). The payment page asks for the email and the card; the server makes
 * the account from that email and the app is signed in as soon as the payment is seen.
 */
export function SupporterDialog({ sandbox, email, onClose }: { sandbox: boolean; email: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>("plans");
  const [interval, setPlan] = useState<PlanInterval>("year");
  const [prices, setPrices] = useState<SupporterPrices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkout, setCheckout] = useState<string | null>(null);
  const [paidEmail, setPaidEmail] = useState(email);

  useEffect(() => {
    let alive = true;
    api
      .getSupporterPrices()
      .then((p) => alive && setPrices(p))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // The payment step asks every few seconds; closing the dialog or leaving the step stops it. A
  // payment finished after that is picked up at the next start of the app.
  useEffect(() => {
    if (step !== "waiting") return;
    let alive = true;
    const timer = window.setInterval(() => {
      api
        .pollCheckout()
        .then(async (state) => {
          if (!alive) return;
          if (state === "paid") {
            setPaidEmail((await api.getSupporterStatus()).email);
            setStep("thanks");
          } else if (state === "none") {
            setStep("plans");
          }
        })
        .catch(() => {});
    }, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [step]);

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      setCheckout(await api.startCheckout(interval));
      setStep("waiting");
    } catch (err) {
      setError(failureText(err, t));
    } finally {
      setBusy(false);
    }
  };

  const shown = prices ?? FALLBACK;
  const plansPanel = (failure: string | null, sizing: boolean) => (
    <div className="flex flex-1 flex-col">
      <p className="text-sm text-muted">{t("supporter.intro")}</p>
      <ul className="mt-2.5 flex flex-col gap-1.5 text-sm">
        {PERKS.map((perk) => (
          <li key={perk} className="flex items-start gap-2">
            <Icon icon={Check} className="mt-px shrink-0 text-accent" />
            {t(`supporter.perks.${perk}`)}
          </li>
        ))}
      </ul>
      <div role="radiogroup" aria-label={sizing ? undefined : t("supporter.plan")} className="mt-5 grid grid-cols-2 gap-3">
        {(["year", "month"] as const).map((value) => (
          <PlanCard
            key={value}
            checked={interval === value}
            onSelect={() => setPlan(value)}
            name={t(value === "year" ? "supporter.yearly" : "supporter.monthly")}
            price={t(value === "year" ? "supporter.perYear" : "supporter.perMonth", { price: whole(shown[value].total) })}
            badge={value === "year" ? t("supporter.twoMonthsFree") : null}
          />
        ))}
      </div>
      {failure ? (
        <p role="alert" className="mt-3 flex gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-xs leading-[17px] text-on-danger-soft">
          <Icon icon={TriangleAlert} size={14} className="mt-px shrink-0" />
          {failure}
        </p>
      ) : (
        <p className="mt-3 text-xs leading-[17px] text-muted">{t("supporter.paddleHint")}</p>
      )}
      <footer className="mt-auto flex justify-end gap-2 pt-5">
        <Button variant="outline" size="lg" onClick={onClose}>
          {t("supporter.notNow")}
        </Button>
        <Button variant="primary" size="lg" autoFocus disabled={busy} onClick={() => void pay()}>
          {failure ? t("common.retry") : t("supporter.continue")}
        </Button>
      </footer>
    </div>
  );

  const waitingPanel = () => (
    <div className="flex flex-1 flex-col">
      <p className="text-sm text-muted">{t("supporter.waitingText")}</p>
      <div className="mt-4 flex items-center gap-2.5 rounded-lg bg-secondary px-4 py-3 text-sm">
        <span aria-hidden className="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-line border-t-accent dark:border-border dark:border-t-accent" />
        <span role="status" className="flex-1">
          {t("supporter.waiting")}
        </span>
        <button
          type="button"
          disabled={!checkout}
          onClick={() => checkout && void api.openCheckout(checkout).catch((err) => setError(failureText(err, t)))}
          className="font-medium text-accent hover:underline"
        >
          {t("supporter.openAgain")} ↗
        </button>
      </div>
      <footer className="mt-auto flex justify-end gap-2 pt-5">
        <Button variant="outline" size="lg" autoFocus onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </footer>
    </div>
  );

  const thanksPanel = (who: string | null) => (
    <div className="flex flex-1 flex-col items-center text-center">
      <span className="mt-2 flex size-14 items-center justify-center rounded-full bg-season-soft text-season">
        <Heart size={24} fill="currentColor" aria-hidden />
      </span>
      <p className="mt-4 max-w-[400px] text-sm text-muted">{t("supporter.thanksText", { email: who ?? "", place: `${t("nav.settings")} → ${t("plan.header")}` })}</p>
      <footer className="mt-auto flex w-full justify-end gap-2 pt-5">
        <Button variant="primary" size="lg" autoFocus onClick={onClose}>
          {t("supporter.done")}
        </Button>
      </footer>
    </div>
  );

  const title = { plans: t("supporter.title"), waiting: t("supporter.waitingTitle"), thanks: t("supporter.thanksTitle") }[step];
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={480}
      badge={
        sandbox && step === "plans" ? (
          <span className="rounded-full bg-amber-soft px-2 py-px text-2xs font-medium text-on-amber-soft">{t("supporter.testPayments")}</span>
        ) : null
      }
    >
      <StatePanels value={step} states={["plans", "waiting", "thanks"] as const}>
        {(state, sizing) => {
          if (state === "plans") return plansPanel(sizing ? t("supporter.unreachable") : error, sizing);
          if (state === "waiting") return waitingPanel();
          return thanksPanel(sizing ? "someone.with.a.long.address@example.com" : paidEmail);
        }}
      </StatePanels>
    </Dialog>
  );
}

function PlanCard({
  checked,
  onSelect,
  name,
  price,
  badge,
}: {
  checked: boolean;
  onSelect: () => void;
  name: string;
  price: string;
  badge: string | null;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={`flex flex-col gap-1.5 rounded-[10px] px-3.5 py-3 text-left transition-colors duration-150 ${
        checked ? "bg-accent-soft shadow-[inset_0_0_0_1.5px_var(--np-accent)]" : "border border-border bg-card hover:bg-hover"
      }`}
    >
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className={`flex size-4 shrink-0 items-center justify-center rounded-full ${checked ? "bg-accent" : "border-[1.5px] border-faint"}`}
        >
          {checked && <span className="size-1.5 rounded-full bg-on-accent" />}
        </span>
        <span className="flex-1 text-sm font-medium whitespace-nowrap">{name}</span>
        {badge && <span className="rounded-full bg-card px-2 py-px text-2xs font-medium whitespace-nowrap text-accent">{badge}</span>}
      </span>
      <span className="pl-6 text-lg font-semibold">{price}</span>
    </button>
  );
}

type SignInStep = "email" | "code";

/**
 * «Sign in as a Supporter» on another computer (sheet 45): the email of the payment, then the code
 * Supabase sends to it. Opened from Settings → Plan.
 */
export function SignInDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [step, setStep] = useState<SignInStep>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const timer = useRef<number | null>(null);

  useEffect(() => () => void (timer.current && window.clearInterval(timer.current)), []);
  const countdown = () => {
    setWait(60);
    if (timer.current) window.clearInterval(timer.current);
    timer.current = window.setInterval(() => setWait((left) => Math.max(0, left - 1)), 1000);
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(failureText(err, t));
    } finally {
      setBusy(false);
    }
  };
  const send = () =>
    run(async () => {
      await api.sendSignInCode(email);
      setCode("");
      setStep("code");
      countdown();
    });
  const verify = () =>
    run(async () => {
      await api.verifySignInCode(email, code);
      onClose();
    });

  const emailPanel = (failure: string | null, sizing: boolean) => (
    <form
      className="flex flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <p className="text-sm text-muted">{t("supporter.signInText")}</p>
      <div className="mt-4">
        {sizing ? (
          <SizingField label={t("supporter.email")} note={failure} />
        ) : (
        <Field label={t("supporter.email")} error={failure ?? undefined}>
          {(id, describedBy) => (
            <input
              id={id}
              aria-describedby={describedBy}
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="field"
            />
          )}
        </Field>
        )}
      </div>
      <footer className="mt-auto flex justify-end gap-2 pt-5">
        <Button variant="outline" size="lg" type="button" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" size="lg" type="submit" disabled={busy || !email.trim()}>
          {t("supporter.sendCode")}
        </Button>
      </footer>
    </form>
  );

  const codePanel = (failure: string | null, sizing: boolean) => (
    <form
      className="flex flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void verify();
      }}
    >
      <p className="text-sm text-muted">{t("supporter.codeText", { email })}</p>
      <div className="mt-4">
        {sizing ? (
          <SizingField label={t("supporter.code")} note={failure} />
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
      <p className="mt-3 flex gap-2 text-sm">
        {wait > 0 ? (
          <span className="text-subtle">{t("supporter.sendAgainIn", { time: `0:${String(wait).padStart(2, "0")}` })}</span>
        ) : (
          <button type="button" disabled={busy} onClick={() => void send()} className="font-medium text-accent hover:underline">
            {t("supporter.sendAgain")}
          </button>
        )}
        <span aria-hidden className="text-subtle">
          ·
        </span>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setStep("email");
          }}
          className="font-medium text-accent hover:underline"
        >
          {t("supporter.anotherEmail")}
        </button>
      </p>
      <footer className="mt-auto flex justify-end gap-2 pt-5">
        <Button variant="outline" size="lg" type="button" onClick={() => setStep("email")}>
          {t("supporter.back")}
        </Button>
        <Button variant="primary" size="lg" type="submit" disabled={busy || code.replace(/\D/g, "").length < 6}>
          {t("supporter.signIn")}
        </Button>
      </footer>
    </form>
  );

  return (
    <Dialog title={step === "email" ? t("supporter.signInTitle") : t("supporter.codeTitle")} onClose={onClose} width={480}>
      <StatePanels value={step} states={["email", "code"] as const}>
        {(state, sizing) =>
          state === "email"
            ? emailPanel(sizing ? t("errors.detail.not_supporter") : error, sizing)
            : codePanel(sizing ? t("errors.detail.wrong_code") : error, sizing)
        }
      </StatePanels>
    </Dialog>
  );
}

/** A field's room in the unseen sizing copy: no label element, no input, so tests find one field. */
function SizingField({ label, note }: { label: string; note: string | null }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium">{label}</p>
      <div className="field">&nbsp;</div>
      {note && <p className="text-xs">{note}</p>}
    </div>
  );
}