// Types of content.mjs for the tests that check the app and the feedback function against the site.
export interface SiteLanguage {
  /** The language tag of the page: "en", "pt-BR", "sr-Latn". */
  lang: string;
  /** Its folder under /pin/: "" for English, "de/", "pt-br/", "sr/". */
  dir: string;
  name: string;
  display: string;
  short: string;
  og: string;
}
export const languages: SiteLanguage[];
export const content: Record<string, SiteLanguage & Record<string, unknown>>;
export function nameIn(page: string, code: string): string;
export const SUPPORT: string;
export const FEEDBACK_ENDPOINT: string;
export const ORIGIN: string;
export const BASE: string;
export const SITE: string;
