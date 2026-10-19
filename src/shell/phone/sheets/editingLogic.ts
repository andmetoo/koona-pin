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
