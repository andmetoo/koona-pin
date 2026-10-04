import type { TFunction } from "i18next";
import { Bookmark, DuplicateGroup, Merged } from "../types";
import { short } from "./undo";

/** Query parameters that only say where a click came from; `utm_*` too (`dedupe.rs`). */
const TRACKING = ["fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "mc_eid", "mc_cid", "igshid"];
const tracking = (name: string) => {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING.includes(lower);
};

/** `dedupe::url_key` for the demo: the same page under every spelling of its address. */
export function urlKey(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const port = url.port ? `:${url.port}` : "";
  const path = url.pathname.replace(/\/+$/, "");
  const pairs = [...url.searchParams].filter(([name]) => !tracking(name)).sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1));
  const query = pairs.length ? `?${new URLSearchParams(pairs).toString()}` : "";
  return `${host}${port}${path}${query}`;
}

/** How far the address is from the plain one; the main bookmark has the least. */
export function clutter(raw: string): number {
  try {
    const url = new URL(raw);
    return (
      Number(url.protocol === "http:") +
      Number(url.hostname.startsWith("www.")) +
      Number(url.hash !== "") +
      Number([...url.searchParams.keys()].some(tracking))
    );
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** `dedupe::groups` for the demo: bookmarks outside the trash with the same key, not all dismissed. */
export function groupsOf(bookmarks: Bookmark[], dismissed: Map<string, Set<number>>): DuplicateGroup[] {
  const byKey = new Map<string, Bookmark[]>();
  for (const b of bookmarks) {
    if (b.deleted_at) continue;
    const key = urlKey(b.url);
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), b]);
  }
  return [...byKey.entries()]
    .filter(([key, list]) => list.length > 1 && list.some((b) => !dismissed.get(key)?.has(b.id)))
    .map(([key, list]) => {
      const sorted = [...list].sort((a, b) => (a.created_at === b.created_at ? a.id - b.id : a.created_at < b.created_at ? -1 : 1));
      const main = sorted.reduce((best, b) => (clutter(b.url) < clutter(best.url) ? b : best), sorted[0]);
      return { key, main: main.id, bookmarks: [main, ...sorted.filter((b) => b !== main)] };
    })
    .sort((a, b) => {
      const newest = (g: DuplicateGroup) => g.bookmarks.reduce((max, b) => (b.created_at > max ? b.created_at : max), "");
      return newest(a) === newest(b) ? (a.key < b.key ? -1 : 1) : newest(a) > newest(b) ? -1 : 1;
    });
}

/**
 * What the main bookmark becomes (`dedupe::merge`): every tag, every note,
 * the star, a collection if it had none, the earliest save, a decision if
 * any had one. The «После объединения» line shows the same.
 */
export function mergedFields(main: Bookmark, others: Bookmark[]): Pick<Bookmark, "tags" | "notes" | "is_favorite" | "collection_id" | "triaged_at" | "created_at"> {
  const ordered = [...others].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const tags = [...(main.tags ?? [])];
  const notes = main.notes?.trim() ? [main.notes.trim()] : [];
  let collection = main.collection_id;
  let triaged = main.triaged_at;
  let created = main.created_at;
  for (const other of ordered) {
    for (const tag of other.tags ?? []) if (!tags.includes(tag)) tags.push(tag);
    const note = other.notes?.trim();
    if (note && !notes.includes(note)) notes.push(note);
    collection ??= other.collection_id;
    triaged ??= other.triaged_at;
    if (other.created_at < created) created = other.created_at;
  }
  return {
    tags,
    notes: notes.length ? notes.join("\n\n") : null,
    is_favorite: main.is_favorite || ordered.some((o) => o.is_favorite),
    collection_id: collection,
    triaged_at: triaged,
    created_at: created,
  };
}

/** The notice after «Объединить» or «Объединить все». */
export function mergedNotice(t: TFunction, merged: Merged): string {
  if (merged.groups === 1 && merged.title !== null)
    return t("duplicates.merged", { count: merged.trashed + 1, title: short(merged.title) });
  return t("duplicates.mergedMany", { count: merged.groups, trashed: merged.trashed });
}
