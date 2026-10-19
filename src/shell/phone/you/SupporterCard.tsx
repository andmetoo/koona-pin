import { ChevronRight, Heart } from "lucide-react";
import { capabilities } from "../../../platform/capabilities";
import { usePhone } from "../PhoneContext";
import { PhIcon } from "../ui/icons";
import { planLine } from "./youText";

/**
 * A1's Supporter card. A Supporter: the heart in the season's colour on its soft disc, "Supporter"
 * and the plan's line; it opens the plan sheet. Anyone else: Supporter's sheet (sync is a Supporter
 * perk) — an invitation to become one where the build sells by Paddle; where it cannot sell on this
 * device (`purchase: "none"`, store billing is NP-154), just Supporter's name, its perks and the
 * sign-in of someone who has it. A build without Supporter at all shows no card.
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
  // Where the build sells nothing (the Play build until NP-154) the card invites nobody to buy:
  // it names Supporter and leads to what it gives, with the sign-in of someone who has it.
  const sells = capabilities.purchase === "paddle";
  return (
    <button type="button" className="ys-card ys-supporter" data-supporter="free" onClick={() => setSurface("supporter")}>
      {heart}
      <span className="ys-supporter-text">
        <span className="ph-headline">{t(sells ? "phone.you.become" : "phone.supporter.title")}</span>
        <span className="ph-meta">{t("phone.you.becomeText")}</span>
      </span>
      <PhIcon icon={ChevronRight} at="field" className="ys-chevron" />
    </button>
  );
}
