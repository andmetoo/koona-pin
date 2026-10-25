import type { Bookmark } from "../types";

// Collection colours of iteration 1 (docs/design.md). Old
// libraries keep colours of «Редакция» in the database; the interface picks
// from the new palette by id so a collection keeps its colour.
export const PALETTE = ["terracotta", "green", "ochre", "blue", "lilac"] as const;
export type PaletteColor = (typeof PALETTE)[number];

export const collectionColor = (id: number) =>
  `var(--np-${PALETTE[(Math.abs(id) - 1 + PALETTE.length) % PALETTE.length]})`;

/**
 * The colour a collection is drawn in (2.19.0): the palette colour the person
 * chose, else the one its id picks, as before.
 */
export function collectionTint(c: { id: number; color: string | null }): string {
  return (PALETTE as readonly string[]).includes(c.color ?? "") ? `var(--np-${c.color})` : collectionColor(c.id);
}

/** The Lucide icons a collection may wear (2.19.0), in the order the picker shows them. */
export const COLLECTION_ICONS = [
  "folder", "code", "palette", "book-open", "briefcase", "house", "heart", "star",
  "bookmark", "music", "film", "camera", "gamepad-2", "plane", "map-pin", "shopping-cart",
  "utensils", "coffee", "dumbbell", "graduation-cap", "flask-conical", "cpu", "wrench", "newspaper",
  "globe", "lightbulb", "pen-tool", "rocket", "leaf", "paw-print", "car", "wallet",
  "chart-line", "calendar", "users", "gift", "bot", "terminal", "cloud", "sun",
] as const;
export type CollectionIconName = (typeof COLLECTION_ICONS)[number];

/** What a stored icon is: one of the set, an emoji, or nothing (the dot). */
export function iconKind(icon: string | null): { kind: "lucide"; name: CollectionIconName } | { kind: "emoji"; text: string } | null {
  if (!icon) return null;
  if ((COLLECTION_ICONS as readonly string[]).includes(icon)) return { kind: "lucide", name: icon as CollectionIconName };
  // Anything with a non-ASCII character is an emoji the person typed; an unknown name is the dot.
  return /[^\x00-\x7f]/.test(icon) ? { kind: "emoji", text: icon } : null;
}

/**
 * The name «Новая коллекция из выбранного» offers (Р-27): the site more than
 * half of the selection shares, else a tag every one of them has; none
 * otherwise. Only bookmarks the list has loaded are known.
 */
export function suggestedName(selected: Pick<Bookmark, "domain" | "tags">[]): string | null {
  if (!selected.length) return null;
  const sites = new Map<string, number>();
  for (const b of selected) sites.set(b.domain, (sites.get(b.domain) ?? 0) + 1);
  const [site, count] = [...sites].sort((a, b) => b[1] - a[1])[0];
  if (count * 2 > selected.length) return site;
  const [first, ...rest] = selected;
  return (first.tags ?? []).find((tag) => rest.every((b) => b.tags?.includes(tag))) ?? null;
}
