import "../you/you.css";
import "./supporter.css";
import { BookOpen, ExternalLink, Heart, RefreshCw } from "lucide-react";
import { capabilities } from "../../../platform/capabilities";
import { planBadge, planName, priceLine, useSupporterPurchase } from "../../../components/supporterFlow";
import { usePhone } from "../PhoneContext";
import { Button } from "../ui/buttons";
import { Sheet, useCloseSheet } from "../ui/Sheet";
import { Shelf, ShelfRow } from "../ui/Shelf";
import { Note, SeasonHeart } from "./parts";

export type SupporterSheetProps = Record<string, never>;

/**
 * Supporter on a phone (NP-072b; `app.surface` "supporter"): what it gives on a phone — sync with
 * the person's computers, the reader's Paper and Sepia, the heart — and what stays free. A build that
 * sells nothing here (`purchase: "none"`: the Play build until NP-154) shows the perks and the sign-in
 * of someone who is a Supporter already, and nothing about buying. One that sells through Paddle (the
 * site's APK) adds the desktop's purchase: the plan, Continue to the checkout in the browser, the
 * waiting step, thank you.
 */
export function SupporterSheet(_: { props: SupporterSheetProps }) {
  return capabilities.purchase === "paddle" ? <PurchaseSheet /> : <PerksSheet />;
}

/** The sheet where nothing is sold: the perks and "I'm already a Supporter". */
function PerksSheet() {
  const { app } = usePhone();
  const { t, setSurface } = app;
  return (
    <Sheet
      label={t("phone.supporter.title")}
      title={t("phone.supporter.title")}
      className="sp-sheet"
      footer={
        <Button kind="primary" block onClick={() => setSurface("signIn")}>
          {t("plan.already")}
        </Button>
      }
    >
      <Perks />
    </Sheet>
  );
}

/**
 * The hero card, the perks on a phone and what stays free. The purchase leaves the hero out: the
 * plans need the room.
 */
function Perks({ hero = true }: { hero?: boolean }) {
  const { app } = usePhone();
  const { t } = app;
  return (
    <>
      {hero && (
        <div className="ys-card ys-supporter sp-hero">
          <SeasonHeart />
          <span className="ys-supporter-text">
            <span className="ph-headline">{t("phone.supporter.lead")}</span>
            <span className="ph-meta">{t("phone.supporter.leadText")}</span>
          </span>
        </div>
      )}
      <section className="ys-section" data-supporter-perks>
        <h3 className="ys-label">{t("phone.supporter.perksLabel")}</h3>
        <Shelf className="ys-shelf sp-shelf">
          <ShelfRow icon={RefreshCw} title={t("phone.supporter.perk.sync")} subtitle={t("phone.supporter.perk.syncHint")} />
          <ShelfRow icon={BookOpen} title={t("phone.supporter.perk.reading")} subtitle={t("phone.supporter.perk.readingHint")} />
          <ShelfRow className="sp-heart-row" icon={Heart} title={t("phone.supporter.perk.badge")} subtitle={t("phone.supporter.perk.badgeHint")} />
        </Shelf>
      </section>
      <section className="ys-section" data-supporter-free>
        <h3 className="ys-label">{t("phone.supporter.freeLabel")}</h3>
        <p className="ys-card sp-free">{t("phone.supporter.freeText")}</p>
      </section>
    </>
  );
}

/** The sheet of a build that sells through Paddle: the desktop's purchase steps, drawn for a phone. */
function PurchaseSheet() {
  const { app } = usePhone();
  const { t, supporter, setSurface } = app;
  const close = useCloseSheet();
  const purchase = useSupporterPurchase({
    email: supporter?.email ?? null,
    awaitingSignIn: !!supporter?.awaiting_sign_in,
    paid: !!supporter?.plan,
    planUnknown: !!supporter?.plan_unknown,
    onClose: close,
  });
  const { step, interval, setPlan, shown, plans, pay, openAgain, busy, error, checkout, paidEmail } = purchase;
  const signIn = () => setSurface("signIn");

  if (step === "waiting")
    return (
      <Sheet
        label={t("supporter.waitingTitle")}
        title={t("supporter.waitingTitle")}
        className="sp-sheet"
        footer={
          <Button kind="clear" block onClick={close}>
            {t("common.cancel")}
          </Button>
        }
      >
        <p className="sp-text">{t("phone.supporter.waitingText")}</p>
        <div className="ys-card sp-waiting">
          <span className="sp-spinner" aria-hidden="true" />
          <span role="status" className="sp-waiting-text">
            {t("supporter.waiting")}
          </span>
        </div>
        <Button kind="ghost" compact icon={ExternalLink} className="sp-open-again" disabled={!checkout} onClick={openAgain}>
          {t("supporter.openAgain")}
        </Button>
        {error && <Note tone="danger">{error}</Note>}
      </Sheet>
    );

  if (step === "thanks" || step === "signIn") {
    const thanks = step === "thanks";
    return (
      <Sheet
        label={t(thanks ? "supporter.thanksTitle" : "supporter.paidTitle")}
        className="sp-sheet"
        footer={
          thanks ? (
            <Button kind="primary" block onClick={close}>
              {t("supporter.done")}
            </Button>
          ) : (
            <div className="sp-actions">
              <Button kind="clear" onClick={close}>
                {t("supporter.notNow")}
              </Button>
              <Button kind="primary" onClick={signIn}>
                {t("supporter.signIn")}
              </Button>
            </div>
          )
        }
      >
        <div className="sp-done" data-supporter-step={step}>
          <SeasonHeart size={64} />
          <h2 className="ph-title2">{t(thanks ? "supporter.thanksTitle" : "supporter.paidTitle")}</h2>
          <p className="sp-text">{thanks ? t("phone.supporter.thanksText", { email: paidEmail ?? "" }) : t("supporter.paidSignInText")}</p>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      label={t("phone.supporter.title")}
      title={t("phone.supporter.title")}
      subtitle={supporter?.sandbox ? <span className="sp-test">{t("supporter.testPayments")}</span> : undefined}
      className="sp-sheet"
      footer={
        <div className="sp-footer">
          <Button kind="primary" block disabled={busy} onClick={() => void pay()}>
            {error ? t("common.retry") : t("supporter.continue")}
          </Button>
          <Button kind="clear" block onClick={signIn}>
            {t("plan.already")}
          </Button>
        </div>
      }
    >
      <Perks hero={false} />
      <section className="ys-section">
        <h3 className="ys-label">{t("phone.supporter.planLabel")}</h3>
        <div role="radiogroup" aria-label={t("supporter.plan")} aria-busy={!shown || undefined} className="sp-plans">
          {plans.map((value) => {
            const price = shown?.[value];
            const badge = planBadge(value, t);
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={interval === value}
                className="sp-plan"
                onClick={() => setPlan(value)}
              >
                <span className="sp-radio" aria-hidden="true" />
                <span className="sp-plan-text">
                  <span className="sp-plan-name">{planName(value, t)}</span>
                  <span className="sp-plan-price">{price ? priceLine(value, price.total, t) : <span className="sp-pending" aria-hidden="true" />}</span>
                </span>
                {badge && <span className="sp-plan-badge">{badge}</span>}
              </button>
            );
          })}
        </div>
        {error ? (
          <Note tone="danger">{error}</Note>
        ) : supporter?.plan_unknown && supporter.email ? (
          // Signed in, but the plan could not be checked: a Supporter must not buy it twice.
          <Note tone="amber">{t("supporter.planUnknownNotice", { email: supporter.email })}</Note>
        ) : (
          <p className="sp-hint">{t("phone.supporter.paddleHint")}</p>
        )}
      </section>
    </Sheet>
  );
}

