/**
 * Nested collections (2.19.0): the tree the sidebar, the pickers and the phone
 * draw from the flat list `get_collections` returns. A collection sits in at
 * most `MAX_DEPTH` levels; a parent shows its own bookmarks and its
 * descendants', so its total is summed here from the own counts.
 */

/** What the tree needs of a collection; `Collection` from the bindings fits. */
export interface TreeItem {
  id: number;
  name: string;
  parent_id: number | null;
  count: number | null;
}

/** Top level is 1; a move or a new collection deeper than this is refused. */
export const MAX_DEPTH = 3;

export interface TreeNode<T extends TreeItem = TreeItem> {
  item: T;
  /** 0 for the top level; a tree synced deeper than `MAX_DEPTH` keeps its real depth. */
  depth: number;
  children: TreeNode<T>[];
  /** Own bookmarks and every descendant's. */
  total: number;
}

/**
 * The tree in the order of `items` (the backend sends siblings in their
 * order). A collection whose parent is unknown, or that would close a loop,
 * stands at the top level: the interface never hides a collection.
 */
export function buildTree<T extends TreeItem>(items: readonly T[]): TreeNode<T>[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const parentOf = (item: T): number | null => {
    // Walk up: a loop (only possible mid-sync) makes the item a root.
    const seen = new Set([item.id]);
    for (let p = item.parent_id; p !== null; p = byId.get(p)?.parent_id ?? null) {
      if (!byId.has(p) || seen.has(p)) return null;
      seen.add(p);
    }
    return item.parent_id;
  };
  const kids = new Map<number | null, T[]>();
  for (const item of items) {
    const parent = parentOf(item);
    kids.set(parent, [...(kids.get(parent) ?? []), item]);
  }
  const grow = (item: T, depth: number): TreeNode<T> => {
    const children = (kids.get(item.id) ?? []).map((child) => grow(child, depth + 1));
    return { item, depth, children, total: (item.count ?? 0) + children.reduce((sum, c) => sum + c.total, 0) };
  };
  return (kids.get(null) ?? []).map((item) => grow(item, 0));
}

const trees = new WeakMap<readonly TreeItem[], TreeNode[]>();

/**
 * `buildTree` once per list: the app state and the menus built on demand hold the same array of
 * collections until it changes, so they share one tree.
 */
export function treeOf<T extends TreeItem>(items: readonly T[]): TreeNode<T>[] {
  let tree = trees.get(items) as TreeNode<T>[] | undefined;
  if (!tree) trees.set(items, (tree = buildTree(items)));
  return tree;
}

/** Every node, depth first, in the order the sidebar shows them. */
export function flatten<T extends TreeItem>(roots: readonly TreeNode<T>[], folded: ReadonlySet<number> = new Set()): TreeNode<T>[] {
  const out: TreeNode<T>[] = [];
  const walk = (node: TreeNode<T>) => {
    out.push(node);
    if (!folded.has(node.item.id)) node.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

export function findNode<T extends TreeItem>(roots: readonly TreeNode<T>[], id: number): TreeNode<T> | undefined {
  for (const node of roots) {
    if (node.item.id === id) return node;
    const inside = findNode(node.children, id);
    if (inside) return inside;
  }
  return undefined;
}

/** The ids of a collection and everything inside it. */
export function subtreeIds(node: TreeNode): number[] {
  return [node.item.id, ...node.children.flatMap(subtreeIds)];
}

/** Levels the subtree takes: 1 for a collection with no children. */
export function height(node: TreeNode): number {
  return 1 + Math.max(0, ...node.children.map(height));
}

/** The ancestors of `id`, the top level first (not `id` itself). */
export function ancestors<T extends TreeItem>(roots: readonly TreeNode<T>[], id: number): T[] {
  const path: T[] = [];
  const walk = (nodes: readonly TreeNode<T>[]): boolean =>
    nodes.some((node) => {
      if (node.item.id === id) return true;
      path.push(node.item);
      if (walk(node.children)) return true;
      path.pop();
      return false;
    });
  return walk(roots) ? path : [];
}

/** «Development › Web › » before a name in a search result; empty at the top level. */
export function pathPrefix(roots: readonly TreeNode[], id: number): string {
  return ancestors(roots, id)
    .map((a) => `${a.name} › `)
    .join("");
}

/**
 * Whether `id` (with its subtree) may go into `parent` (none: the top level). A tree synced deeper
 * than `MAX_DEPTH` still moves where it gets no deeper than it is, as `db::move_collection` takes.
 */
export function canMoveInto(roots: readonly TreeNode[], id: number, parent: number | null): boolean {
  const node = findNode(roots, id);
  if (!node) return false;
  const levels = (above: number) => above + height(node);
  const fits = (above: number) => levels(above) <= Math.max(MAX_DEPTH, levels(node.depth));
  if (parent === null) return fits(0);
  if (subtreeIds(node).includes(parent)) return false;
  const target = findNode(roots, parent);
  return !!target && fits(target.depth + 1);
}

/** Whether a new collection may be made inside `parent`. */
export function canCreateInside(roots: readonly TreeNode[], parent: number): boolean {
  const target = findNode(roots, parent);
  return !!target && target.depth + 1 < MAX_DEPTH;
}

/** A move for `move_collection`: into `parent`, before `before` (none: last). */
export interface CollectionMove {
  id: number;
  parent: number | null;
  before: number | null;
}

function siblingsOf(roots: readonly TreeNode[], id: number): { list: readonly TreeNode[]; parent: TreeNode | undefined } {
  const parent = ancestors(roots, id).at(-1);
  const node = parent ? findNode(roots, parent.id) : undefined;
  return { list: node ? node.children : roots, parent: node };
}

/**
 * The keyboard's moves (`Alt` + arrows): up and down among the siblings,
 * right into the sibling above as its last child, left out to just after the
 * parent. None when the move is not possible (an edge, the depth limit).
 */
export function keyboardMove(roots: readonly TreeNode[], id: number, key: "up" | "down" | "in" | "out"): CollectionMove | null {
  const { list, parent } = siblingsOf(roots, id);
  const at = list.findIndex((n) => n.item.id === id);
  if (at < 0) return null;
  const parentId = parent?.item.id ?? null;
  switch (key) {
    case "up":
      return at > 0 ? { id, parent: parentId, before: list[at - 1].item.id } : null;
    case "down":
      if (at >= list.length - 1) return null;
      return { id, parent: parentId, before: list[at + 2]?.item.id ?? null };
    case "in": {
      const above = list[at - 1];
      return above && canMoveInto(roots, id, above.item.id) ? { id, parent: above.item.id, before: null } : null;
    }
    case "out": {
      if (!parent) return null;
      const outer = siblingsOf(roots, parent.item.id).list;
      const next = outer[outer.findIndex((n) => n.item.id === parent.item.id) + 1];
      return { id, parent: ancestors(roots, parent.item.id).at(-1)?.id ?? null, before: next?.item.id ?? null };
    }
  }
}

/** Where a collection stands after a move, for the announcement: its parent and place. */
export function placeOf(roots: readonly TreeNode[], id: number): { parent: TreeItem | undefined; position: number; count: number } {
  const { list, parent } = siblingsOf(roots, id);
  return { parent: parent?.item, position: list.findIndex((n) => n.item.id === id) + 1, count: list.length };
}

/** The collections whose name holds `query` (case aside), in tree order. */
export function searchTree<T extends TreeItem>(roots: readonly TreeNode<T>[], query: string): TreeNode<T>[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [];
  return flatten(roots).filter((n) => n.item.name.toLocaleLowerCase().includes(q));
}

/** Indentation for a native `<option>`: three no-break spaces per level, capped at the depth limit. */
export function optionIndent(depth: number): string {
  return "   ".repeat(Math.min(depth, MAX_DEPTH - 1));
}

/** The flat list in the sidebar's order: parents before their children, depth first. */
export function inTreeOrder<T extends TreeItem>(items: readonly T[]): T[] {
  return flatten(buildTree(items)).map((n) => n.item);
}

/**
 * The collections a filter on `id` shows (2.19.0): the collection and every
 * one inside it, or the collection alone with «Only this collection».
 */
export function scopeIds(items: readonly TreeItem[], id: number, only = false): Set<number> {
  if (only) return new Set([id]);
  const node = findNode(buildTree(items), id);
  return new Set(node ? subtreeIds(node) : [id]);
}

/**
 * `items` after a move, as the backend will order them (2.19.0): the moved
 * one gets its new parent and stands before `before` among its new siblings,
 * or after the last of them. Shown at once while the move is written.
 */
export function applyMove<T extends TreeItem>(items: readonly T[], move: CollectionMove): T[] {
  const moved = items.find((item) => item.id === move.id);
  if (!moved) return [...items];
  const rest = items.filter((item) => item.id !== move.id);
  const placed = { ...moved, parent_id: move.parent };
  const at = move.before === null ? -1 : rest.findIndex((item) => item.id === move.before);
  if (at >= 0) return [...rest.slice(0, at), placed, ...rest.slice(at)];
  let last = -1;
  rest.forEach((item, i) => {
    if (item.parent_id === move.parent) last = i;
  });
  return last < 0 ? [...rest, placed] : [...rest.slice(0, last + 1), placed, ...rest.slice(last + 1)];
}

/** Where a dragged collection would land (2.19.0): the move, and what the sidebar draws for it. */
export interface TreeDrop extends CollectionMove {
  /** The row the indicator belongs to. */
  row: number;
  /** A line above or below that row, or the row lit as the parent. */
  edge: "before" | "after" | "into";
  /** The level the moved collection would take: the line's indent. */
  depth: number;
}

/**
 * The drop for a pointer over row `index` of the shown rows (`shown`, the
 * flattened tree as drawn): its top quarter puts the collection before the
 * row, its bottom quarter after it (or first inside it when it is an open
 * parent), its middle half inside it. None for an impossible move — onto
 * itself or its own, past the depth limit — or one that changes nothing.
 */
export function treeDrop(roots: readonly TreeNode[], shown: readonly TreeNode[], id: number, index: number, zone: "top" | "middle" | "bottom"): TreeDrop | null {
  const node = shown[index];
  const dragged = findNode(roots, id);
  if (!node || !dragged || subtreeIds(dragged).includes(node.item.id)) return null;
  const parentOf = (target: TreeNode) => ancestors(roots, target.item.id).at(-1)?.id ?? null;
  const childrenOf = (parent: number | null) => (parent === null ? roots : (findNode(roots, parent)?.children ?? [])).filter((n) => n.item.id !== id);
  let drop: TreeDrop;
  if (zone === "middle") drop = { id, parent: node.item.id, before: null, row: node.item.id, edge: "into", depth: node.depth + 1 };
  else if (zone === "top") drop = { id, parent: parentOf(node), before: node.item.id, row: node.item.id, edge: "before", depth: node.depth };
  else if (node.children.length && shown[index + 1]?.depth === node.depth + 1)
    drop = { id, parent: node.item.id, before: childrenOf(node.item.id)[0]?.item.id ?? null, row: node.item.id, edge: "after", depth: node.depth + 1 };
  else {
    const siblings = childrenOf(parentOf(node));
    const next = siblings[siblings.findIndex((n) => n.item.id === node.item.id) + 1];
    drop = { id, parent: parentOf(node), before: next?.item.id ?? null, row: node.item.id, edge: "after", depth: node.depth };
  }
  if (!canMoveInto(roots, id, drop.parent)) return null;
  // Its own place: nothing to draw, nothing to write.
  const own = siblingsOf(roots, id).list;
  const after = own[own.findIndex((n) => n.item.id === id) + 1]?.item.id ?? null;
  if (drop.parent === parentOf(dragged) && drop.before === after) return null;
  return drop;
}

/** The sibling a drop lands after, for the hint «Into Development, after Rust»; none: first. */
export function landsAfter<T extends TreeItem>(roots: readonly TreeNode<T>[], drop: CollectionMove): T | undefined {
  const list = (drop.parent === null ? roots : (findNode(roots, drop.parent)?.children ?? [])).filter((n) => n.item.id !== drop.id);
  const at = drop.before === null ? list.length : list.findIndex((n) => n.item.id === drop.before);
  return at > 0 ? list[at - 1].item : undefined;
}

/** Each collection's level, 0 for the top: a native `<option>` is indented by it. */
export function depths(items: readonly TreeItem[]): Map<number, number> {
  return new Map(flatten(buildTree(items)).map((n) => [n.item.id, n.depth]));
}
