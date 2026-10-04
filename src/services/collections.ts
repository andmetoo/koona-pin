import type { Bookmark } from "../types";

// Collection colours of iteration 1 (doc/guidelines.md, «Цвет»). Old
// libraries keep colours of «Редакция» in the database; the interface picks
// from the new palette by id so a collection keeps its colour.
const palette = ["terracotta", "green", "blue", "ochre", "lilac"] as const;

export const collectionColor = (id: number) =>
  `var(--np-${palette[(Math.abs(id) - 1 + palette.length) % palette.length]})`;

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
