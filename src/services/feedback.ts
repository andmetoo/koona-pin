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
/** The privacy policy in the interface's language: the site has English and Russian. */
export const privacyUrl = (language: string) => `https://pin.netami.app${language === "ru" ? "/ru" : ""}/privacy`;
export const GITHUB_ISSUES_URL = "https://github.com/andmetoo/netami-pin-releases/issues/new/choose";

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
