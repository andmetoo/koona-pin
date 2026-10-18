import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import type { Collection, LibraryCounts } from "../types";
import { initialFilters, isNarrowed, noSection, sectionCount, sectionName } from "./sections";

const t = i18n.getFixedT("en");
const counts: LibraryCounts = {
  total: 40,
  favorites: 5,
  inbox: 3,
  inbox_newest: null,
  inbox_imported: 0,
  trash: 2,
  duplicates: 0,
  links: 0,
  reading: 7,
  reading_unread: 4,
  offline: 1,
};
const design = { id: 4, name: "Design", count: 9 } as Collection;

describe("sections (NP-072a)", () => {
  it("names the section and counts it, a collection by its own count", () => {
    const table = [
      [{}, "All bookmarks", 40],
      [{ onlyInbox: true }, "Inbox", 3],
      [{ onlyFavorites: true }, "Favorites", 5],
      [{ onlyReading: true }, "Reading", 7],
      [{ onlyOffline: true }, "Offline", 1],
      [{ onlyTrash: true }, "Trash", 2],
    ] as const;
    for (const [section, name, count] of table) {
      const filters = { ...initialFilters, ...section };
      expect([sectionName(filters, undefined, t), sectionCount(filters, counts, undefined)]).toEqual([name, count]);
    }
    const inDesign = { ...initialFilters, collectionId: 4 };
    expect([sectionName(inDesign, design, t), sectionCount(inDesign, counts, design)]).toEqual(["Design", 9]);
  });

  it("a search, a tag or a site narrows the section; spaces alone do not", () => {
    expect(isNarrowed(initialFilters)).toBe(false);
    expect(isNarrowed({ ...initialFilters, search: "   " })).toBe(false);
    expect(isNarrowed({ ...initialFilters, search: "pin" })).toBe(true);
    expect(isNarrowed({ ...initialFilters, tag: "design" })).toBe(true);
    expect(isNarrowed({ ...initialFilters, domain: "koona.app" })).toBe(true);
  });

  it("no section turns every section off", () => {
    expect(Object.values(noSection).every((value) => value === null || value === false)).toBe(true);
  });
});
