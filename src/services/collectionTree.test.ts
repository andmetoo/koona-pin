import { describe, expect, it } from "vitest";
import {
  ancestors,
  applyMove,
  buildTree,
  canCreateInside,
  canMoveInto,
  flatten,
  inTreeOrder,
  keyboardMove,
  landsAfter,
  optionIndent,
  pathPrefix,
  placeOf,
  scopeIds,
  searchTree,
  treeDrop,
  TreeItem,
} from "./collectionTree";

const c = (id: number, name: string, parent_id: number | null, count = 1): TreeItem => ({ id, name, parent_id, count });

// Design 1 · Development 2 { Rust 3, Web 4 { React 5 }, Tools 6 } · Hardware 7
const library = [c(1, "Design", null, 24), c(2, "Development", null, 17), c(3, "Rust", 2, 12), c(4, "Web", 2, 5), c(5, "React", 4, 4), c(6, "Tools", 2, 3), c(7, "Hardware", null, 6)];
const roots = buildTree(library);
const names = (nodes: { item: TreeItem }[]) => nodes.map((n) => n.item.name);

describe("collection tree", () => {
  it("nests by parent and sums totals", () => {
    expect(names(roots)).toEqual(["Design", "Development", "Hardware"]);
    expect(roots[1].total).toBe(17 + 12 + 5 + 4 + 3);
    expect(flatten(roots).map((n) => `${n.depth}${n.item.name}`)).toEqual(["0Design", "0Development", "1Rust", "1Web", "2React", "1Tools", "0Hardware"]);
    expect(names(flatten(roots, new Set([2])))).toEqual(["Design", "Development", "Hardware"]);
  });

  it("puts a collection with a lost parent or in a loop at the top level", () => {
    const tree = buildTree([c(1, "A", 9), c(2, "B", 3), c(3, "C", 2)]);
    expect(names(tree)).toEqual(["A", "B", "C"]);
  });

  it("knows paths and ancestors", () => {
    expect(ancestors(roots, 5).map((a) => a.name)).toEqual(["Development", "Web"]);
    expect(pathPrefix(roots, 5)).toBe("Development › Web › ");
    expect(pathPrefix(roots, 1)).toBe("");
    expect(names(searchTree(roots, "rea"))).toEqual(["React"]);
  });

  it("refuses loops and the fourth level", () => {
    expect(canMoveInto(roots, 2, 5)).toBe(false); // into its own grandchild
    expect(canMoveInto(roots, 4, 1)).toBe(true); // Web { React } under Design: 3 levels
    expect(canMoveInto(roots, 4, 3)).toBe(false); // Web { React } under Rust: 4 levels
    expect(canMoveInto(roots, 7, 5)).toBe(false);
    expect(canMoveInto(roots, 7, 4)).toBe(true);
    expect(canMoveInto(roots, 5, null)).toBe(true);
    expect(canCreateInside(roots, 4)).toBe(true);
    expect(canCreateInside(roots, 5)).toBe(false);
  });

  it("moves by keyboard", () => {
    expect(keyboardMove(roots, 4, "up")).toEqual({ id: 4, parent: 2, before: 3 });
    expect(keyboardMove(roots, 3, "down")).toEqual({ id: 3, parent: 2, before: 6 });
    expect(keyboardMove(roots, 4, "down")).toEqual({ id: 4, parent: 2, before: null });
    expect(keyboardMove(roots, 6, "down")).toBeNull();
    expect(keyboardMove(roots, 1, "up")).toBeNull();
    expect(keyboardMove(roots, 6, "in")).toEqual({ id: 6, parent: 4, before: null });
    expect(keyboardMove(roots, 4, "in")).toBeNull(); // Web { React } under Rust: 4 levels
    expect(keyboardMove(roots, 7, "in")).toEqual({ id: 7, parent: 2, before: null });
    expect(keyboardMove(roots, 5, "out")).toEqual({ id: 5, parent: 2, before: 6 });
    expect(keyboardMove(roots, 3, "out")).toEqual({ id: 3, parent: null, before: 7 });
    expect(keyboardMove(roots, 1, "out")).toBeNull();
  });

  it("tells the place for the announcement", () => {
    expect(placeOf(roots, 4)).toMatchObject({ position: 2, count: 3, parent: { name: "Development" } });
  });

  it("indents options up to the depth limit", () => {
    expect(optionIndent(0)).toBe("");
    expect(optionIndent(5)).toBe(" ".repeat(6));
  });

  it("orders the flat list depth first and scopes a filter", () => {
    expect(inTreeOrder([c(3, "Rust", 2), c(1, "Design", null), c(2, "Development", null)]).map((i) => i.name)).toEqual(["Design", "Development", "Rust"]);
    expect([...scopeIds(library, 2)].sort()).toEqual([2, 3, 4, 5, 6]);
    expect([...scopeIds(library, 2, true)]).toEqual([2]);
    expect([...scopeIds(library, 99)]).toEqual([99]);
  });

  it("applies a move the way the backend orders it", () => {
    const order = (items: TreeItem[]) => flatten(buildTree(items)).map((n) => `${n.depth}${n.item.name}`);
    expect(order(applyMove(library, { id: 7, parent: 2, before: 4 }))).toEqual(["0Design", "0Development", "1Rust", "1Hardware", "1Web", "2React", "1Tools"]);
    expect(order(applyMove(library, { id: 3, parent: null, before: null }))).toEqual(["0Design", "0Development", "1Web", "2React", "1Tools", "0Hardware", "0Rust"]);
    expect(order(applyMove(library, { id: 1, parent: 5, before: null }))).toContain("3Design");
  });

  it("finds where a dragged collection lands", () => {
    const shown = flatten(roots);
    const at = (name: string) => shown.findIndex((n) => n.item.name === name);
    // Hardware onto the middle of Design: inside it.
    expect(treeDrop(roots, shown, 7, at("Design"), "middle")).toMatchObject({ parent: 1, before: null, edge: "into", depth: 1 });
    // Hardware below Rust: after it, inside Development (frame N3).
    expect(treeDrop(roots, shown, 7, at("Rust"), "bottom")).toMatchObject({ parent: 2, before: 4, edge: "after", depth: 1 });
    // Below the open Development: its first child.
    expect(treeDrop(roots, shown, 7, at("Development"), "bottom")).toMatchObject({ parent: 2, before: 3, depth: 1 });
    // Folded, below Development is after it.
    const folded = flatten(roots, new Set([2]));
    expect(treeDrop(roots, folded, 1, folded.findIndex((n) => n.item.id === 2), "bottom")).toMatchObject({ parent: null, before: 7 });
    // Onto itself or its own, past the depth limit, its own place: nothing.
    expect(treeDrop(roots, shown, 2, at("Web"), "middle")).toBeNull();
    expect(treeDrop(roots, shown, 4, at("Rust"), "middle")).toBeNull();
    expect(treeDrop(roots, shown, 7, at("React"), "middle")).toBeNull();
    expect(treeDrop(roots, shown, 4, at("Tools"), "top")).toBeNull();
    expect(treeDrop(roots, shown, 4, at("Rust"), "bottom")).toBeNull();
    expect(treeDrop(roots, shown, 3, at("Web"), "bottom")).toMatchObject({ parent: 4, before: 5 });
  });

  it("names the sibling a drop lands after", () => {
    expect(landsAfter(roots, { id: 7, parent: 2, before: 4 })?.name).toBe("Rust");
    expect(landsAfter(roots, { id: 7, parent: 2, before: 3 })).toBeUndefined();
    expect(landsAfter(roots, { id: 7, parent: null, before: null })?.name).toBe("Development");
  });
});
