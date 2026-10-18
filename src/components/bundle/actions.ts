import { useSyncExternalStore } from "react";
import type { TFunction } from "i18next";
import type { Bookmark, FilterState } from "../../types";
import { api } from "../../services/api";
import { Added, bundle, BundleView } from "../../services/bundle";

/** The bundle as React sees it: re-renders on every change. */
export const useBundle = () => useSyncExternalStore(bundle.subscribe, bundle.get);

/** A page of the library is at most this long (`db::MAX_PAGE_SIZE`). */
const PAGE = 1_000;

/** Every bookmark of a view, page by page, in its order. */
export async function viewBookmarks(filters: Partial<FilterState>): Promise<Bookmark[]> {
  const all: Bookmark[] = [];
  let after: Awaited<ReturnType<typeof api.getBookmarks>>["next"] = null;
  do {
    const page = await api.getBookmarks(filters, { limit: PAGE, ...(after ? { after } : {}) });
    all.push(...page.items);
    after = page.next;
  } while (after);
  return all;
}

/** The bookmarks of these ids: the loaded ones as they are, the rest read one by one. */
export async function bookmarksByIds(ids: Iterable<number>, loaded: Bookmark[]): Promise<Bookmark[]> {
  const known = new Map(loaded.map((b) => [b.id, b]));
  const found = await Promise.all(
    [...ids].map(async (id) => known.get(id) ?? (await api.getBookmarks({}, { id, limit: 1 })).items[0] ?? null),
  );
  return found.filter((b): b is Bookmark => !!b);
}

/** «Add {view}» (N6): the view's items at this moment, into its section. */
export async function addView(view: BundleView): Promise<Added> {
  if (view.kind === "feeds") return bundle.addFeeds(view.feeds);
  if (view.kind === "collection") return bundle.addCollection(view.collection, await viewBookmarks({ collectionId: view.collection.id }));
  if (view.kind === "tag") return bundle.addTag(view.name, await viewBookmarks({ tag: view.name }));
  return bundle.addBookmarks(await viewBookmarks(view.filters));
}

/** What the live region says after an add: «Added 3 bookmarks to the bundle, 17 items». */
export function addedText(t: TFunction, added: Added): string {
  if (added.kind === "already") return t("bundle.already", { name: added.name });
  const items = t("bundle.items", { count: added.total });
  if (added.added === 0) return t("bundle.nothingNew", { items });
  if (added.kind === "section") return t("bundle.addedSection", { name: added.name, items });
  return t(added.kind === "feeds" ? "bundle.addedFeeds" : "bundle.addedBookmarks", { count: added.added, items });
}

/** Bookmarks no longer in the library or in Trash leave the bundle; feeds no longer followed too. */
export async function pruneBundle(): Promise<number> {
  if (!bundle.get().sections.length) return 0;
  const [ids, feeds] = await Promise.all([api.getBookmarkIds({}), api.listFeeds().catch(() => null)]);
  return bundle.prune(new Set(ids), feeds && new Set(feeds.map((f) => f.uid)));
}
