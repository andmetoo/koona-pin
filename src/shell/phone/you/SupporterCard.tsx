import { ChevronRight, Heart } from "lucide-react";
import { capabilities } from "../../../platform/capabilities";
import { usePhone } from "../PhoneContext";
import { Button } from "../ui/buttons";
import { PhIcon } from "../ui/icons";
import { planLine } from "./youText";

/**
 * A1's Supporter card. A Supporter: the heart in the season's colour on its soft disc, "Supporter"
 * and the plan's line; it opens the plan dialog. Anyone else: the invitation to become one (sync is
 * a Supporter perk), opening the purchase dialog where the build sells by Paddle; a build that cannot
 * sell on this device (`purchase: "none"`, store billing is NP-154) offers only the sign-in of
 * someone who paid elsewhere. A build that sells nothing shows no card.
 */
export function SupporterCard() {
  const { app } = usePhone();
  const { t, i18n, supporter, badge, setSurface } = app;
  if (!supporter?.available) return null;
  const plan = supporter.plan;
  const heart = (
    <span className="ys-heart" data-badge={plan && badge ? "" : undefined} aria-hidden="true">
      <Heart size={24} strokeWidth={1.75} absoluteStrokeWidth fill={plan && badge ? "currentColor" : "none"} />
    </span>
  );
  if (plan)
    return (
      <button type="button" className="ys-card ys-supporter" data-supporter="plan" onClick={() => setSurface("plan")}>
        {heart}
        <span className="ys-supporter-text">
          <span className="ph-headline">{t("phone.you.supporter")}</span>
          <span className="ph-meta">{planLine(plan, t, i18n.language)}</span>
        </span>
        <PhIcon icon={ChevronRight} at="field" className="ys-chevron" />
      </button>
    );
  if (capabilities.purchase === "paddle")
    return (
      <button type="button" className="ys-card ys-supporter" data-supporter="free" onClick={() => setSurface("supporter")}>
        {heart}
        <span className="ys-supporter-text">
          <span className="ph-headline">{t("phone.you.become")}</span>
          <span className="ph-meta">{t("phone.you.becomeText")}</span>
        </span>
        <PhIcon icon={ChevronRight} at="field" className="ys-chevron" />
      </button>
    );
  return (
    <div className="ys-card ys-supporter" data-supporter="free">
      {heart}
      <span className="ys-supporter-text">
        <span className="ph-headline">{t("phone.you.become")}</span>
        <span className="ph-meta">{t("phone.you.becomeText")}</span>
        <Button kind="clear" compact className="ys-card-action" onClick={() => setSurface("signIn")}>
          {t("plan.already")}
        </Button>
      </span>
    </div>
  );
}
