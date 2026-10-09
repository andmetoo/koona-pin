import type { TFunction } from "i18next";
import type { StarterLink } from "../types";

/**
 * The starter set of a new library (NP-117, sheet 43), newest first: the
 * site's pages, then Bun and Lunacy — good programs, not advertising. The
 * link to the MCP instructions joins when its page is on the site (NP-091,
 * NP-092), «Koona apps» when koona.app lists them. Program names stay as they
 * are in every language.
 */
export function starterLinks(t: TFunction): StarterLink[] {
  return [
    { url: "https://koona.app/pin/#how", title: t("starter.links.start.title"), description: t("starter.links.start.description") },
    {
      url: "https://koona.app/pin/downloads/#extension",
      title: t("starter.links.extension.title"),
      description: t("starter.links.extension.description"),
    },
    {
      url: "https://koona.app/pin/changelog/",
      title: t("starter.links.changelog.title"),
      description: t("starter.links.changelog.description"),
    },
    { url: "https://bun.com/", title: "Bun", description: t("starter.links.bun.description") },
    { url: "https://www.lunacyapp.com/", title: "Lunacy", description: t("starter.links.lunacy.description") },
  ];
}
