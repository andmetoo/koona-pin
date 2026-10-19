/**
 * The phone's library list as the virtualizer draws it (NP-072b, frames L1, L2, Q1): sections on
 * shelves, each a label ("Today") and its rows, or in the grid its rows of cards. Pure, with fixed
 * sizes, so 10,000 bookmarks lay out without measuring anything.
 */

/** The label above a section: 20 above it, the line, 8 down to the shelf (L1: chips 234, label 254, shelf 280). */
export const LABEL_HEIGHT = 46;
/** A section without a label (one run, sorted by title) still keeps the 20 above it. */
export const GAP_HEIGHT = 20;
/** A list row: title 2 lines, meta, a 64 picture (doc/mobile-design.md, Spacing). */
export const ROW_HEIGHT = 88;
/** Between rows of grid cards (L2: 12 both ways). */
export const CARD_GAP = 12;

/**
 * The sizes at a text scale (useTextScale): the label's line, a row's two lines of title and its
 * meta, a card's three lines and its meta grow with the text; the paddings and the picture do not.
 */
export function scaledSizes(scale: number) {
  return {
    row: Math.max(ROW_HEIGHT, Math.round(24 + 64 * scale)),
    label: Math.round(28 + 18 * scale),
    /** A grid card beside its picture: insets, gaps, three lines of title and the meta. */
    cardText: Math.round(34 + 78 * scale),
  };
}

export type ShelfEntry<T> =
  /** A section's start: its label, or only the gap when `group` has none. */
  | { kind: "label"; key: string; group: string; label: boolean; size: number }
  /** One row of a shelf; `first` and `last` round the shelf's corners. */
  | { kind: "row"; key: string; item: T; section: number; first: boolean; last: boolean; size: number }
  /** A row of grid cards; `place` is the first card's place among the items. */
  | { kind: "cards"; key: string; items: T[]; place: number; section: number; size: number };

/** A run of rows on one shelf: the entries it spans, for its paper. */
export type Shelf = { section: number; from: number; to: number; top: number; height: number };

/**
 * The entries for `items` in their order: a new section wherever `groupOf` changes (a null group
 * draws no label); in the grid (`columns`) the cards of a section in rows of `columns`, each
 * `cardHeight` tall with {@link CARD_GAP} under all but a section's last.
 */
export function shelfEntries<T>(
  items: readonly T[],
  {
    groupOf,
    keyOf,
    columns = null,
    cardHeight = 0,
    rowHeight = ROW_HEIGHT,
    labelHeight = LABEL_HEIGHT,
  }: {
    groupOf: (item: T) => string | null;
    keyOf: (item: T) => string | number;
    columns?: number | null;
    cardHeight?: number;
    rowHeight?: number;
    labelHeight?: number;
  },
): ShelfEntry<T>[] {
  const entries: ShelfEntry<T>[] = [];
  let section = -1;
  let start = 0;
  const close = (end: number) => {
    if (section < 0) return;
    const run = items.slice(start, end);
    if (columns) {
      for (let i = 0; i < run.length; i += columns) {
        const last = i + columns >= run.length;
        entries.push({
          kind: "cards",
          key: `c${start + i}`,
          items: run.slice(i, i + columns),
          place: start + i,
          section,
          size: cardHeight + (last ? 0 : CARD_GAP),
        });
      }
    } else {
      run.forEach((item, i) =>
        entries.push({ kind: "row", key: `r${keyOf(item)}`, item, section, first: i === 0, last: i === run.length - 1, size: rowHeight }),
      );
    }
  };
  let current: string | null | undefined;
  items.forEach((item, i) => {
    const group = groupOf(item);
    if (i > 0 && group === current) return;
    close(i);
    section++;
    start = i;
    current = group;
    entries.push({ kind: "label", key: `g${section}:${group ?? ""}`, group: group ?? "", label: group !== null, size: group === null ? GAP_HEIGHT : labelHeight });
  });
  close(items.length);
  return entries;
}

/** Where each entry starts, from the top of the list. */
export function entryStarts(entries: readonly { size: number }[]): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const entry of entries) {
    starts.push(at);
    at += entry.size;
  }
  return starts;
}

/** The shelves of a list (its rows' paper, one shadow per section), from its entries and their starts. */
export function shelvesOf(entries: readonly ShelfEntry<unknown>[], starts: readonly number[]): Shelf[] {
  const shelves: Shelf[] = [];
  entries.forEach((entry, i) => {
    if (entry.kind !== "row") return;
    if (entry.first) shelves.push({ section: entry.section, from: i, to: i, top: starts[i], height: 0 });
    const shelf = shelves[shelves.length - 1];
    shelf.to = i;
    shelf.height = starts[i] + entry.size - shelf.top;
  });
  return shelves;
}
