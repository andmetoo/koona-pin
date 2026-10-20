import "../you/you.css";
import "./supporter.css";
import { useId } from "react";
import { BookOpen, ExternalLink, Heart, RefreshCw } from "lucide-react";
import { capabilities } from "../../../platform/capabilities";
import { planBadge, planName, priceLine, useSupporterPurchase } from "../../../components/supporterFlow";
import { usePhone } from "../PhoneContext";
import { Button } from "../ui/buttons";
import { Sheet, useCloseSheet } from "../ui/Sheet";
import { Shelf, ShelfRow } from "../ui/Shelf";
import { CodeForm, Note, SeasonHeart } from "./parts";
import { playBadge, playPlans, playPriceLine, usePlayPurchase } from "./playFlow";

export type SupporterSheetProps = Record<string, never>;

/**
 * Supporter on a phone (NP-072b; `app.surface` "supporter"): what it gives on a phone — sync with
 * the person's computers, the reader's Paper and Sepia, the heart — and what stays free. A build that
 * sells nothing here (`purchase: "none"`) shows the perks and the sign-in of someone who is a
 * Supporter already, and nothing about buying. One that sells through Paddle (the site's APK) adds
 * the desktop's purchase: the plan, Continue to the checkout in the browser, the waiting step, thank
 * you. The Play build (`purchase: "play"`, NP-154) sells through Google Play Billing.
 */
export function SupporterSheet(_: { props: SupporterSheetProps }) {
  return capabilities.purchase === "paddle" ? <PurchaseSheet /> : capabilities.purchase === "play" ? <PlaySheet /> : <PerksSheet />;
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

/**
 * The sheet of the Play build (NP-154): "I'm already a Supporter" first, so a Supporter does not
 * buy again; the perks; the plans at Google Play's prices, each with its own button, and under them
 * what a subscription does (it renews until cancelled in Google Play; five years are paid once).
 * After Play's sheet, the server's verdict leads on: thanks; the email that claims the purchase and
 * the code sent to it; a slow payment; a Supporter buying again; a purchase that belongs to another
 * account; a failure under the plans. A purchase still waiting when the sheet opens resumes its step.
 * Nothing names where else Supporter is sold.
 */
function PlaySheet() {
  const { app } = usePhone();
  const { t, supporter, setSurface } = app;
  const close = useCloseSheet();
  const formId = useId();
  const purchase = usePlayPurchase(supporter);
  const { step, error, busy, offer, offerFailed, askOffer, last, buy, email, setEmail, claim, code, setCode, verify, resend, wait, anotherEmail, codeReady, suspended, fixPayment } = purchase;
  const signIn = () => setSurface("signIn");

  if (step === "email" || step === "code") {
    const onEmail = step === "email";
    const title = t(onEmail ? "phone.supporter.play.emailTitle" : "supporter.codeTitle");
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
              <Button kind="clear" onClick={anotherEmail}>
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
          step={step}
          text={onEmail ? t("phone.supporter.play.emailText") : t("phone.supporter.play.codeText", { email: email.trim() })}
          email={email}
          onEmail={setEmail}
          code={code}
          onCode={setCode}
          error={error}
          busy={busy}
          wait={wait}
          onSubmit={() => void (onEmail ? claim() : verify())}
          onResend={() => void resend()}
          onAnotherEmail={anotherEmail}
        />
      </Sheet>
    );
  }

  if (step === "pending")
    return (
      <Sheet
        label={t("phone.supporter.play.pendingTitle")}
        title={t("phone.supporter.play.pendingTitle")}
        className="sp-sheet"
        footer={
          <Button kind="clear" block onClick={close}>
            {t("common.close")}
          </Button>
        }
      >
        <p className="sp-text">{t("phone.supporter.play.pendingText")}</p>
        <div className="ys-card sp-waiting" data-play-step="pending">
          <span className="sp-spinner" aria-hidden="true" />
          <span role="status" className="sp-waiting-text">
            {t("phone.supporter.play.pending")}
          </span>
        </div>
      </Sheet>
    );

  if (step !== "plans" && step !== "suspended") {
    // How the purchase ended: thanks, a Supporter already (Play refunds it), or an account to sign in to.
    const ended = {
      paid: { title: t("supporter.thanksTitle"), text: t("phone.supporter.play.thanksText", { email: supporter?.email ?? email.trim() }) },
      alreadySupporter: { title: t("phone.supporter.play.alreadyTitle"), text: t("phone.supporter.play.alreadyText") },
      otherAccount: { title: t("phone.supporter.play.otherTitle"), text: t("phone.supporter.play.otherText") },
      owner: { title: t("phone.supporter.play.ownerTitle"), text: t("phone.supporter.play.ownerText") },
    }[step];
    const toSignIn = step === "otherAccount" || step === "owner";
    return (
      <Sheet
        label={ended.title}
        className="sp-sheet"
        footer={
          toSignIn ? (
            <div className="sp-actions">
              <Button kind="clear" onClick={close}>
                {t("supporter.notNow")}
              </Button>
              <Button kind="primary" onClick={signIn}>
                {t("supporter.signIn")}
              </Button>
            </div>
          ) : (
            <Button kind="primary" block onClick={close}>
              {t("supporter.done")}
            </Button>
          )
        }
      >
        <div className="sp-done" data-play-step={step}>
          {!toSignIn && <SeasonHeart size={64} />}
          <h2 className="ph-title2">{ended.title}</h2>
          <p className="sp-text">{ended.text}</p>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet label={t("phone.supporter.title")} title={t("phone.supporter.title")} className="sp-sheet">
      <Button kind="clear" block className="sp-already" onClick={signIn}>
        {t("plan.already")}
      </Button>
      <Perks hero={false} />
      <section className="ys-section">
        <h3 className="ys-label">{t("phone.supporter.planLabel")}</h3>
        {suspended ? (
          // The account's subscription is on hold or paused: its payment is fixed in Google Play,
          // where Google sends such a subscriber, never bought again.
          <div className="sp-play-failure" data-play-step="suspended">
            <Note tone="amber">{t("phone.supporter.play.suspended")}</Note>
            <Button kind="primary" icon={ExternalLink} disabled={busy} onClick={() => void fixPayment()}>
              {t("plan.fixInPlay")}
            </Button>
            {error && <Note tone="danger">{error}</Note>}
          </div>
        ) : offer && !offer.available ? (
          <Note tone="amber">{t("phone.supporter.play.notAvailable")}</Note>
        ) : offerFailed && !offer ? (
          <div className="sp-play-failure">
            <Note tone="danger">{t("phone.supporter.play.offerFailed")}</Note>
            <Button kind="ghost" compact className="sp-open-again" onClick={askOffer}>
              {t("common.retry")}
            </Button>
          </div>
        ) : (
          <>
            <ul aria-label={t("supporter.plan")} aria-busy={!offer || undefined} className="sp-plans sp-play-plans">
              {playPlans(offer).map((value) => {
                const price = offer?.[value];
                const badge = playBadge(value, offer, t);
                const name = planName(value, t);
                const action = t(value === "five_years" ? "phone.supporter.play.buy" : "phone.supporter.play.subscribe");
                return (
                  <li key={value} className="sp-plan" data-play-plan={value}>
                    <span className="sp-plan-text">
                      <span className="sp-plan-name">
                        {name}
                        {badge && <span className="sp-plan-badge">{badge}</span>}
                      </span>
                      <span className="sp-plan-price">{price ? playPriceLine(value, price, t) : <span className="sp-pending" aria-hidden="true" />}</span>
                    </span>
                    <Button
                      kind="soft"
                      compact
                      disabled={busy || !price}
                      aria-label={t("phone.supporter.play.buyLabel", { action, plan: name })}
                      onClick={() => void buy(value)}
                    >
                      {action}
                    </Button>
                  </li>
                );
              })}
            </ul>
            {error ? (
              <div className="sp-play-failure">
                <Note tone="danger">{error}</Note>
                {last && (
                  <Button kind="ghost" compact className="sp-open-again" disabled={busy} onClick={() => void buy(last)}>
                    {t("common.retry")}
                  </Button>
                )}
              </div>
            ) : (
              supporter?.plan_unknown &&
              supporter.email && (
                // Signed in, but the plan could not be checked: a Supporter must not buy it twice.
                <Note tone="amber">{t("supporter.planUnknownNotice", { email: supporter.email })}</Note>
              )
            )}
            <div data-play-terms>
              <p className="sp-hint">{t("phone.supporter.play.renews")}</p>
              {offer?.five_years && <p className="sp-hint">{t("phone.supporter.play.once")}</p>}
            </div>
          </>
        )}
      </section>
    </Sheet>
  );
}

