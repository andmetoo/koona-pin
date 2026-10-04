import {
  AddedLink,
  Bookmark,
  BookmarkChange,
  BookmarkPage,
  Collection,
  DataSummary,
  FilterState,
  ImportSummary,
  LibraryPlace,
  LibraryStatus,
  CaptureStatus,
} from "../types";
import type { PageRequest } from "./api";
import { demoBookmarks, demoCollections, posterOf } from "./demoData";
import { isAfter, listTime, matchesBookmark, sortBookmarks } from "./library";
import { CommandError } from "./errors";
import i18n from "../i18n";

const demoCaptureStatus: CaptureStatus = {
  state: "none",
  browsers: [],
  last_capture: null,
  days_silent: null,
  problem: null,
  detail: null,
  protocol: 2,
};

// v2: generated previews instead of the drawn ones of the concepts; v3: the inbox; v4: the trash.
const key = "netamipin.demo.v4";
const stamp = (i: number) => new Date(Date.UTC(2026, 9, 2 - i, 12)).toISOString();
let initial = {
  bookmarks: demoBookmarks.map((b, i): Bookmark => ({
    id: b.id,
    url: b.url,
    title: b.title,
    description: b.description ?? null,
    image_url: posterOf(b),
    favicon_url: null,
    domain: b.domain,
    notes: b.notes || null,
    is_favorite: b.favorite,
    collection_id: demoCollections.indexOf(b.collection) + 1,
    tags: b.tags,
    created_at: stamp(i),
    updated_at: stamp(i),
    revision: 1,
    triaged_at: b.inbox ? null : stamp(i),
    deleted_at: null,
  })),
  collections: demoCollections.map((name, i): Collection => ({
    id: i + 1,
    name,
    color: null,
    icon: null,
    count: null,
    created_at: "2026-10-02T00:00:00.000Z",
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
/** Everything outside the trash: what the library, its counts and catalogs show. */
const live = () => bookmarks.filter((b) => !b.deleted_at);
/** A stored change with a new revision, like an UPDATE in the desktop app. */
function change(previous: Bookmark, fields: Partial<Bookmark>): Bookmark {
  const b = { ...previous, ...fields, revision: (previous.revision ?? 1) + 1, updated_at: new Date().toISOString() };
  bookmarks = bookmarks.map((item) => (item.id === b.id ? b : item));
  persist();
  return b;
}
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
  async getBookmarks(
    filters: Partial<FilterState> = {},
    page: PageRequest = {},
  ): Promise<BookmarkPage> {
    const found = sortBookmarks(
      bookmarks.filter(
        (b) =>
          (page.id === undefined || b.id === page.id) &&
          matchesBookmark(b, filters),
      ),
    );
    const rest = page.after
      ? found.filter((b) => isAfter(b, page.after!))
      : found;
    const items = rest.slice(0, page.limit ?? 100);
    const last = items.at(-1);
    return {
      items,
      total: page.after ? null : found.length,
      next:
        last && rest.length > items.length
          ? { at: listTime(last), id: last.id }
          : null,
      since_counts:
        page.since && !page.after
          ? page.since.map(
              (start) => found.filter((b) => listTime(b) >= start).length,
            )
          : null,
    };
  },
  async rebuildSearchIndex() {
    return bookmarks.length;
  },
  async getCollections() {
    return collections.map((c) => ({
      ...c,
      count: live().filter((b) => b.collection_id === c.id).length,
    }));
  },
  async getTags() {
    return [...new Set(live().flatMap((b) => b.tags ?? []))].map(
      (name, i) => ({
        id: i + 1,
        name,
        count: live().filter((b) => b.tags?.includes(name)).length,
      }),
    );
  },
  async getDomains() {
    return [...new Set(live().map((b) => b.domain))].map((domain) => ({
      domain,
      count: live().filter((b) => b.domain === domain).length,
    }));
  },
  async getCounts() {
    const inbox = live().filter((b) => b.triaged_at === null);
    return {
      total: live().length,
      favorites: live().filter((b) => b.is_favorite).length,
      inbox: inbox.length,
      inbox_newest: inbox.reduce<string | null>((newest, b) => (newest === null || b.created_at > newest ? b.created_at : newest), null),
      trash: bookmarks.length - live().length,
    };
  },
  async addBookmark(
    data: {
      url: string;
      title?: string;
      collectionId?: number | null;
      tags?: string[];
    },
    /** An import goes straight to the library, as in the desktop app. */
    imported = false,
  ): Promise<AddedLink> {
    let url: URL;
    try {
      url = new URL(data.url.trim());
    } catch {
      throw new CommandError("invalid_request", "Некорректная ссылка");
    }
    if (!["http:", "https:"].includes(url.protocol))
      throw new CommandError(
        "invalid_request",
        "Поддерживаются только ссылки HTTP/HTTPS",
      );
    const previous = bookmarks.find((b) => b.url === data.url.trim());
    if (previous?.deleted_at && !imported) {
      // Saved again from the trash: back with its fields, waiting in the inbox.
      const back = change(previous, { deleted_at: null, triaged_at: null });
      emit("created", back);
      return { bookmark: back, restored: true };
    }
    if (previous) return { bookmark: previous, restored: false };
    const b: Bookmark = {
      id: Date.now(),
      url: data.url.trim(),
      title: data.title?.trim() || url.hostname,
      description: null,
      image_url: null,
      favicon_url: null,
      notes: null,
      domain: url.hostname.replace(/^www\./, ""),
      collection_id: data.collectionId ?? null,
      tags: data.tags ?? [],
      is_favorite: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      revision: 1,
      triaged_at: imported ? new Date().toISOString() : null,
      deleted_at: null,
    };
    bookmarks = [b, ...bookmarks];
    persist();
    emit("created", b);
    return { bookmark: b, restored: false };
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
    if (!previous) throw new CommandError("not_found", "Закладка удалена");
    const now = new Date().toISOString();
    // Any decision sorts the bookmark, as `update_bookmark` does.
    const b = {
      ...previous,
      ...data,
      revision: (previous.revision ?? 1) + 1,
      updated_at: now,
      triaged_at: previous.triaged_at ?? now,
    };
    bookmarks = bookmarks.map((item) => (item.id === id ? b : item));
    persist();
    emit("updated", b);
    return b;
  },
  async trashBookmark(id: number) {
    const previous = bookmarks.find((b) => b.id === id);
    if (!previous) throw new CommandError("not_found", "Закладка удалена");
    if (previous.deleted_at) return previous;
    const b = change(previous, { deleted_at: new Date().toISOString() });
    emit("updated", b);
    return b;
  },
  async restoreBookmark(id: number) {
    const previous = bookmarks.find((b) => b.id === id);
    if (!previous) throw new CommandError("not_found", "Закладка удалена");
    if (!previous.deleted_at) return previous;
    const b = change(previous, { deleted_at: null });
    emit("updated", b);
    return b;
  },
  /** Only from the trash, like the desktop app (NP-023). */
  async deleteForever(id: number) {
    const b = bookmarks.find((item) => item.id === id && item.deleted_at);
    if (!b) throw new CommandError("not_found", "Этой закладки нет в корзине");
    bookmarks = bookmarks.filter((item) => item.id !== id);
    persist();
    emit("deleted", { ...b, revision: (b.revision ?? 1) + 1 });
  },
  async emptyTrash() {
    const gone = bookmarks.length - live().length;
    bookmarks = live();
    persist();
    invalidations.forEach((fn) => fn());
    return gone;
  },
  async createCollection(name: string, color?: string, icon?: string) {
    if (collections.some((c) => c.name === name.trim()))
      throw new CommandError("conflict", "Такая коллекция уже есть");
    const c: Collection = {
      id: Date.now(),
      name: name.trim(),
      color: color ?? null,
      icon: icon ?? null,
      count: 0,
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
    const summary: ImportSummary = { imported: 0, in_trash: 0 };
    for (const a of document.querySelectorAll("a[href]")) {
      const url = a.getAttribute("href")!;
      const known = bookmarks.find((b) => b.url === url);
      // A repeated import does not undo a clean-up.
      if (known?.deleted_at) summary.in_trash++;
      if (known) continue;
      try {
        await demo.addBookmark({ url, title: a.textContent?.trim() }, true);
        summary.imported++;
      } catch {
        /* Invalid schemes are skipped. */
      }
    }
    return summary;
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
    return { close_to_tray: true };
  },
  async setCloseToTray(_enabled: boolean) {
    /* Desktop-only setting. */
  },
  /** The preview has no browser extension: never connected. */
  async getCaptureStatus(): Promise<CaptureStatus> {
    return demoCaptureStatus;
  },
  onCaptureStatus(_fn: (status: CaptureStatus) => void) {
    return () => {};
  },
  async repairCapture(): Promise<CaptureStatus> {
    return demoCaptureStatus;
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
  async getAutostart() {
    return false;
  },
  async setAutostart(_enabled: boolean) {
    /* Desktop-only. */
  },
  async getDataSummary(): Promise<DataSummary> {
    return {
      library_folder: "%APPDATA%\\Netami Pin",
      backups_folder: "%APPDATA%\\Netami Pin\\backups",
      copies: 0,
      bytes: 0,
      last_copy: null,
    };
  },
  async backUpNow(): Promise<DataSummary> {
    throw new CommandError("internal", i18n.t("settings.desktopOnly"));
  },
  async getVersion() {
    return "demo";
  },
};
