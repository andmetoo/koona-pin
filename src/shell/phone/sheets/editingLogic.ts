import { ancestors, buildTree, flatten, MAX_DEPTH, pathPrefix, type TreeNode } from "../../../services/collectionTree";
import { foldText } from "../../../services/library";
import type { Collection, Tag } from "../../../types";

// The plain logic of the phone's editing sheets (NP-072b, B1 · C1 · N1), apart from React so
// Vitest can drive it.

/** What the collection picker has chosen: a collection, none, or a new one by its name. */
export type Choice = number | null | { create: string };

export const isNew = (choice: Choice): choice is { create: string } => typeof choice === "object" && choice !== null;

/** The collection as it is now, if it still exists. */
const live = (collections: Collection[], id: number | null | undefined) => (id != null && collections.some((c) => c.id === id) ? id : null);

/**
 * What the picker starts on: what its caller holds (the editor's draft), else the bookmark's own
 * collection, else the suggestion — a link of the inbox has none, and the frame (C1) shows the
 * suggested one checked.
 */
export function firstChoice(collections: Collection[], { selected, current, suggested }: { selected?: number | null; current?: number | null; suggested?: number | null }): Choice {
  if (selected !== undefined) return live(collections, selected);
  return live(collections, current) ?? live(collections, suggested);
}

/** The collections whose name holds the typed text, in the sidebar's order. */
export function matching(collections: Collection[], query: string): Collection[] {
  const typed = foldText(query.trim());
  return typed ? collections.filter((c) => foldText(c.name).includes(typed)) : collections;
}

/** One line of the picker's list. */
export interface PickerRow {
  collection: Collection;
  /** Indent level, 0 at the top; capped at the depth limit, so a tree synced deeper stays on screen. */
  depth: number;
  /** Own bookmarks and every descendant's: what a parent holds. */
  total: number;
  hasChildren: boolean;
  open: boolean;
  /** An ancestor of the chosen collection: it stays open, so the choice is never hidden. */
  locked: boolean;
  /** «Development › Web › » in front of the name in a search, else empty. */
  prefix: string;
}

/**
 * The picker's list (2.19.0), in the sidebar's order: the tree with its folded parents' children
 * left out, or, with a typed query, the flat matches with their paths. Everything starts open
 * (`folded` is what the person closed); the ancestors of `chosen` are always open.
 */
export function pickerRows(
  collections: Collection[],
  {
    query = "",
    folded = new Set<number>(),
    chosen = null,
    roots = buildTree(collections),
  }: { query?: string; folded?: ReadonlySet<number>; chosen?: number | null; /** The tree of `collections`, when the caller holds it. */ roots?: TreeNode<Collection>[] },
): PickerRow[] {
  const cap = MAX_DEPTH - 1;
  if (query.trim()) {
    const hits = new Set(matching(collections, query).map((c) => c.id));
    return flatten(roots)
      .filter((n) => hits.has(n.item.id))
      .map((n) => ({ collection: n.item, depth: 0, total: n.total, hasChildren: false, open: false, locked: false, prefix: pathPrefix(roots, n.item.id) }));
  }
  const locked = new Set(chosen === null ? [] : ancestors(roots, chosen).map((a) => a.id));
  const shut = new Set([...folded].filter((id) => !locked.has(id)));
  return flatten(roots, shut).map((n) => ({
    collection: n.item,
    depth: Math.min(n.depth, cap),
    total: n.total,
    hasChildren: n.children.length > 0,
    open: !shut.has(n.item.id),
    locked: locked.has(n.item.id),
    prefix: "",
  }));
}

/** The typed name when no collection has it already: the picker offers to create it. */
export function newName(collections: Collection[], query: string): string | null {
  const name = query.trim().replace(/\s+/g, " ");
  if (!name) return null;
  const typed = foldText(name);
  return collections.some((c) => foldText(c.name.trim()) === typed) ? null : name;
}

/** A tap on an option: the chosen one again leaves the link without a collection (as AddSheet's chips). */
export function toggle(choice: Choice, option: Choice): Choice {
  const same = isNew(choice) && isNew(option) ? choice.create === option.create : choice === option;
  return same ? null : option;
}

/** Library tags offered under the tag field: those holding the typed text, not on the link yet, most used first. */
export function tagSuggestions(tags: Tag[], typed: string, chosen: string[], limit = 6): Tag[] {
  const text = foldText(typed.trim());
  return tags
    .filter((tag) => !chosen.includes(tag.name) && (!text || foldText(tag.name).includes(text)))
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .slice(0, limit);
}

/**
 * The URL field's text came whole: a paste, or a keyboard's clipboard chip that commits the link
 * as one insertion (Gboard does, with no paste event). Only such a link gets the page's preview
 * asked, as on the desktop (AddSheet): a link typed by hand passes through half-domains.
 */
export const PASTE_MIN = 8;
export function cameWhole(before: string, after: string): boolean {
  return after.length - before.length >= PASTE_MIN && after.trim().length > 0;
}
