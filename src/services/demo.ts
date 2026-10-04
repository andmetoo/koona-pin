import {
  AddedLink,
  Bookmark,
  BookmarkChange,
  BookmarkPage,
  BulkChange,
  BulkChanged,
  Changed,
  Collection,
  CommandAction,
  DataSummary,
  FilterState,
  CsvColumns,
  ExportFormat,
  ExportOutcome,
  ImportProgress,
  ImportSummary,
  LibraryPlace,
  LibraryStatus,
  CaptureStatus,
  Undo,
} from "../types";
import type { PageRequest } from "./api";
import { demoBookmarks, demoCollections, posterOf } from "./demoData";
import { parseBookmarksFile } from "./bookmarksFile";
import { isAfter, listTime, matchesBookmark, sortBookmarks } from "./library";
import { suggestFrom } from "./triage";
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
export const DEMO_STORAGE_KEY = "netamipin.demo.v4";
const key = DEMO_STORAGE_KEY;
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
    // Waiting ones came from a browser; triage says which (NP-025).
    source: b.inbox ? (i % 2 ? "firefox" : "chrome") : "import",
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
// Saved before NP-025, without source.
let bookmarks: Bookmark[] = initial.bookmarks.map((b) => ({ ...b, source: b.source ?? null }));
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
/** The command journal of `journal.rs`: this session only, the last 100, undone field by field. */
const JOURNAL_LIMIT = 100;
const FIELDS = ["title", "notes", "is_favorite", "collection_id", "tags", "triaged_at", "deleted_at"] as const;
type Fields = Pick<Bookmark, (typeof FIELDS)[number]>;
type Command = { id: number; action: CommandAction; changes: { id: number; before: Fields; after: Fields }[] };
let journal: Command[] = [];
let lastCommand = 0;
const fieldsOf = (b: Bookmark): Fields => Object.fromEntries(FIELDS.map((f) => [f, b[f]])) as Fields;
/** The order of tags means nothing. */
const same = (field: keyof Fields, a: Fields, b: Fields) =>
  field === "tags" ? [...(a.tags ?? [])].sort().join("\n") === [...(b.tags ?? [])].sort().join("\n") : a[field] === b[field];
const touched = (step: Command["changes"][number]) => FIELDS.filter((f) => !same(f, step.before, step.after));
/** Bookmarks the kept commands may hold together (`CHANGE_LIMIT`); the newest command stays. */
const JOURNAL_CHANGES = 50_000;
function remember(action: CommandAction, changes: Command["changes"]): number | null {
  const steps = changes.filter((step) => touched(step).length > 0);
  if (steps.length === 0) return null;
  journal = [...journal, { id: ++lastCommand, action, changes: steps }].slice(-JOURNAL_LIMIT);
  let held = journal.reduce((sum, c) => sum + c.changes.length, 0);
  while (held > JOURNAL_CHANGES && journal.length > 1) held -= journal.shift()!.changes.length;
  return lastCommand;
}
function record(action: CommandAction, previous: Bookmark, b: Bookmark): Changed {
  return { bookmark: b, command: remember(action, [{ id: b.id, before: fieldsOf(previous), after: fieldsOf(b) }]) };
}
/** What `update_bookmark` calls the change, for the undo notice. */
function actionOf(data: Partial<Fields>): CommandAction {
  const keys = Object.keys(data).filter((k) => data[k as keyof Fields] !== undefined);
  if (keys.length === 0) return "keep";
  if (keys.length === 1 && keys[0] === "is_favorite") return "favorite";
  if (keys.length === 1 && keys[0] === "tags") return "tag";
  if (keys.length === 1 && keys[0] === "collection_id") return "move";
  return "edit";
}
const listeners = new Set<(change: BookmarkChange) => void>();
const batchListeners = new Set<(changes: BookmarkChange[]) => void>();
const invalidations = new Set<() => void>();
const progressListeners = new Set<(progress: ImportProgress) => void>();
function persist() {
  localStorage.setItem(key, JSON.stringify({ bookmarks, collections }));
}
const changeOf = (kind: BookmarkChange["kind"], b: Bookmark): BookmarkChange => ({
  kind,
  id: b.id,
  revision: b.revision ?? 1,
  bookmark: kind === "deleted" ? null : b,
});
function emit(kind: BookmarkChange["kind"], b: Bookmark) {
  for (const fn of listeners) fn(changeOf(kind, b));
}
/** `bookmarks-changed`: many at once in one event, one as `bookmark-changed` (`capture::emit_many`). */
function emitMany(kind: BookmarkChange["kind"], list: Bookmark[]) {
  if (list.length === 1) return emit(kind, list[0]);
  if (list.length === 0) return;
  const changes = list.map((b) => changeOf(kind, b));
  for (const fn of batchListeners) fn(changes);
}
/** What a bulk action writes to `b`, or nothing when it already holds it (`db::bulk_in`). */
function bulkFields(b: Bookmark, change: BulkChange, collectionId: number | null, now: string): Partial<Bookmark> | null {
  const sorted = { triaged_at: b.triaged_at ?? now };
  switch (change.action) {
    case "move":
    case "new_collection":
      return b.collection_id === collectionId && b.triaged_at ? null : { collection_id: collectionId, ...sorted };
    case "tag": {
      const name = change.name.trim().toLowerCase();
      const has = (b.tags ?? []).includes(name);
      return has && b.triaged_at ? null : { tags: has ? b.tags : [...(b.tags ?? []), name], ...sorted };
    }
    case "favorite":
      return b.is_favorite === change.favorite && b.triaged_at ? null : { is_favorite: change.favorite, ...sorted };
    case "trash":
      return { deleted_at: now };
    case "restore":
      return { deleted_at: null };
  }
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
  async getBookmarkIds(filters: Partial<FilterState> = {}): Promise<number[]> {
    return sortBookmarks(bookmarks.filter((b) => matchesBookmark(b, filters))).map((b) => b.id);
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
  async suggestCollection(id: number) {
    const b = bookmarks.find((item) => item.id === id);
    return b ? suggestFrom(bookmarks, b) : null;
  },
  async getCounts() {
    const inbox = live().filter((b) => b.triaged_at === null);
    return {
      total: live().length,
      favorites: live().filter((b) => b.is_favorite).length,
      inbox: inbox.length,
      inbox_newest: inbox.reduce<string | null>((newest, b) => (newest === null || b.created_at > newest ? b.created_at : newest), null),
      inbox_imported: inbox.filter((b) => b.source === "import").length,
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
    if (previous?.deleted_at) {
      // Saved again from the trash: back with its fields, waiting in the inbox.
      const back = change(previous, { deleted_at: null, triaged_at: null });
      emit("created", back);
      return { bookmark: back, restored: true };
    }
    if (previous) return { bookmark: previous, restored: false };
    const b: Bookmark = {
      // Unique even for links added within the same millisecond.
      id: Math.max(Date.now(), ...bookmarks.map((item) => item.id + 1)),
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
      triaged_at: null,
      deleted_at: null,
      source: "app",
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
    return record(actionOf(data), previous, b);
  },
  async trashBookmark(id: number): Promise<Changed> {
    const previous = bookmarks.find((b) => b.id === id);
    if (!previous) throw new CommandError("not_found", "Закладка удалена");
    if (previous.deleted_at) return { bookmark: previous, command: null };
    const b = change(previous, { deleted_at: new Date().toISOString() });
    emit("updated", b);
    return record("trash", previous, b);
  },
  async restoreBookmark(id: number): Promise<Changed> {
    const previous = bookmarks.find((b) => b.id === id);
    if (!previous) throw new CommandError("not_found", "Закладка удалена");
    if (!previous.deleted_at) return { bookmark: previous, command: null };
    const b = change(previous, { deleted_at: null });
    emit("updated", b);
    return record("restore", previous, b);
  },
  async undo(command?: number | null): Promise<Undo> {
    const entry = command == null ? journal.at(-1) : journal.find((c) => c.id === command);
    if (!entry) return { outcome: "nothing" };
    journal = journal.filter((c) => c !== entry);
    const { action } = entry;
    for (const step of entry.changes) {
      const current = bookmarks.find((b) => b.id === step.id);
      if (!current) return { outcome: "gone", action, title: step.after.title };
      const now = fieldsOf(current);
      if (touched(step).some((f) => !same(f, now, step.after))) return { outcome: "conflict", action, title: current.title };
      const collection = step.before.collection_id;
      if (touched(step).includes("collection_id") && collection !== null && !collections.some((c) => c.id === collection))
        return { outcome: "no_collection", action, title: current.title };
    }
    const undone = entry.changes.map((step) => {
      const fields: Partial<Bookmark> = Object.fromEntries(touched(step).map((f) => [f, step.before[f]]));
      return change(bookmarks.find((item) => item.id === step.id)!, fields);
    });
    emitMany("updated", undone);
    return { outcome: "undone", action, bookmarks: undone };
  },
  /** `bulk_update`: one action on every selected bookmark, one journal command, all or nothing. */
  async bulkUpdate(ids: number[], bulk: BulkChange): Promise<BulkChanged> {
    if ((bulk.action === "tag" || bulk.action === "new_collection") && !bulk.name.trim())
      throw new CommandError("invalid_request", bulk.action === "tag" ? "Введите тег" : "Введите название коллекции");
    if (bulk.action === "move" && bulk.collection_id !== null && !collections.some((c) => c.id === bulk.collection_id))
      throw new CommandError("not_found", "FOREIGN KEY constraint failed");
    const created = bulk.action === "new_collection" ? await demo.createCollection(bulk.name) : null;
    const target = created ? created.id : bulk.action === "move" ? bulk.collection_id : null;
    const restore = bulk.action === "restore";
    const chosen = new Set(ids);
    const now = new Date().toISOString();
    let count = 0;
    const steps: Command["changes"] = [];
    const changed: Bookmark[] = [];
    bookmarks = bookmarks.map((b) => {
      if (!chosen.has(b.id) || !!b.deleted_at !== restore) return b;
      count++;
      const fields = bulkFields(b, bulk, target, now);
      if (!fields) return b;
      const next = { ...b, ...fields, revision: (b.revision ?? 1) + 1, updated_at: now };
      steps.push({ id: b.id, before: fieldsOf(b), after: fieldsOf(next) });
      changed.push(next);
      return next;
    });
    persist();
    const action: CommandAction = bulk.action === "new_collection" ? "move" : bulk.action;
    const command = remember(action, steps);
    emitMany("updated", changed);
    return { count, changed: changed.length, command, collection: created && { ...created, count } };
  },
  /** `delete_forever_many`: only those in the trash, no undo. */
  async deleteForeverMany(ids: number[]): Promise<number> {
    const chosen = new Set(ids);
    const gone = bookmarks.filter((b) => chosen.has(b.id) && b.deleted_at);
    bookmarks = bookmarks.filter((b) => !gone.includes(b));
    persist();
    emitMany("deleted", gone.map((b) => ({ ...b, revision: (b.revision ?? 1) + 1 })));
    return gone.length;
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
  /** `import.rs` in the browser: the same folder rule, all or nothing, progress by hundreds. */
  async importHtmlBookmarks(content: string, toInbox = false): Promise<ImportSummary> {
    const parsed = parseBookmarksFile(content);
    const summary: ImportSummary = {
      added: 0,
      existing: 0,
      in_trash: 0,
      not_web: parsed.skipped.filter((s) => s.reason === "not_web").length,
      invalid: parsed.skipped.filter((s) => s.reason === "invalid").length,
      repeated: parsed.skipped.filter((s) => s.reason === "repeated").length,
      skipped: parsed.skipped.slice(0, 200),
      collections: [],
      tags: 0,
    };
    const known = new Map(bookmarks.map((b) => [b.url, b]));
    const tagsBefore = new Set(bookmarks.flatMap((b) => b.tags ?? []));
    const named = new Map(collections.map((c) => [c.name.toLocaleLowerCase(), c.id]));
    const created: Collection[] = [];
    const added: Bookmark[] = [];
    const now = new Date().toISOString();
    let id = Math.max(Date.now(), ...bookmarks.map((b) => b.id + 1));
    for (const [index, link] of parsed.links.entries()) {
      const previous = known.get(link.url);
      if (previous?.deleted_at) summary.in_trash++;
      else if (previous) summary.existing++;
      else {
        let collectionId: number | null = null;
        if (link.collection) {
          const key = link.collection.toLocaleLowerCase();
          collectionId = named.get(key) ?? null;
          if (collectionId === null) {
            const c: Collection = { id: id++, name: link.collection, color: null, icon: null, count: 0, created_at: now };
            created.push(c);
            named.set(key, c.id);
            collectionId = c.id;
          }
        }
        const url = new URL(link.url);
        added.push({
          id: id++,
          url: link.url,
          title: link.title || link.url,
          description: null,
          image_url: null,
          favicon_url: null,
          notes: null,
          domain: url.hostname.replace(/^www\./, ""),
          collection_id: collectionId,
          tags: link.tags,
          is_favorite: false,
          created_at: link.addedAt ?? now,
          updated_at: now,
          revision: 1,
          triaged_at: toInbox ? null : now,
          deleted_at: null,
          source: "import",
        });
        summary.added++;
      }
      if ((index + 1) % 100 === 0 || index + 1 === parsed.links.length) {
        progressListeners.forEach((fn) => fn({ done: index + 1, total: parsed.links.length }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    // Written at the end, like the transaction of the desktop app.
    bookmarks = [...added, ...bookmarks];
    collections = [...collections, ...created];
    summary.collections = created.map((c) => c.name);
    summary.tags = new Set(added.flatMap((b) => b.tags ?? []).filter((t) => !tagsBefore.has(t))).size;
    persist();
    invalidations.forEach((fn) => fn());
    return summary;
  },
  /**
   * The preview has no Save dialog and no files: it answers as if the file
   * were saved under the default name, with the count the desktop app would
   * write (the trash only in JSON). Tests replace it for the other outcomes.
   */
  async exportLibrary(format: ExportFormat, columns?: CsvColumns, ids?: number[]): Promise<ExportOutcome> {
    if (format === "csv" && !columns) throw new CommandError("invalid_request", "CSV needs column titles");
    const day = new Date();
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    if (ids) {
      const chosen = new Set(ids);
      const count = bookmarks.filter((b) => chosen.has(b.id)).length;
      return { outcome: "saved", file_name: `netami-pin-selected-${date}.${format}`, count };
    }
    return { outcome: "saved", file_name: `netami-pin-${date}.${format}`, count: format === "json" ? bookmarks.length : live().length };
  },
  async revealExport() {
    /* No folders in the browser preview. */
  },
  onImportProgress(fn: (progress: ImportProgress) => void) {
    progressListeners.add(fn);
    return () => {
      progressListeners.delete(fn);
    };
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
  onBookmarksChanged(fn: (changes: BookmarkChange[]) => void) {
    batchListeners.add(fn);
    return () => {
      batchListeners.delete(fn);
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
