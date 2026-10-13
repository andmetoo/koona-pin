// Types of site.mjs for the tests that check the app and the feedback function against the site.
export interface SiteLanguage {
  /** The language tag of the page: "en", "pt-BR", "sr-Latn". */
  lang: string;
  /** Its folder under /pin/: "" for English, "de/", "pt-br/", "sr/". */
  dir: string;
  /** The language's own name, as the site's menu shows it. */
  name: string;
}
export const languages: SiteLanguage[];
export const ORIGIN: string;
export const BASE: string;
export const SITE: string;
