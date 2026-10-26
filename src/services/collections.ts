import type { TFunction } from "i18next";
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

/** At most this many bytes of emoji, as `db::valid_icon` takes (2.19.0). */
export const EMOJI_BYTES = 16;
/**
 * A real emoji, as `db::valid_icon` takes (2.19.0): a pictograph or a flag first, then more of them,
 * skin tones and joiners. Letters are refused: «Р» of a word typed in a Cyrillic layout is no icon.
 */
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|\p{Emoji_Modifier}|[‍️⃣])*$/u;
export const isEmoji = (text: string) => EMOJI.test(text) && new TextEncoder().encode(text).length <= EMOJI_BYTES;

/** What a stored icon is: one of the set, an emoji, or nothing (the dot). */
export function iconKind(icon: string | null): { kind: "lucide"; name: CollectionIconName } | { kind: "emoji"; text: string } | null {
  if (!icon) return null;
  if ((COLLECTION_ICONS as readonly string[]).includes(icon)) return { kind: "lucide", name: icon as CollectionIconName };
  // An unknown name, or a letter saved before 2.19.0 checked, is the dot.
  return isEmoji(icon) ? { kind: "emoji", text: icon } : null;
}

/**
 * The emoji a field's text now holds (2.19.0): the newest one typed or pasted, flags and families
 * whole, so a new emoji replaces `saved` wherever the caret was; none when there is no emoji.
 */
export function typedEmoji(text: string, saved: string | null): string | null {
  const Segmenter = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment: (s: string) => Iterable<{ segment: string }> } }).Segmenter;
  const graphemes = Segmenter ? [...new Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((s) => s.segment) : [...text];
  const emoji = graphemes.filter(isEmoji);
  return emoji.filter((e) => e !== saved).pop() ?? emoji.pop() ?? null;
}

/** «They move up into …»: the second paragraph of «Delete collection?» for its children (2.19.0, frame N6). */
export function childrenMoveUp(t: TFunction, language: string, names: string[]): string | undefined {
  if (!names.length) return undefined;
  // «Rust, Web and Tools» in the interface's language; the ES2020 types do not know ListFormat yet.
  const List = (Intl as unknown as { ListFormat: new (language: string, options: { type: string }) => { format: (items: string[]) => string } }).ListFormat;
  const listed = new List(language, { type: "conjunction" }).format(names);
  // One or several, not a plural rule: in Russian «one» is also 21, and 21 names take a plural verb.
  return names.length === 1 ? t("confirm.deleteCollectionChild", { name: listed }) : t("confirm.deleteCollectionChildren", { names: listed });
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
