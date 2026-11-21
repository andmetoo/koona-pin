import { describe, expect, it, test } from "vitest";
import { buildTree } from "../../../services/collectionTree";
import { shortAge } from "./age";
import { chipRows } from "./chipRows";
import { CARD_GAP, entryStarts, GAP_HEIGHT, LABEL_HEIGHT, ROW_HEIGHT, scaledSizes, shelfEntries, shelvesOf } from "./shelfEntries";

describe("shortAge", () => {
  // Local times: the day boundaries are the person's own midnights.
  const now = new Date(2026, 9, 18, 14, 30).getTime();
  const at = (...parts: [number, number, number, number?, number?]) => new Date(...(parts as [number, number, number, number, number])).toISOString();

  test("now, minutes and hours within today", () => {
    expect(shortAge(new Date(now - 20_000).toISOString(), "en", now)).toBe("now");
    expect(shortAge(new Date(now - 5 * 60_000).toISOString(), "en", now)).toBe("5m");
    expect(shortAge(at(2026, 9, 18, 12, 10), "en", now)).toBe("2h");
    expect(shortAge(at(2026, 9, 18, 0, 5), "en", now)).toBe("14h");
  });

  test("the calendar day before is yesterday, even an hour ago after midnight", () => {
    expect(shortAge(at(2026, 9, 17, 9, 0), "en", now)).toBe("yesterday");
    const early = new Date(2026, 9, 18, 0, 30).getTime();
    expect(shortAge(at(2026, 9, 17, 23, 0), "en", early)).toBe("yesterday");
  });

  test("days, then weeks, then the date", () => {
    expect(shortAge(at(2026, 9, 15, 10, 0), "en", now)).toBe("3d");
    expect(shortAge(at(2026, 9, 4, 10, 0), "en", now)).toBe("2w");
    expect(shortAge(at(2026, 2, 12, 10, 0), "en", now)).toBe("Mar 12");
    expect(shortAge(at(2025, 2, 12, 10, 0), "en", now)).toBe("Mar 12, 2025");
  });

  test("a time ahead of the clock is now; a bad date is nothing", () => {
    expect(shortAge(new Date(now + 60_000).toISOString(), "en", now)).toBe("now");
    expect(shortAge("not a date", "en", now)).toBe("");
  });
});

describe("the Library's chip rows", () => {
  const item = (id: number, name: string, parent_id: number | null = null, count = 0) => ({ id, name, parent_id, count });
  // Development > (Rust, Web > React), Design, Read later.
  const roots = buildTree([item(1, "Development", null, 5), item(2, "Rust", 1, 12), item(3, "Web", 1, 9), item(4, "React", 3, 4), item(5, "Design"), item(6, "Read later")]);

  it("have no second row for All, Favorites or a top-level collection without children", () => {
    expect(chipRows(roots, null)).toEqual({ branch: null, parent: undefined });
    expect(chipRows(roots, 5)).toEqual({ branch: 5, parent: undefined });
    expect(chipRows(roots, 99)).toEqual({ branch: null, parent: undefined });
  });

  it("show the children under a chosen parent, its branch marked in the first row", () => {
    const { branch, parent } = chipRows(roots, 1);
    expect(branch).toBe(1);
    expect(parent?.item.id).toBe(1);
    expect(parent?.children.map((c) => c.item.id)).toEqual([2, 3]);
    expect(parent?.total).toBe(30);
  });

  it("go deeper by replacing the row with the next parent's children", () => {
    const { branch, parent } = chipRows(roots, 3);
    expect(branch).toBe(1);
    expect(parent?.item.id).toBe(3);
    expect(parent?.children.map((c) => c.item.id)).toEqual([4]);
  });

  it("keep a collection without children among its siblings, under its parent's All", () => {
    expect(chipRows(roots, 2).parent?.item.id).toBe(1);
    expect(chipRows(roots, 4).parent?.item.id).toBe(3);
    expect(chipRows(roots, 4).branch).toBe(1);
  });
});

type ShelfItem = { id: number; day: string | null };
const shelfItems: ShelfItem[] = [
  { id: 1, day: "today" },
  { id: 2, day: "today" },
  { id: 3, day: "today" },
  { id: 4, day: "yesterday" },
  { id: 5, day: "yesterday" },
];
const shelfOptions = { groupOf: (i: ShelfItem) => i.day, keyOf: (i: ShelfItem) => i.id };

describe("shelfEntries", () => {
  test("a label, then the section's rows, first and last marked", () => {
    const entries = shelfEntries(shelfItems, shelfOptions);
    expect(entries.map((e) => (e.kind === "label" ? e.group : e.kind === "row" ? `${e.item.id}${e.first ? "^" : ""}${e.last ? "$" : ""}` : "?"))).toEqual([
      "today",
      "1^",
      "2",
      "3$",
      "yesterday",
      "4^",
      "5$",
    ]);
    expect(entries[0]).toMatchObject({ kind: "label", label: true, size: LABEL_HEIGHT });
    expect(entries[1]).toMatchObject({ kind: "row", section: 0, size: ROW_HEIGHT, key: "r1" });
    expect(entries[5]).toMatchObject({ section: 1 });
  });

  test("without groups one run, with only the gap above it", () => {
    const entries = shelfEntries(shelfItems, { ...shelfOptions, groupOf: () => null });
    expect(entries[0]).toMatchObject({ kind: "label", label: false, size: GAP_HEIGHT });
    expect(entries.filter((e) => e.kind === "row")).toHaveLength(5);
  });

  test("the grid puts each section's cards in rows of `columns`, the gap under all but its last", () => {
    const entries = shelfEntries(shelfItems, { ...shelfOptions, columns: 2, cardHeight: 221 });
    expect(entries.map((e) => (e.kind === "cards" ? e.items.map((i) => i.id).join(",") : e.kind))).toEqual(["label", "1,2", "3", "label", "4,5"]);
    expect(entries[1]).toMatchObject({ place: 0, size: 221 + CARD_GAP });
    expect(entries[2]).toMatchObject({ place: 2, size: 221 });
    expect(entries[4]).toMatchObject({ place: 3, size: 221 });
  });

  test("nothing to show is no entries", () => {
    expect(shelfEntries([], shelfOptions)).toEqual([]);
  });

  test("10,000 rows lay out at once", () => {
    const many = Array.from({ length: 10_000 }, (_, i) => ({ id: i, day: i < 40 ? "today" : "earlier" }));
    const started = performance.now();
    const entries = shelfEntries(many, shelfOptions);
    const starts = entryStarts(entries);
    expect(performance.now() - started).toBeLessThan(200);
    expect(entries).toHaveLength(10_002);
    expect(starts.at(-1)).toBe(2 * LABEL_HEIGHT + 9_999 * ROW_HEIGHT);
  });
});

describe("shelvesOf", () => {
  test("one paper per section, from its first row to its last", () => {
    const entries = shelfEntries(shelfItems, shelfOptions);
    const shelves = shelvesOf(entries, entryStarts(entries));
    expect(shelves).toEqual([
      { section: 0, from: 1, to: 3, top: LABEL_HEIGHT, height: 3 * ROW_HEIGHT },
      { section: 1, from: 5, to: 6, top: 2 * LABEL_HEIGHT + 3 * ROW_HEIGHT, height: 2 * ROW_HEIGHT },
    ]);
  });

  test("the grid has no shelves: its cards are paper", () => {
    const entries = shelfEntries(shelfItems, { ...shelfOptions, columns: 2, cardHeight: 221 });
    expect(shelvesOf(entries, entryStarts(entries))).toEqual([]);
  });
});

describe("scaledSizes", () => {
  test("the frames' sizes at the normal text size; text grows the rows, not their paddings", () => {
    expect(scaledSizes(1)).toEqual({ row: ROW_HEIGHT, label: LABEL_HEIGHT, cardText: 76 });
    expect(scaledSizes(2)).toEqual({ row: 24 + 128, label: 28 + 36, cardText: 20 + 112 });
  });
});
