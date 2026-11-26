import type { TFunction } from "i18next";
import type { StarterLink } from "../types";

/** The products of koona.app in the starter set: its front page, then each product's page. */
const PRODUCTS = [
  { key: "koona", url: "https://koona.app/", title: "Koona" },
  { key: "books", url: "https://koona.app/books/", title: "Koona Books" },
  { key: "pin", url: "https://koona.app/pin/", title: "Koona Pin" },
  { key: "lightcal", url: "https://koona.app/lightcal/", title: "Lightcal" },
  { key: "notes", url: "https://koona.app/notes/", title: "Ko Notes" },
] as const;

/**
 * The starter set of a new library (NP-117, sheet 43), newest first: koona.app and its products
 * (owner, 26 November 2026; it replaces the getting-started page, Firefox and Bun). Product names
 * stay as the site writes them in every language; only the descriptions are translated.
 */
export function starterLinks(t: TFunction): StarterLink[] {
  return PRODUCTS.map(({ key, url, title }) => ({ url, title, description: t(`starter.links.${key}.description`) }));
}
