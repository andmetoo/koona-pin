import { describe, expect, it } from "vitest";
import { buildTree } from "../../../services/collectionTree";
import { chipRows } from "./chipRows";

const item = (id: number, name: string, parent_id: number | null = null, count = 0) => ({ id, name, parent_id, count });
// Development > (Rust, Web > React), Design, Read later.
const roots = buildTree([item(1, "Development", null, 5), item(2, "Rust", 1, 12), item(3, "Web", 1, 9), item(4, "React", 3, 4), item(5, "Design"), item(6, "Read later")]);

describe("the Library's chip rows", () => {
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
