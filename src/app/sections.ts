import type { TFunction } from "i18next";
import type { Collection, FilterState, LibraryCounts } from "../types";

/** One section of the library: All, Inbox, Favorites, Reading, Offline, Trash or a collection. */
export type Section = Partial<Pick<FilterState, "collectionId" | "onlyFavorites" | "onlyInbox" | "onlyTrash" | "onlyReading" | "read" | "onlyOffline">>;

/** Every section off: what `navigate` starts from. */
export const noSection = { collectionId: null, onlyFavorites: false, onlyInbox: false, onlyTrash: false, onlyReading: false, read: null, onlyOffline: false };

export const initialFilters: FilterState = {
  search: "",
  tag: null,
  domain: null,
  ...noSection,
};

/** The section's name, as the toolbar and the reading mode say it. */
export function sectionName(filters: FilterState, collection: Collection | undefined, t: TFunction): string {
  return filters.onlyTrash
    ? t("nav.trash")
    : filters.onlyInbox
      ? t("nav.inbox")
      : filters.onlyFavorites
        ? t("nav.favorites")
        : filters.onlyReading
          ? t("nav.reading")
          : filters.onlyOffline
            ? t("nav.offline")
            : collection
              ? collection.name
              : t("nav.all");
}

/** How many bookmarks the section holds, before a search, a tag or a site narrows it. */
export function sectionCount(filters: FilterState, counts: LibraryCounts, collection: Collection | undefined): number {
  return filters.onlyTrash
    ? counts.trash
    : filters.onlyInbox
      ? counts.inbox
      : filters.onlyFavorites
        ? counts.favorites
        : filters.onlyReading
          ? counts.reading
          : filters.onlyOffline
            ? counts.offline
            : collection
              ? (collection.count ?? 0)
              : counts.total;
}

/** Search, tag or site narrow the section: the header shows «N из M». */
export function isNarrowed(filters: FilterState): boolean {
  return filters.search.trim() !== "" || !!filters.tag || !!filters.domain;
}
