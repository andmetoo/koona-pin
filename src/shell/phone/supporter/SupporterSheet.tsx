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
import { AccountWell, CodeForm, Note, Notice, SeasonHeart } from "./parts";
import { api } from "../../../services/api";
import { playBadge, playPlans, playPriceLine, playUnavailable, usePlayPurchase, type StoreChannel } from "./playFlow";

/** Apple's rules for subscriptions (App Review 3.1.2): the sheet links to both. */
export const TERMS_URL = "https://koona.app/pin/terms";
export const PRIVACY_URL = "https://koona.app/pin/privacy";

/** The sheet's words that name the store: the App Store build has its own for these. */
const STORE_WORDS = new Set(["renews", "notAvailable", "offerFailed", "emailText", "pending", "pendingText", "alreadyText", "otherText", "ownerText", "suspendedText", "suspendedTerms"]);
const storeKey = (channel: StoreChannel, key: string) => `phone.supporter.${channel === "appstore" && STORE_WORDS.has(key) ? "appstore" : "play"}.${key}`;

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
  if (capabilities.purchase === "paddle") return <PurchaseSheet />;
  if (capabilities.purchase === "play") return <PlaySheet channel="play" />;
  if (capabilities.purchase === "appstore") return <PlaySheet channel="appstore" />;
  return <PerksSheet />;
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
function Perks({ hero = true, plainFree = false }: { hero?: boolean; plainFree?: boolean }) {
  const { app } = usePhone();
  const { t, supporter, setSurface } = app;
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
      {plainFree ? (
        // The Play sheet (P1, P8): a heading and a line, so the plans fit without scrolling.
        <section className="ys-section sp-free-plain" data-supporter-free>
          <h3 className="sp-free-title">{t("phone.supporter.freeLabel")}</h3>
          <p className="sp-free-text">{t("phone.supporter.freeText")}</p>
        </section>
      ) : (
        <section className="ys-section" data-supporter-free>
          <h3 className="ys-label">{t("phone.supporter.freeLabel")}</h3>
          <p className="ys-card sp-free">{t("phone.supporter.freeText")}</p>
        </section>
      )}
      {/* Signed in without a plan: the account, and deleting it, quietly (as the plan sheet's D1). */}
      {((supporter?.email && !supporter.plan) || supporter?.deletion_pending) && (
        <p className="sp-account-line" data-account-line>
          <span className="sp-account-email" data-user-text>
            {supporter.email ? t("deleteAccount.signedInAs", { email: supporter.email }) : t("deleteAccount.unknownTitle")}
          </span>
          <Button kind="ghost" compact className="sp-sign-out" onClick={() => setSurface("deleteAccount")}>
            {t("deleteAccount.open")}
          </Button>
        </p>
      )}
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
    paidAgain: !!supporter?.paid_again,
    paid: !!supporter?.plan,
    planUnknown: !!supporter?.plan_unknown,
    onClose: close,
  });
  const { step, interval, setPlan, shown, plans, pay, openAgain, busy, error, checkout, paidEmail, again } = purchase;
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
        label={t(again ? "supporter.againTitle" : thanks ? "supporter.thanksTitle" : "supporter.paidTitle")}
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
          <h2 className="ph-title2">{t(again ? "supporter.againTitle" : thanks ? "supporter.thanksTitle" : "supporter.paidTitle")}</h2>
          <p className="sp-text">
            {thanks
              ? t(again ? "supporter.againText" : "phone.supporter.thanksText", { email: paidEmail ?? "" })
              : t(again ? "supporter.againSignInText" : "supporter.paidSignInText")}
          </p>
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
 * what a subscription does (it renews until cancelled in Google Play; the one-time purchase is paid once).
 * After Play's sheet, the server's verdict leads on: thanks; the email that claims the purchase and
 * the code sent to it; a slow payment; a Supporter buying again; a purchase that belongs to another
 * account; a failure under the plans. A purchase still waiting when the sheet opens resumes its step.
 * Nothing names where else Supporter is sold.
 *
 * The App Store build (`channel` "appstore") is the same sheet over StoreKit, with what App Review
 * asks of subscriptions (3.1.2): each plan's price and period from StoreKit, what renews and how to
 * cancel, «Restore purchases», the Terms of Use and the Privacy Policy. Either store: someone who is
 * a Supporter already, through any channel, is told so and offered nothing to buy.
 */
function PlaySheet({ channel }: { channel: StoreChannel }) {
  const { app } = usePhone();
  const { t, supporter, setSurface } = app;
  const close = useCloseSheet();
  const formId = useId();
  const purchase = usePlayPurchase(supporter, channel);
  const { step, error, busy, offer, offerFailed, askOffer, last, kept, retry, buy, email, setEmail, claim, code, setCode, verify, resend, wait, anotherEmail, codeReady, suspended, fixPayment, restore } = purchase;
  const words = (key: string, options?: Record<string, string>) => t(storeKey(channel, key) as "phone.supporter.play.renews", options);
  const apple = channel === "appstore";
  const signIn = () => setSurface("signIn");

  if (step === "email" || step === "code") {
    // P2, P3: a compact sheet right above the keyboard; its one action under the field. «Use
    // another email» is the way back, so there is no Back beside «Sign in».
    const onEmail = step === "email";
    const title = t(onEmail ? "phone.supporter.play.emailTitle" : "supporter.codeTitle");
    return (
      <Sheet
        label={title}
        title={title}
        className="sp-sheet sp-play sp-play-form"
        footer={
          <Button kind="primary" block type="submit" form={formId} disabled={busy || (onEmail ? !email.trim() : !codeReady)}>
            {t(onEmail ? "supporter.sendCode" : "supporter.signIn")}
          </Button>
        }
      >
        <CodeForm
          id={formId}
          step={step}
          text={onEmail ? words("emailText") : t("phone.supporter.play.codeText", { email: email.trim() })}
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
    // P4: the code step's layout, the wait on a card with a ring.
    return (
      <Sheet
        label={t("phone.supporter.play.pendingTitle")}
        title={t("phone.supporter.play.pendingTitle")}
        className="sp-sheet sp-play sp-play-form"
        footer={
          <Button kind="clear" block onClick={close}>
            {t("common.close")}
          </Button>
        }
      >
        <p className="sp-text">{words("pendingText")}</p>
        <div className="ys-card sp-waiting" data-play-step="pending">
          <span className="sp-spinner" aria-hidden="true" />
          <span role="status" className="sp-waiting-text">
            {words("pending")}
          </span>
        </div>
      </Sheet>
    );

  if (step !== "plans" && step !== "suspended") {
    // P5–P7: how the purchase ended — thanks, a Supporter already (Play refunds it), or an account
    // to sign in to — on one layout: a round well, the title, the words, the action.
    const ended = {
      paid: { title: t("supporter.thanksTitle"), text: t("phone.supporter.play.thanksText", { email: supporter?.email ?? email.trim() }) },
      alreadySupporter: { title: t("phone.supporter.play.alreadyTitle"), text: words("alreadyText") },
      otherAccount: { title: t("phone.supporter.play.otherTitle"), text: words("otherText") },
      owner: { title: t("phone.supporter.play.ownerTitle"), text: words("ownerText") },
    }[step];
    const toSignIn = step === "otherAccount" || step === "owner";
    return (
      <Sheet
        label={ended.title}
        className="sp-sheet sp-play"
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
          {toSignIn ? <AccountWell /> : <SeasonHeart size={72} />}
          <h2 className="ph-title2">{ended.title}</h2>
          <p className="sp-text">{ended.text}</p>
        </div>
      </Sheet>
    );
  }

  if (suspended)
    // P8: the account's subscription is on hold or paused. Its payment is fixed in Google Play,
    // where Google sends such a subscriber; nothing to buy and nobody else to sign in as.
    return (
      <Sheet label={t("phone.supporter.title")} title={t("phone.supporter.title")} className="sp-sheet sp-play">
        <div data-play-step="suspended">
          <Notice tone="danger" title={t("phone.supporter.play.suspendedTitle")}>
            {words("suspendedText")}
          </Notice>
          <Button kind="primary" block icon={ExternalLink} className="sp-fix" disabled={busy} onClick={() => void fixPayment()}>
            {t(apple ? "plan.fixInAppStore" : "plan.fixInPlay")}
          </Button>
          {error && (
            <Notice tone="danger" live="alert">
              {error}
            </Notice>
          )}
        </div>
        <Perks hero={false} plainFree />
        <p className="sp-hint sp-terms">{words("suspendedTerms")}</p>
        {apple && <Legal />}
      </Sheet>
    );

  // P1: everything on one screen — «I'm already a Supporter» first, the perks, what stays free, the
  // plans on one shelf and what renews. A failure is a notice in the plans' place or under them.
  return (
    <Sheet label={t("phone.supporter.title")} title={t("phone.supporter.title")} className="sp-sheet sp-play">
      <Button kind="clear" compact block className="sp-already" onClick={signIn}>
        {t("plan.already")}
      </Button>
      <Perks hero={false} plainFree />
      <section className="ys-section sp-plan-section">
        <h3 className="ys-label">{t("phone.supporter.planLabel")}</h3>
        {supporter?.plan ? (
          // A Supporter already, through any channel: nothing to buy twice.
          <>
            <Notice tone="amber" live="status" title={t("phone.supporter.play.alreadyTitle")}>
              {t("phone.supporter.managed")}
            </Notice>
            {/* A purchase kept after the sign-in still says so, with Try again. */}
            {error && (
              <Notice
                tone={kept ? "amber" : "danger"}
                live="alert"
                action={
                  kept && (
                    <Button kind="ghost" compact className="sp-notice-action" disabled={busy} onClick={() => void retry()}>
                      {t("common.retry")}
                    </Button>
                  )
                }
              >
                {error}
              </Notice>
            )}
          </>
        ) : playUnavailable(offer) ? (
          <Notice tone="amber" live="status">
            {words("notAvailable")}
          </Notice>
        ) : offerFailed && !offer ? (
          <Notice
            tone="danger"
            live="alert"
            action={
              <Button kind="ghost" compact className="sp-notice-action" onClick={askOffer}>
                {t("common.retry")}
              </Button>
            }
          >
            {words("offerFailed")}
          </Notice>
        ) : (
          <>
            <ul aria-label={t("supporter.plan")} aria-busy={!offer || undefined} className="sp-play-plans">
              {playPlans(offer).map((value) => {
                const price = offer?.[value];
                const badge = playBadge(value, offer, t);
                const name = planName(value, t);
                const action = t(value === "lifetime" ? "phone.supporter.play.buy" : "phone.supporter.play.subscribe");
                return (
                  <li key={value} className="sp-play-plan" data-play-plan={value}>
                    <span className="sp-play-plan-text">
                      <span className="sp-play-plan-name">
                        {name}
                        {badge && <span className="sp-plan-badge">{badge}</span>}
                      </span>
                      <span className="sp-play-plan-price">{price ? playPriceLine(value, price, t) : <span className="sp-pending" aria-hidden="true" />}</span>
                    </span>
                    <Button
                      kind="soft"
                      className="sp-buy"
                      // A paid purchase not confirmed yet: buying again would charge twice, and the
                      // server cannot refund a store's duplicate.
                      disabled={busy || !price || kept}
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
              <Notice
                tone={kept ? "amber" : "danger"}
                live="alert"
                action={
                  (last || kept) && (
                    <Button kind="ghost" compact className="sp-notice-action" disabled={busy} onClick={() => void retry()}>
                      {t("common.retry")}
                    </Button>
                  )
                }
              >
                {error}
              </Notice>
            ) : (
              supporter?.plan_unknown &&
              supporter.email && (
                // Signed in, but the plan could not be checked: a Supporter must not buy it twice.
                <Notice tone="amber" live="status">
                  {t("supporter.planUnknownNotice", { email: supporter.email })}
                </Notice>
              )
            )}
            <div className="sp-terms" data-play-terms>
              <p className="sp-hint">{words("renews")}</p>
              {offer?.lifetime && <p className="sp-hint">{t("phone.supporter.play.once")}</p>}
            </div>
          </>
        )}
        {/* Restore whatever StoreKit sells or not: a purchase made elsewhere is found either way. */}
        {apple && (
          <Button kind="clear" compact block className="sp-restore" disabled={busy} onClick={() => void restore()}>
            {t("phone.supporter.appstore.restore")}
          </Button>
        )}
        {/* Where the plans are not shown, what Restore found is said here. */}
        {apple && error && !supporter?.plan && (playUnavailable(offer) || (offerFailed && !offer)) && (
          <Notice tone={kept ? "amber" : "danger"} live="alert">
            {error}
          </Notice>
        )}
        {apple && <Legal />}
      </section>
    </Sheet>
  );
}

/** The Terms of Use and the Privacy Policy, opened in the browser (App Review 3.1.2). */
function Legal() {
  const { app } = usePhone();
  const { t } = app;
  return (
    <p className="sp-legal" data-legal>
      <Button kind="ghost" compact onClick={() => void api.openUrl(TERMS_URL)}>
        {t("phone.supporter.appstore.terms")}
      </Button>
      <Button kind="ghost" compact onClick={() => void api.openUrl(PRIVACY_URL)}>
        {t("phone.supporter.appstore.privacy")}
      </Button>
    </p>
  );
}
