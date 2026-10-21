import { describe, expect, test } from "vitest";
import { CARD_GAP, entryStarts, GAP_HEIGHT, LABEL_HEIGHT, ROW_HEIGHT, scaledSizes, shelfEntries, shelvesOf } from "./shelfEntries";

type Item = { id: number; day: string | null };
const items: Item[] = [
  { id: 1, day: "today" },
  { id: 2, day: "today" },
  { id: 3, day: "today" },
  { id: 4, day: "yesterday" },
  { id: 5, day: "yesterday" },
];
const options = { groupOf: (i: Item) => i.day, keyOf: (i: Item) => i.id };

describe("shelfEntries", () => {
  test("a label, then the section's rows, first and last marked", () => {
    const entries = shelfEntries(items, options);
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
    const entries = shelfEntries(items, { ...options, groupOf: () => null });
    expect(entries[0]).toMatchObject({ kind: "label", label: false, size: GAP_HEIGHT });
    expect(entries.filter((e) => e.kind === "row")).toHaveLength(5);
  });

  test("the grid puts each section's cards in rows of `columns`, the gap under all but its last", () => {
    const entries = shelfEntries(items, { ...options, columns: 2, cardHeight: 221 });
    expect(entries.map((e) => (e.kind === "cards" ? e.items.map((i) => i.id).join(",") : e.kind))).toEqual(["label", "1,2", "3", "label", "4,5"]);
    expect(entries[1]).toMatchObject({ place: 0, size: 221 + CARD_GAP });
    expect(entries[2]).toMatchObject({ place: 2, size: 221 });
    expect(entries[4]).toMatchObject({ place: 3, size: 221 });
  });

  test("nothing to show is no entries", () => {
    expect(shelfEntries([], options)).toEqual([]);
  });

  test("10,000 rows lay out at once", () => {
    const many = Array.from({ length: 10_000 }, (_, i) => ({ id: i, day: i < 40 ? "today" : "earlier" }));
    const started = performance.now();
    const entries = shelfEntries(many, options);
    const starts = entryStarts(entries);
    expect(performance.now() - started).toBeLessThan(200);
    expect(entries).toHaveLength(10_002);
    expect(starts.at(-1)).toBe(2 * LABEL_HEIGHT + 9_999 * ROW_HEIGHT);
  });
});

describe("shelvesOf", () => {
  test("one paper per section, from its first row to its last", () => {
    const entries = shelfEntries(items, options);
    const shelves = shelvesOf(entries, entryStarts(entries));
    expect(shelves).toEqual([
      { section: 0, from: 1, to: 3, top: LABEL_HEIGHT, height: 3 * ROW_HEIGHT },
      { section: 1, from: 5, to: 6, top: 2 * LABEL_HEIGHT + 3 * ROW_HEIGHT, height: 2 * ROW_HEIGHT },
    ]);
  });

  test("the grid has no shelves: its cards are paper", () => {
    const entries = shelfEntries(items, { ...options, columns: 2, cardHeight: 221 });
    expect(shelvesOf(entries, entryStarts(entries))).toEqual([]);
  });
});

describe("scaledSizes", () => {
  test("the frames' sizes at the normal text size; text grows the rows, not their paddings", () => {
    expect(scaledSizes(1)).toEqual({ row: ROW_HEIGHT, label: LABEL_HEIGHT, cardText: 76 });
    expect(scaledSizes(2)).toEqual({ row: 24 + 128, label: 28 + 36, cardText: 20 + 112 });
  });
});
