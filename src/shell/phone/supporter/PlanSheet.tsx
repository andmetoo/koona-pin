import "../you/you.css";
import "./supporter.css";
import { useEffect, useRef } from "react";
import { BookOpen, ExternalLink, Heart, RefreshCw } from "lucide-react";
import { longDate, planLink, usePlan } from "../../../components/supporterFlow";
import { capabilities } from "../../../platform/capabilities";
import { savePreference } from "../../../services/preferences";
import { usePhone } from "../PhoneContext";
import { Button } from "../ui/buttons";
import { Toggle } from "../ui/controls";
import { Sheet, useCloseSheet } from "../ui/Sheet";
import { Shelf, ShelfRow } from "../ui/Shelf";
import { useSyncCard } from "../you/SyncCard";
import { SeasonHeart } from "./parts";

export type PlanSheetProps = Record<string, never>;

/**
 * The Supporter's plan on a phone (NP-072b; `app.surface` "plan", A1's Supporter card): the heart,
 * the plan, the email and the plan's state on one line, the perks — sync leading to its dialog, the
 * reading themes, the heart with its switch — and sign out. Its action is the shared plan's
 * (components/supporterFlow.ts): Manage or Update card in Paddle's portal for a Paddle subscription,
 * Try again when the plan could not be checked, nothing for five years paid once; "Switch to 5
 * years". Where the build does not sell through Paddle (the Play build) the sheet links to no
 * Paddle page at all: no portal, no switch, and a Paddle plan's lines name none — a neutral line
 * says the plan is managed where it was started. A plan paid through Google Play (`store` "play",
 * NP-154) has "Manage in Google Play", or "Fix payment in Google Play" when a renewal failed: Google
 * Play's subscriptions page, which its policy asks for here. It closes when the plan goes.
 */
export function PlanSheet(_: { props: PlanSheetProps }) {
  const { app } = usePhone();
  const { supporter } = app;
  const close = useCloseSheet();
  // Kept while the sheet leaves after the plan went (signed out, ended).
  const kept = useRef(supporter);
  if (supporter?.plan) kept.current = supporter;
  const hasPlan = !!supporter?.plan;
  useEffect(() => {
    if (!hasPlan) close();
  }, [hasPlan, close]);
  if (!kept.current?.plan) return null;
  return <PlanBody supporter={kept.current} />;
}

function PlanBody({ supporter }: { supporter: NonNullable<ReturnType<typeof usePhone>["app"]["supporter"]> }) {
  const { app } = usePhone();
  const { t, i18n, badge, setBadge, setSurface, setUpgradeFrom } = app;
  const sells = capabilities.purchase === "paddle";
  const close = useCloseSheet();
  const plan = supporter.plan!;
  const { status, tone, action, busy, error, offerSwitch, act, signOut } = usePlan({
    supporter,
    onClose: close,
    onUpgrade: () => {
      setUpgradeFrom(plan);
      setSurface("upgrade");
      close();
    },
  });
  const sync = useSyncCard();
  // Paddle's portal (Manage, Update card) only where the build sells through Paddle; elsewhere the
  // plan's lines say what is so without sending anyone to pay. A plan paid through Google Play
  // (NP-154) is managed on Google Play's page, in any build: the plan's own lines name it.
  const portal = planLink(action) === "portal";
  const shownStatus =
    sells || supporter.check_failed || plan.store === "play"
      ? status
      : plan.status === "past_due"
        ? t("phone.supporter.pastDue", { date: longDate(plan.valid_until, i18n.language) })
        : plan.interval === "five_years" && plan.also_renews
          ? t("phone.supporter.alsoRenews")
          : status;
  const name = t(plan.interval === "five_years" ? "plan.fiveYears" : plan.interval === "month" ? "plan.monthly" : "plan.yearly");
  const main =
    action === "retry" ? (
      <Button kind="primary" disabled={busy} onClick={() => act(action)}>
        {t("common.retry")}
      </Button>
    ) : action === "fixInPlay" ? (
      <Button kind="primary" icon={ExternalLink} disabled={busy} onClick={() => act(action)}>
        {t("plan.fixInPlay")}
      </Button>
    ) : action === "manageInPlay" ? (
      <Button kind="clear" icon={ExternalLink} disabled={busy} onClick={() => act(action)}>
        {t("plan.manageInPlay")}
      </Button>
    ) : !sells ? null : action === "updateCard" ? (
      <Button kind="primary" icon={ExternalLink} disabled={busy} onClick={() => act(action)}>
        {t("plan.updateCard")}
      </Button>
    ) : action === "manage" ? (
      <Button kind="clear" icon={ExternalLink} disabled={busy} onClick={() => act(action)}>
        {t("plan.manage")}
      </Button>
    ) : null;
  return (
    <Sheet
      label={t("phone.you.supporter")}
      title={t("phone.you.supporter")}
      className="sp-sheet"
      footer={
        <div className="sp-footer">
          {!sells && portal && <p className="sp-hint sp-managed">{t("phone.supporter.managed")}</p>}
          {offerSwitch && action === "manage" && (
            <Button kind="clear" block onClick={offerSwitch}>
              {t("plan.switchToFiveYears")}
            </Button>
          )}
          <div className="sp-actions">
            <Button kind="ghost" disabled={busy} className="sp-sign-out" onClick={signOut}>
              {t("plan.signOut")}
            </Button>
            {main}
          </div>
        </div>
      }
    >
      <div className="ys-card ys-supporter" data-plan-sheet={supporter.check_failed ? "unchecked" : plan.status}>
        <SeasonHeart />
        <span className="ys-supporter-text">
          <span className="ph-headline">{name}</span>
          <span className="ph-meta sp-email" data-user-text>{supporter.email}</span>
          <span role={tone === "muted" && !error ? undefined : "status"} className="sp-status" data-tone={error ? "danger" : tone}>
            {error ?? shownStatus}
          </span>
        </span>
      </div>
      <section className="ys-section">
        <h3 className="ys-label">{t("phone.supporter.perksTitle")}</h3>
        <Shelf className="ys-shelf sp-shelf">
          {sync.kind !== "hidden" && (
            <ShelfRow
              icon={RefreshCw}
              title={t("phone.supporter.sync")}
              detail={sync.kind === "on" ? sync.title : t("phone.supporter.syncOff")}
              chevron
              onClick={() => setSurface("sync")}
            />
          )}
          <ShelfRow icon={BookOpen} title={t("phone.supporter.perk.reading")} subtitle={t("phone.supporter.perk.readingHint")} />
          <ShelfRow
            className="sp-heart-row"
            icon={Heart}
            title={t("phone.supporter.perk.badge")}
            subtitle={t("phone.supporter.perk.badgeHint")}
            trailing={
              <Toggle
                label={t("phone.supporter.perk.badge")}
                checked={badge}
                onChange={(shown) => {
                  setBadge(shown);
                  savePreference("supporterBadge", shown ? "on" : "off");
                }}
              />
            }
          />
        </Shelf>
      </section>
    </Sheet>
  );
}
