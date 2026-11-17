import { describe, expect, it } from "vitest";
import i18n from "../../i18n";
import type { CleanedTag } from "../../types";
import { cleanedDetails } from "./cleanedTags";
import { moment } from "./time";

const entry = (over: Partial<CleanedTag>): CleanedTag => ({
  key: "tag_cleanup/2026-11-01T14:05:00.000Z/000000/t1",
  at: "2026-11-01T14:05:00.000Z",
  action: "merged",
  parts: [{ text: "coop", unseen: false }],
  now_named: "coop",
  bookmarks: 3,
  ...over,
});
const t = i18n.getFixedT("en");

describe("cleanedDetails", () => {
  it("says what was done, on how many bookmarks and when", () => {
    const at = moment("2026-11-01T14:05:00.000Z", "en");
    expect(cleanedDetails(entry({}), t, "en")).toBe(`Merged · 3 bookmarks · ${at.date} at ${at.time}`);
    expect(cleanedDetails(entry({ action: "removed", bookmarks: 1 }), t, "en")).toMatch(/^Removed · 1 bookmark · /);
  });

  it("gives no count for a rename: the tag keeps its bookmarks", () => {
    expect(cleanedDetails(entry({ action: "renamed", bookmarks: 0 }), t, "en")).toMatch(/^Renamed · [^·]+ at /);
  });

  it("says today for an entry of today", () => {
    const now = new Date().toISOString();
    expect(cleanedDetails(entry({ at: now }), t, "en")).toBe(`Merged · 3 bookmarks · today at ${moment(now, "en").time}`);
  });

  it("leaves out a time that does not read rather than failing", () => {
    expect(cleanedDetails(entry({ at: "" }), t, "en")).toBe("Merged · 3 bookmarks");
    expect(cleanedDetails(entry({ at: "not a time" }), t, "en")).toBe("Merged · 3 bookmarks");
  });

  it("reads in another language with its plural forms", () => {
    const ru = i18n.getFixedT("ru");
    expect(cleanedDetails(entry({ bookmarks: 5, at: "" }), ru, "ru")).toBe("Объединён · 5 закладок");
  });
});
