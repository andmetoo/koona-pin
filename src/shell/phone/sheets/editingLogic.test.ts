import { describe, expect, it } from "vitest";
import type { Collection, Tag } from "../../../types";
import { cameWhole, firstChoice, isNew, matching, newName, pickerRows, tagSuggestions, toggle } from "./editingLogic";

const collection = (id: number, name: string, parent_id: number | null = null, count = 0): Collection => ({ id, name, color: null, icon: null, parent_id, count, created_at: "" });
const collections = [collection(1, "Design"), collection(2, "Tools"), collection(3, "Local-first")];
const tag = (id: number, name: string, count: number): Tag => ({ id, name, count });

describe("the collection picker's first choice", () => {
  it("takes what the caller holds, even none, over the bookmark's own and the suggestion", () => {
    expect(firstChoice(collections, { selected: 2, current: 1, suggested: 3 })).toBe(2);
    expect(firstChoice(collections, { selected: null, current: 1, suggested: 3 })).toBeNull();
  });

  it("then the bookmark's collection, then the suggestion for a link that has none", () => {
    expect(firstChoice(collections, { current: 1, suggested: 3 })).toBe(1);
    expect(firstChoice(collections, { current: null, suggested: 3 })).toBe(3);
    expect(firstChoice(collections, {})).toBeNull();
  });

  it("ignores a collection that is gone", () => {
    expect(firstChoice(collections, { selected: 9 })).toBeNull();
    expect(firstChoice(collections, { current: 9, suggested: 2 })).toBe(2);
  });
});

describe("the picker's tree", () => {
  // Development > (Rust, Web > React), Design, in the backend's order.
  const tree = [collection(1, "Development", null, 5), collection(2, "Rust", 1, 12), collection(3, "Web", 1, 9), collection(4, "React", 3, 4), collection(5, "Design", null, 24)];
  const shape = (rows: ReturnType<typeof pickerRows>) => rows.map((r) => `${"-".repeat(r.depth)}${r.collection.name}`);

  it("lists everything open, children under their parent, a parent holding its descendants", () => {
    const rows = pickerRows(tree, {});
    expect(shape(rows)).toEqual(["Development", "-Rust", "-Web", "--React", "Design"]);
    expect(rows.map((r) => r.total)).toEqual([30, 12, 13, 4, 24]);
    expect(rows.map((r) => r.hasChildren)).toEqual([true, false, true, false, false]);
  });

  it("leaves out the children of a folded parent, and never folds the chosen one's ancestors", () => {
    expect(shape(pickerRows(tree, { folded: new Set([1]) }))).toEqual(["Development", "Design"]);
    const rows = pickerRows(tree, { folded: new Set([1, 3]), chosen: 4 });
    expect(shape(rows)).toEqual(["Development", "-Rust", "-Web", "--React", "Design"]);
    expect(rows.filter((r) => r.locked).map((r) => r.collection.id)).toEqual([1, 3]);
    expect(shape(pickerRows(tree, { folded: new Set([1]), chosen: 5 }))).toEqual(["Development", "Design"]);
  });

  it("shows a search as flat matches with their paths, in tree order", () => {
    const rows = pickerRows(tree, { query: " e " });
    expect(rows.map((r) => [r.collection.name, r.prefix, r.depth])).toEqual([
      ["Development", "", 0],
      ["Web", "Development › ", 0],
      ["React", "Development › Web › ", 0],
      ["Design", "", 0],
    ]);
    expect(pickerRows(tree, { query: "zz" })).toEqual([]);
  });

  it("keeps a tree synced deeper than the limit at the last indent", () => {
    const deep = [...tree, collection(6, "Hooks", 4, 1)];
    expect(shape(pickerRows(deep, {}))).toEqual(["Development", "-Rust", "-Web", "--React", "--Hooks", "Design"]);
  });
});

describe("find or create", () => {
  it("finds collections by any part of the name, case aside", () => {
    expect(matching(collections, "  o ").map((c) => c.name)).toEqual(["Tools", "Local-first"]);
    expect(matching(collections, "DES").map((c) => c.id)).toEqual([1]);
    expect(matching(collections, "")).toBe(collections);
  });

  it("offers a new collection only for a name no collection has", () => {
    expect(newName(collections, "design ")).toBeNull();
    expect(newName(collections, "")).toBeNull();
    expect(newName(collections, "  Reading   notes ")).toBe("Reading notes");
    expect(newName(collections, "Des")).toBe("Des");
  });
});

describe("a tap on an option", () => {
  it("chooses it, and the chosen one again chooses none", () => {
    expect(toggle(null, 2)).toBe(2);
    expect(toggle(2, 3)).toBe(3);
    expect(toggle(2, 2)).toBeNull();
  });

  it("treats a new collection by its name", () => {
    const fresh = toggle(1, { create: "Reading notes" });
    expect(isNew(fresh) && fresh.create).toBe("Reading notes");
    expect(toggle(fresh, { create: "Reading notes" })).toBeNull();
    expect(isNew(null)).toBe(false);
  });
});

describe("tag suggestions", () => {
  const tags = [tag(1, "essays", 3), tag(2, "local-first", 12), tag(3, "crdt", 5), tag(4, "design", 1)];

  it("are the most used tags not on the link yet", () => {
    expect(tagSuggestions(tags, "", ["local-first"]).map((t) => t.name)).toEqual(["crdt", "essays", "design"]);
    expect(tagSuggestions(tags, "", [], 2).map((t) => t.name)).toEqual(["local-first", "crdt"]);
  });

  it("narrow to those holding the typed text", () => {
    expect(tagSuggestions(tags, "S", []).map((t) => t.name)).toEqual(["local-first", "essays", "design"]);
    expect(tagSuggestions(tags, "zz", [])).toEqual([]);
  });
});

describe("a link that came whole", () => {
  it("is a paste-sized insertion, not a typed character", () => {
    expect(cameWhole("", "every.to/superorganizers")).toBe(true);
    expect(cameWhole("every.to/superorganizer", "every.to/superorganizers")).toBe(false);
    expect(cameWhole("", "        ")).toBe(false);
  });
});
