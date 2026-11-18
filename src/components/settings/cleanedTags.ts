import type { TFunction } from "i18next";
import type { CleanedTag } from "../../types";
import { moment } from "./time";

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
