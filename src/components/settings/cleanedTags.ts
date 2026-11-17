import type { TFunction } from "i18next";
import type { CleanedTag } from "../../types";

/** When something happened, for «… today at 14:05» or «… on 3 October at 14:05». */
export function moment(iso: string, language: string) {
  const at = new Date(iso);
  return {
    today: at.toDateString() === new Date().toDateString(),
    time: at.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" }),
    date: at.toLocaleDateString(language, { day: "numeric", month: "long" }),
  };
}

/**
 * The line under an entry of «Cleaned tag names»: what was done, the bookmarks it was on (a rename
 * keeps its tag and its bookmarks, so none), and when, in the words the rest of Settings uses. An
 * entry of another version without a time that reads goes without one.
 */
export function cleanedDetails(entry: CleanedTag, t: TFunction, language: string): string {
  const when = Number.isNaN(Date.parse(entry.at)) ? null : moment(entry.at, language);
  return [
    t(`settings.cleaned_${entry.action}`),
    ...(entry.action === "renamed" ? [] : [t("settings.cleanedBookmarks", { count: entry.bookmarks })]),
    ...(when ? [t(when.today ? "settings.cleanedToday" : "settings.cleanedOn", when)] : []),
  ].join(" · ");
}
