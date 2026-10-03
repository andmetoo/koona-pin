import {
  Bookmark,
  BookmarkChange,
  Collection,
  FilterState,
  LibraryPlace,
  LibraryStatus,
} from "../types";
import { collectionNames, seedBookmarks } from "../concepts/data";
import { matchesBookmark, sortBookmarks } from "./library";

const key = "netamipin.demo.v1";
let initial = {
  bookmarks: seedBookmarks.map((b, i): Bookmark => ({
    id: b.id,
    url: b.url,
    title: b.title,
    description: b.description,
    domain: b.domain,
    notes: b.notes,
    is_favorite: b.favorite,
    collection_id: collectionNames.indexOf(b.collection) + 1,
    tags: b.tags,
    created_at: new Date(Date.UTC(2026, 9, 2 - i, 12)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 9, 2 - i, 12)).toISOString(),
    revision: 1,
    preview_kind: b.preview,
  })),
  collections: collectionNames.map((name, i): Collection => ({
    id: i + 1,
    name,
    created_at: "2026-10-02",
  })),
};
try {
  const saved = JSON.parse(localStorage.getItem(key) || "null");
  if (saved?.bookmarks && saved?.collections) initial = saved;
} catch {
  /* Recover a corrupted preview only; never accesses the desktop DB. */
}
let bookmarks: Bookmark[] = initial.bookmarks;
let collections: Collection[] = initial.collections;
const listeners = new Set<(change: BookmarkChange) => void>();
const invalidations = new Set<() => void>();
function persist() {
  localStorage.setItem(key, JSON.stringify({ bookmarks, collections }));
}
function emit(kind: BookmarkChange["kind"], b: Bookmark) {
  for (const fn of listeners)
    fn({
      kind,
      id: b.id,
      revision: b.revision ?? 1,
      bookmark: kind === "deleted" ? null : b,
    });
}
export const demo = {
  async getBookmarks(filters: Partial<FilterState> = {}) {
    return sortBookmarks(bookmarks.filter((b) => matchesBookmark(b, filters)));
  },
  async getCollections() {
    return collections.map((c) => ({
      ...c,
      count: bookmarks.filter((b) => b.collection_id === c.id).length,
    }));
  },
  async getTags() {
    return [...new Set(bookmarks.flatMap((b) => b.tags ?? []))].map(
      (name, i) => ({
        id: i + 1,
        name,
        count: bookmarks.filter((b) => b.tags?.includes(name)).length,
      }),
    );
  },
  async getDomains() {
    return [...new Set(bookmarks.map((b) => b.domain))].map((domain) => ({
      domain,
      count: bookmarks.filter((b) => b.domain === domain).length,
    }));
  },
  async getCounts() {
    return {
      total: bookmarks.length,
      favorites: bookmarks.filter((b) => b.is_favorite).length,
    };
  },
  async addBookmark(data: {
    url: string;
    title?: string;
    collectionId?: number | null;
    tags?: string[];
  }) {
    const url = new URL(data.url.trim());
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("Поддерживаются только HTTP/HTTPS");
    const previous = bookmarks.find((b) => b.url === data.url.trim());
    if (previous) return previous;
    const b: Bookmark = {
      id: Date.now(),
      url: data.url.trim(),
      title: data.title?.trim() || url.hostname,
      domain: url.hostname.replace(/^www\./, ""),
      collection_id: data.collectionId ?? null,
      tags: data.tags ?? [],
      is_favorite: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      revision: 1,
    };
    bookmarks = [b, ...bookmarks];
    persist();
    emit("created", b);
    return b;
  },
  async updateBookmark(
    id: number,
    data: {
      title?: string;
      notes?: string;
      is_favorite?: boolean;
      collection_id?: number | null;
      tags?: string[];
    },
  ) {
    const previous = bookmarks.find((b) => b.id === id);
    if (!previous) throw new Error("Закладка удалена");
    const b = {
      ...previous,
      ...data,
      revision: (previous.revision ?? 1) + 1,
      updated_at: new Date().toISOString(),
    };
    bookmarks = bookmarks.map((item) => (item.id === id ? b : item));
    persist();
    emit("updated", b);
    return b;
  },
  async deleteBookmark(id: number) {
    const b = bookmarks.find((b) => b.id === id);
    bookmarks = bookmarks.filter((b) => b.id !== id);
    persist();
    if (b) emit("deleted", { ...b, revision: (b.revision ?? 1) + 1 });
    return true;
  },
  async createCollection(name: string, color?: string, icon?: string) {
    if (collections.some((c) => c.name === name.trim()))
      throw new Error("Такая коллекция уже есть");
    const c = {
      id: Date.now(),
      name: name.trim(),
      color,
      icon,
      created_at: new Date().toISOString(),
    };
    collections = [...collections, c];
    persist();
    return c;
  },
  async deleteCollection(id: number) {
    collections = collections.filter((c) => c.id !== id);
    bookmarks = bookmarks.map((b) =>
      b.collection_id === id
        ? { ...b, collection_id: null, revision: (b.revision ?? 1) + 1 }
        : b,
    );
    persist();
    invalidations.forEach((fn) => fn());
    return true;
  },
  async importHtmlBookmarks(content: string) {
    const document = new DOMParser().parseFromString(content, "text/html");
    let count = 0;
    for (const a of document.querySelectorAll("a[href]")) {
      const url = a.getAttribute("href")!;
      if (bookmarks.some((b) => b.url === url)) continue;
      try {
        await demo.addBookmark({ url, title: a.textContent?.trim() });
        count++;
      } catch {
        /* Invalid schemes are skipped. */
      }
    }
    return count;
  },
  async openUrl(url: string) {
    window.open(url, "_blank", "noopener,noreferrer");
  },
  onBookmarkChanged(fn: (change: BookmarkChange) => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  onLibraryInvalidated(fn: () => void) {
    invalidations.add(fn);
    return () => {
      invalidations.delete(fn);
    };
  },
  async getAppSettings() {
    return { capture_token: "", close_to_tray: true };
  },
  async setCloseToTray(_enabled: boolean) {
    /* Desktop-only setting. */
  },
  async getServerStatus() {
    return {
      running: false,
      address: "127.0.0.1:28765",
      error: "Демонстрационное превью в браузере",
      legacy_app: false,
    };
  },
  async getLibraryStatus(): Promise<LibraryStatus> {
    return { state: "ready", damaged: false, moved_aside: null };
  },
  onLibraryStatus(_fn: (status: LibraryStatus) => void) {
    return () => {};
  },
  async retryLibrary() {
    /* The demo library always opens. */
  },
  async revealLibraryPlace(_place: LibraryPlace) {
    /* No folders in the browser preview. */
  },
  async quitApp() {
    /* Desktop-only. */
  },
};
