import type { TFunction } from "i18next";
import type { StarterLink } from "../types";
import { helpUrl } from "./help";

/**
 * The starter set of a new library (NP-117, sheet 43), newest first: Koona's apps, how Koona Pin works,
 * then Firefox, Bun and Lunacy — good programs, not advertising. One link to Koona Pin itself is enough
 * (owner, 9 October 2026): the extension and the changelog are a click away from it. Program names stay
 * as they are in every language.
 */
export function starterLinks(t: TFunction): StarterLink[] {
  return [
    { url: "https://koona.app/", title: t("starter.links.koona.title"), description: t("starter.links.koona.description") },
    { url: helpUrl("gettingStarted"), title: t("starter.links.start.title"), description: t("starter.links.start.description") },
    { url: "https://www.firefox.com/", title: "Firefox", description: t("starter.links.firefox.description") },
    { url: "https://bun.com/", title: "Bun", description: t("starter.links.bun.description") },
    { url: "https://www.lunacyapp.com/", title: "Lunacy", description: t("starter.links.lunacy.description") },
  ];
}
