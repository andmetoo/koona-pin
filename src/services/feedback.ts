import type { FeedbackKind } from "../types";

/** The dialog's state; it outlives the dialog while the app runs (NP-088). */
export type FeedbackDraft = {
  kind: FeedbackKind;
  message: string;
  email: string;
  attach: boolean;
};

export const MAX_MESSAGE = 5000;
export const emptyDraft: FeedbackDraft = { kind: "bug", message: "", email: "", attach: true };
/** Address paths of the site's languages (NP-107): one Serbian, in Latin script, for both of the app's. */
const SITE_PATHS: Record<string, string> = {
  en: "", ru: "ru/", de: "de/", es: "es/", fr: "fr/", it: "it/", pl: "pl/", "pt-BR": "pt-br/", sr: "sr/", "sr-Latn": "sr/", tr: "tr/", uk: "uk/",
};
/** The privacy policy in the interface's language, English where the site has no page in it. */
export const privacyUrl = (language: string) => `https://koona.app/pin/${Object.prototype.hasOwnProperty.call(SITE_PATHS, language) ? SITE_PATHS[language] : ""}privacy`;
export const GITHUB_ISSUES_URL = "https://github.com/andmetoo/koona-pin/issues/new/choose";

/** something@something.tld without spaces — the rule of the Rust command and the function. */
export const emailShape = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && [...email].length <= 254;

/** Characters as people count them, not UTF-16 units. */
export const length = (text: string) => [...text.trim()].length;

/** «Скопировать текст»: everything needed to send it another way. */
export function draftText(draft: FeedbackDraft, kindLabel: string, report: string | null) {
  return [
    `${kindLabel}${draft.email.trim() ? ` · ${draft.email.trim()}` : ""}`,
    "",
    draft.message.trim(),
    ...(report ? ["", report] : []),
  ].join("\n");
}
