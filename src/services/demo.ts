import {
  AddedLink,
  BackupCopy,
  BackupRestoreOutcome,
  BackupSource,
  Bookmark,
  BookmarkChange,
  BookmarkPage,
  BulkChange,
  BulkChanged,
  Changed,
  Collection,
  CommandAction,
  DataSummary,
  Desktop,
  FilterState,
  CsvColumns,
  ExportFormat,
  ExportOutcome,
  ImportProgress,
  RestoreCheck,
  RestoreMode,
  RestoreOutcome,
  RestoreProblem,
  RestoreSummary,
  ImportSummary,
  LibraryPlace,
  LibraryStatus,
  CaptureStatus,
  Feedback,
  PickedCopy,
  SaveCopyOutcome,
  DuplicateGroup,
  MergeGroup,
  Merged,
  CheckedLink,
  LinkCheckProgress,
  LinkCheckReport,
  LinkCheckState,
  LinkFailure,
  Replaced,
  Undo,
} from "../types";
import type { PageRequest } from "./api";
import { demoLibrary, posterOf } from "./demoData";
import { parseBookmarksFile } from "./bookmarksFile";
import { isAfter, listTime, matchesBookmark, sortBookmarks } from "./library";
import { suggestFrom } from "./triage";
import { groupsOf, mergedFields } from "./duplicates";
import { CommandError } from "./errors";
import { emailShape, length, MAX_MESSAGE } from "./feedback";
import i18n, { resolveLanguage, storedLanguage } from "../i18n";

const demoCaptureStatus: CaptureStatus = {
  state: "none",
  browsers: [],
  last_capture: null,
  days_silent: null,
  problem: null,
  detail: null,
  protocol: 2,
  system: "windows",
};

// v2: generated previews instead of the drawn ones of the concepts; v3: the inbox; v4: the trash.
export const DEMO_STORAGE_KEY = "koonapin.demo.v4";
/** The desktop the preview pretends to run on (NP-053): a JSON `Desktop`. */
export const DEMO_DESKTOP_KEY = "koonapin.demo.desktop";
function storedDesktop(): Desktop | null {
  try {
    return JSON.parse(localStorage.getItem(DEMO_DESKTOP_KEY) || "null") as Desktop | null;
  } catch {
    return null;
  }
}
/** Capture speaks of the system the preview pretends to run on (NP-054). */
const demoCapture = (): CaptureStatus => ({ ...demoCaptureStatus, system: storedDesktop()?.linux ? "linux" : "windows" });
const key = DEMO_STORAGE_KEY;
const stamp = (i: number) => new Date(Date.UTC(2026, 9, 2 - i, 12)).toISOString();
// The texts follow the interface's language when the library is created; a saved
// library keeps its own after a switch. Until the first change nothing is saved,
// so a reload creates it again in the current language.
const sample = demoLibrary(resolveLanguage(storedLanguage()));
let initial = {
  bookmarks: sample.bookmarks.map((b, i): Bookmark => ({
    id: b.id,
    url: b.url,
    title: b.title,
    description: b.description ?? null,
    image_url: posterOf(b),
    favicon_url: null,
    domain: b.domain,
    notes: b.notes || null,
    is_favorite: b.favorite,
    collection_id: sample.collections.indexOf(b.collection) + 1,
    tags: b.tags,
    created_at: stamp(i),
    updated_at: stamp(i),
    revision: 1,
    triaged_at: b.inbox ? null : stamp(i),
    deleted_at: null,
    // Waiting ones came from a browser; triage says which (NP-025).
    source: b.inbox ? (i % 2 ? "firefox" : "chrome") : "import",
  })),
  collections: sample.collections.map((name, i): Collection => ({
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
/** The highest collection id handed out: like AUTOINCREMENT, a deleted one is not reused. */
let lastCollection = 0;
const nextCollection = () => {
  lastCollection = Math.max(lastCollection, ...collections.map((c) => c.id)) + 1;
  return lastCollection;
};
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
// `url` and `domain`: «Заменить адрес» (NP-036).
const FIELDS = ["url", "domain", "title", "notes", "is_favorite", "collection_id", "tags", "triaged_at", "deleted_at", "created_at"] as const;
type Fields = Pick<Bookmark, (typeof FIELDS)[number]>;
type Command = { id: number; action: CommandAction; changes: { id: number; before: Fields; after: Fields }[] };
let journal: Command[] = [];
let lastCommand = 0;
/** «Не дубликаты» (NP-035): bookmarks of a group set aside, this session only. */
const dismissed = new Map<string, Set<number>>();
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
const duplicateListeners = new Set<() => void>();
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
/** A JSON copy as the demo reads it: the format, the version, the lists and every address (`restore.rs` checks more). */
type CopyBookmark = {
  uid: string; url: string; title: string; description?: string | null; notes?: string | null; domain?: string;
  image_url?: string | null; favicon_url?: string | null; is_favorite?: boolean; collection?: string | null; tags?: string[];
  source?: Bookmark["source"]; created_at: string; updated_at: string; triaged_at?: string | null; deleted_at?: string | null;
};
type Copy = {
  exported_at: string;
  collections: { uid: string; name: string; color?: string | null; icon?: string | null; created_at: string }[];
  tags: { uid: string; name: string }[];
  bookmarks: CopyBookmark[];
};
function readCopy(content: string): Copy | RestoreProblem {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(content.replace(/^﻿/, ""));
  } catch {
    return { problem: "not_json" };
  }
  if (value?.format !== "koona-pin" || typeof value.version !== "number") return { problem: "not_ours" };
  if (value.version > 1) return { problem: "newer", version: value.version };
  const copy = value as unknown as Copy;
  if (!Array.isArray(copy.bookmarks) || !Array.isArray(copy.collections) || !Array.isArray(copy.tags))
    return { problem: "damaged", item: "file", index: 0, damage: "structure", detail: "bookmarks, collections or tags missing" };
  for (const [i, b] of copy.bookmarks.entries()) {
    let ok = false;
    try {
      ok = ["http:", "https:"].includes(new URL(b.url).protocol);
    } catch {
      /* Not an address. */
    }
    if (!ok) return { problem: "damaged", item: "bookmark", index: i + 1, damage: "bad_address", detail: String(b.url ?? "") };
  }
  return copy;
}
/**
 * Link check (NP-036) in the browser preview: no request leaves the page.
 * Each address gets a made-up answer from its own text, so the demo and its
 * tests always see the same groups. Results live for this session only.
 */
type LinkResult = {
  url: string;
  outcome: "ok" | "gone" | "moved" | "failed" | "local";
  status: number | null;
  reason: LinkFailure | null;
  target: string | null;
  checked_at: string;
};
const linkResults = new Map<number, LinkResult>();
const linkListeners = new Set<(progress: LinkCheckProgress) => void>();
let linkRun: { timer: number; queue: number[]; done: number; total: number; whole: boolean } | null = null;
let linkLast: LinkCheckProgress | null = null;
/** When the check of the whole library under way, or stopped, began; when the last one ended. */
let linkStarted: string | null = null;
let linkFinished: string | null = null;
/** The bookmarks of the last «Проверить снова» on a group: «Продолжить» after a stop checks them. */
let linkScope: number[] | null = null;
const LINK_STEP_MS = 40;

/** The answer the demo pretends a site gave. */
export function demoAnswer(url: string): Omit<LinkResult, "url" | "checked_at"> {
  const none = { status: null, reason: null, target: null };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { outcome: "local", ...none };
  }
  const host = parsed.hostname;
  if (host === "localhost" || host.endsWith(".local") || /^(127|10)\.|^192\.168\./.test(host)) return { outcome: "local", ...none };
  const hash = [...url].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) >>> 0, 7) % 12;
  switch (hash) {
    case 0:
      return { outcome: "gone", status: 404, reason: null, target: null };
    case 1:
      return { outcome: "gone", status: 410, reason: null, target: null };
    case 2: {
      const target = new URL(parsed);
      target.pathname = `/moved${parsed.pathname}`;
      return { outcome: "moved", status: 301, reason: null, target: target.toString() };
    }
    case 3:
      return { outcome: "failed", status: null, reason: "timeout", target: null };
    case 4:
      return { outcome: "failed", status: 503, reason: "status", target: null };
    default:
      return { outcome: "ok", status: 200, reason: null, target: null };
  }
}
/** The result still describes the bookmark: same address, or the one the page moved to after «Заменить адрес». */
const holds = (r: LinkResult, b: Bookmark) => r.url === b.url || (r.outcome === "moved" && r.target === b.url);
function linkReport(): LinkCheckReport {
  const library = live();
  const group = (outcome: LinkResult["outcome"]): CheckedLink[] =>
    library
      .flatMap((b) => {
        const r = linkResults.get(b.id);
        return r && r.url === b.url && r.outcome === outcome
          ? [{ bookmark: b, status: r.status, reason: r.reason, target: r.target, checked_at: r.checked_at, conflict: !!r.target && bookmarks.some((x) => x.url === r.target) }]
          : [];
      })
      .sort((a, b) => b.checked_at.localeCompare(a.checked_at) || a.bookmark.id - b.bookmark.id);
  const valid = library.filter((b) => {
    const r = linkResults.get(b.id);
    return r && holds(r, b);
  });
  const now = (b: Bookmark) => {
    const r = linkResults.get(b.id)!;
    return r.url === b.url ? r.outcome : "ok";
  };
  const left = linkStarted ? leftToCheck(linkStarted).length : 0;
  return {
    state: linkRun ? "running" : (linkLast?.state ?? (linkStarted ? "stopped" : "idle")),
    done: linkLast && linkLast.state !== "idle" ? linkLast.done : linkStarted ? library.length - left : 0,
    total: linkLast && linkLast.state !== "idle" ? linkLast.total : linkStarted ? library.length : 0,
    eta_seconds: linkRun ? (linkLast?.eta_seconds ?? null) : null,
    finished_at: linkFinished,
    library: library.length,
    open: valid.filter((b) => now(b) === "ok").length,
    local: valid.filter((b) => now(b) === "local").length,
    unchecked: library.length - valid.length,
    gone: group("gone"),
    moved: group("moved"),
    failed: group("failed"),
  };
}
/** «Проверка ссылок N»: links that do not open or moved. */
function linksToDecide(): number {
  const report = linkReport();
  return report.gone.length + report.moved.length;
}
/** What the run started at `since` has left, those never checked first. */
function leftToCheck(since: string): number[] {
  return live()
    .filter((b) => {
      const r = linkResults.get(b.id);
      return !(r && holds(r, b) && r.checked_at >= since);
    })
    .sort((a, b) => (linkResults.get(a.id)?.checked_at ?? "").localeCompare(linkResults.get(b.id)?.checked_at ?? "") || a.id - b.id)
    .map((b) => b.id);
}
function linkProgress(state: LinkCheckState, written: boolean) {
  const run = linkRun;
  const progress: LinkCheckProgress = {
    state,
    done: run?.done ?? linkLast?.done ?? 0,
    total: run?.total ?? linkLast?.total ?? 0,
    eta_seconds: run && state === "running" ? Math.ceil(((run.total - run.done) * LINK_STEP_MS) / 1000) : null,
    written,
    error: null,
  };
  linkLast = progress;
  for (const fn of linkListeners) fn(progress);
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
      duplicates: groupsOf(bookmarks, dismissed).length,
      links: linksToDecide(),
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
      throw new CommandError("invalid_request", "Not a valid link", "invalid_url");
    }
    if (!["http:", "https:"].includes(url.protocol))
      throw new CommandError("invalid_request", "Only HTTP and HTTPS links are supported", "unsupported_url");
    const previous = bookmarks.find((b) => b.url === data.url.trim());
    if (previous?.deleted_at) {
      // Saved again from the trash: back with its fields, waiting in the inbox.
      const back = change(previous, { deleted_at: null, triaged_at: null });
      emit("created", back);
      return { bookmark: back, restored: true, existing: false };
    }
    if (previous) return { bookmark: previous, restored: false, existing: true };
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
    // The app reads the page and updates the bookmark, found or not; the demo
    // reads none, but answers the same way, so the preview stops waiting (NP-087).
    window.setTimeout(() => {
      const now = bookmarks.find((item) => item.id === b.id);
      if (now && now.revision === 1) emit("updated", change(now, {}));
    }, 600);
    return { bookmark: b, restored: false, existing: false };
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
    if (!previous) throw new CommandError("not_found", "Query returned no rows");
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
    if (!previous) throw new CommandError("not_found", "Query returned no rows");
    if (previous.deleted_at) return { bookmark: previous, command: null };
    const b = change(previous, { deleted_at: new Date().toISOString() });
    emit("updated", b);
    return record("trash", previous, b);
  },
  async restoreBookmark(id: number): Promise<Changed> {
    const previous = bookmarks.find((b) => b.id === id);
    if (!previous) throw new CommandError("not_found", "Query returned no rows");
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
    const byId = new Map(bookmarks.map((b) => [b.id, b]));
    for (const step of entry.changes) {
      const current = byId.get(step.id);
      if (!current) return { outcome: "gone", action, title: step.after.title };
      const now = fieldsOf(current);
      if (touched(step).some((f) => !same(f, now, step.after))) return { outcome: "conflict", action, title: current.title };
      // The old address was saved again meanwhile.
      if (touched(step).includes("url") && bookmarks.some((b) => b.id !== step.id && b.url === step.before.url))
        return { outcome: "conflict", action, title: current.title };
      const collection = step.before.collection_id;
      if (touched(step).includes("collection_id") && collection !== null && !collections.some((c) => c.id === collection))
        return { outcome: "no_collection", action, title: current.title };
    }
    // One pass and one write, as bulkUpdate: undoing 1 000 bookmarks one by one
    // rewrote the whole library 1 000 times.
    const now = new Date().toISOString();
    const next = new Map<number, Bookmark>();
    for (const step of entry.changes) {
      const previous = byId.get(step.id)!;
      const fields: Partial<Bookmark> = Object.fromEntries(touched(step).map((f) => [f, step.before[f]]));
      next.set(step.id, { ...previous, ...fields, revision: (previous.revision ?? 1) + 1, updated_at: now });
    }
    bookmarks = bookmarks.map((b) => next.get(b.id) ?? b);
    persist();
    const undone = entry.changes.map((step) => next.get(step.id)!);
    emitMany("updated", undone);
    return { outcome: "undone", action, bookmarks: undone };
  },
  /** `bulk_update`: one action on every selected bookmark, one journal command, all or nothing. */
  async bulkUpdate(ids: number[], bulk: BulkChange): Promise<BulkChanged> {
    if ((bulk.action === "tag" || bulk.action === "new_collection") && !bulk.name.trim())
      throw bulk.action === "tag"
        ? new CommandError("invalid_request", "Enter a tag", "empty_tag")
        : new CommandError("invalid_request", "Enter a collection name", "empty_collection_name");
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
  async allFavorite(ids: number[]): Promise<boolean> {
    const chosen = new Set(ids);
    const shown = bookmarks.filter((b) => chosen.has(b.id) && !b.deleted_at);
    return shown.length > 0 && shown.every((b) => b.is_favorite);
  },
  async nextCollectionId(): Promise<number> {
    return Math.max(lastCollection, ...collections.map((c) => c.id)) + 1;
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
    if (!b) throw new CommandError("not_found", "This bookmark is not in the trash", "not_in_trash");
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
      throw new CommandError("conflict", "UNIQUE constraint failed: collections.name");
    const c: Collection = {
      id: nextCollection(),
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
      return { outcome: "saved", file_name: `koona-pin-selected-${date}.${format}`, count };
    }
    return { outcome: "saved", file_name: `koona-pin-${date}.${format}`, count: format === "json" ? bookmarks.length : live().length };
  },
  async revealExport() {
    /* No folders in the browser preview. */
  },
  /** `restore.rs` in the browser: the same checks of the format, the version and every address. */
  async checkRestore(content: string): Promise<RestoreCheck> {
    const read = readCopy(content);
    if ("problem" in read) return { outcome: "rejected", problem: read };
    return {
      outcome: "ready",
      preview: {
        bookmarks: read.bookmarks.length,
        collections: read.collections.length,
        tags: read.tags.length,
        exported_at: read.exported_at,
        current: bookmarks.length,
      },
    };
  },
  /** Merge keeps every bookmark with the same address; replace takes the copy as it is. No backups in the preview. */
  async restoreLibrary(content: string, mode: RestoreMode): Promise<RestoreOutcome> {
    const copy = readCopy(content);
    if ("problem" in copy) return { outcome: "rejected", problem: copy };
    if (mode === "replace") {
      bookmarks = [];
      collections = [];
    }
    const summary: RestoreSummary = { added: 0, in_inbox: 0, in_trash: 0, existing: 0, collections: [], tags: 0, backup: mode === "replace" ? "koona-pin.before-restore.db" : null };
    const tagsBefore = new Set(bookmarks.flatMap((b) => b.tags ?? []));
    let id = Math.max(Date.now(), ...bookmarks.map((b) => b.id + 1), ...collections.map((c) => c.id + 1));
    const collectionOf = new Map<string, number>();
    for (const c of copy.collections) {
      const same = collections.find((existing) => existing.name.toLocaleLowerCase() === c.name.toLocaleLowerCase());
      if (same) collectionOf.set(c.uid, same.id);
      else {
        collections = [...collections, { id: id, name: c.name, color: c.color ?? null, icon: c.icon ?? null, count: 0, created_at: c.created_at }];
        summary.collections.push(c.name);
        collectionOf.set(c.uid, id++);
      }
    }
    const known = new Set(bookmarks.map((b) => b.url));
    for (const b of copy.bookmarks) {
      if (known.has(b.url)) {
        summary.existing++;
        continue;
      }
      bookmarks = [
        ...bookmarks,
        {
          id: id++,
          url: b.url,
          title: b.title,
          description: b.description ?? null,
          image_url: b.image_url ?? null,
          favicon_url: b.favicon_url ?? null,
          notes: b.notes ?? null,
          domain: b.domain || new URL(b.url).hostname,
          collection_id: b.collection ? (collectionOf.get(b.collection) ?? null) : null,
          tags: b.tags ?? [],
          is_favorite: !!b.is_favorite,
          created_at: b.created_at,
          updated_at: b.updated_at,
          revision: 1,
          triaged_at: b.triaged_at ?? null,
          deleted_at: b.deleted_at ?? null,
          source: b.source ?? null,
        },
      ];
      summary.added++;
      if (b.deleted_at) summary.in_trash++;
      else if (!b.triaged_at) summary.in_inbox++;
    }
    summary.tags = new Set(bookmarks.flatMap((b) => b.tags ?? []).filter((t) => !tagsBefore.has(t))).size;
    persist();
    invalidations.forEach((fn) => fn());
    return { outcome: "restored", summary };
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
    return demoCapture();
  },
  onCaptureStatus(_fn: (status: CaptureStatus) => void) {
    return () => {};
  },
  async repairCapture(): Promise<CaptureStatus> {
    return demoCapture();
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
  /** Windows buttons; a test or a look at the Linux bar puts a `Desktop` into localStorage. */
  async getDesktop(): Promise<Desktop> {
    return storedDesktop() ?? { linux: false, left: [], right: ["minimize", "maximize", "close"], tray: true };
  },
  async hideToBackground() {
    /* Desktop-only. */
  },
  onCloseToBackground(_fn: () => void) {
    return () => {};
  },
  async getAutostart() {
    return false;
  },
  async setAutostart(_enabled: boolean) {
    /* Desktop-only. */
  },
  async getDataSummary(): Promise<DataSummary> {
    return {
      library_folder: "%APPDATA%\\Koona Pin",
      backups_folder: "%APPDATA%\\Koona Pin\\backups",
      copies: 0,
      bytes: 0,
      last_copy: null,
    };
  },
  async backUpNow(): Promise<DataSummary> {
    throw new CommandError("internal", i18n.t("settings.desktopOnly"));
  },
  async getDuplicates(): Promise<DuplicateGroup[]> {
    return groupsOf(bookmarks, dismissed);
  },
  /** `dedupe::merge`: all groups or none, one journal command. */
  async mergeDuplicates(groups: MergeGroup[]): Promise<Merged> {
    const live = (id: number) => bookmarks.find((b) => b.id === id && !b.deleted_at);
    const keyed = new Map(groupsOf(bookmarks, new Map()).flatMap((g) => g.bookmarks.map((b) => [b.id, g.key] as const)));
    const seen = new Set<number>();
    for (const g of groups)
      for (const id of [g.main, ...g.others])
        if (!live(id) || seen.has(id) || keyed.get(id) !== keyed.get(g.main) || !keyed.has(id))
          throw new CommandError("not_found", "Query returned no rows");
        else seen.add(id);
    const now = new Date().toISOString();
    const steps: Command["changes"] = [];
    const changed: Bookmark[] = [];
    let trashed = 0;
    for (const g of groups) {
      if (g.others.length === 0) continue;
      const main = live(g.main)!;
      const others = g.others.map((id) => live(id)!);
      const updates: [Bookmark, Partial<Bookmark>][] = [[main, mergedFields(main, others)], ...others.map((o): [Bookmark, Partial<Bookmark>] => [o, { deleted_at: now }])];
      for (const [before, fields] of updates) {
        const after = change(before, fields);
        steps.push({ id: after.id, before: fieldsOf(before), after: fieldsOf(after) });
        changed.push(after);
      }
      trashed += others.length;
    }
    const command = remember("merge", steps);
    emitMany("updated", changed);
    const merged = groups.filter((g) => g.others.length > 0);
    return { groups: merged.length, trashed, title: merged.length === 1 ? (live(merged[0].main)?.title ?? null) : null, command };
  },
  async dismissDuplicates(key: string, ids: number[]): Promise<number> {
    const set = dismissed.get(key) ?? new Set<number>();
    ids.forEach((id) => set.add(id));
    dismissed.set(key, set);
    for (const fn of duplicateListeners) fn();
    return ids.length;
  },
  async undismissDuplicates(key: string, ids: number[]): Promise<number> {
    ids.forEach((id) => dismissed.get(key)?.delete(id));
    for (const fn of duplicateListeners) fn();
    return ids.length;
  },
  onDuplicatesChanged(fn: () => void) {
    duplicateListeners.add(fn);
    return () => {
      duplicateListeners.delete(fn);
    };
  },
  async saveBackupCopy(): Promise<SaveCopyOutcome> {
    throw new CommandError("internal", i18n.t("settings.desktopOnly"));
  },
  /** Two made-up copies, so the restore dialog of sheet 33 can be tried in the browser. */
  async listBackups(): Promise<BackupCopy[]> {
    const at = (daysAgo: number) => {
      const time = new Date();
      time.setDate(time.getDate() - daysAgo);
      time.setHours(9, 12, 0, 0);
      return time.toISOString();
    };
    const count = sample.bookmarks.length;
    return [
      { file_name: "koonapin.auto-demo-1.db", kind: "automatic", created_at: at(0), bytes: 1_300_000, bookmarks: count },
      { file_name: "koonapin.before-v4.db", kind: "before_update", created_at: at(2), bytes: 1_250_000, bookmarks: count - 2 },
    ];
  },
  async pickBackup(): Promise<PickedCopy> {
    return { outcome: "cancelled" };
  },
  /** The demo library stays as it is: there is no file to replace. */
  async restoreBackup(source: BackupSource): Promise<BackupRestoreOutcome> {
    const copy = (await this.listBackups()).find((c) => source.from === "listed" && c.file_name === source.file_name);
    if (!copy) throw new CommandError("not_found", "The copy is gone", "copy_gone");
    return { outcome: "restored", bookmarks: copy.bookmarks ?? 0, previous: "koonapin.before-restore-demo.db" };
  },
  async revealBackup(_fileName: string) {
    /* No folders in the browser preview. */
  },
  async getLinkCheck(): Promise<LinkCheckReport> {
    return linkReport();
  },
  async startLinkCheck(ids: number[] | null, resume: boolean): Promise<void> {
    if (linkRun) return;
    if (ids !== null) linkScope = ids;
    else if (!resume) linkScope = null;
    else if (linkScope) ids = linkScope;
    const whole = ids === null;
    let queue: number[];
    let before = 0;
    if (ids === null) {
      linkStarted = resume && linkStarted ? linkStarted : new Date().toISOString();
      queue = leftToCheck(linkStarted);
      before = live().length - queue.length;
    } else {
      queue = ids.filter((id) => live().some((b) => b.id === id));
    }
    const run = { timer: 0, queue, done: before, total: before + queue.length, whole };
    linkRun = run;
    linkProgress("running", false);
    const finish = () => {
      window.clearInterval(run.timer);
      if (whole) {
        linkFinished = new Date().toISOString();
        linkStarted = null;
      }
      linkScope = null;
      linkProgress("idle", true);
      linkRun = null;
    };
    run.timer = window.setInterval(() => {
      const id = run.queue.shift();
      if (id === undefined) return finish();
      const b = live().find((item) => item.id === id);
      if (b) linkResults.set(id, { url: b.url, checked_at: new Date().toISOString(), ...demoAnswer(b.url) });
      run.done++;
      if (run.queue.length === 0) return finish();
      linkProgress("running", run.done % 5 === 0);
    }, LINK_STEP_MS);
  },
  async stopLinkCheck(): Promise<void> {
    if (!linkRun) return;
    window.clearInterval(linkRun.timer);
    linkProgress("stopped", true);
    linkRun = null;
  },
  /** `linkcheck::replace`: the moved ones take their new address, one journal command. */
  async replaceAddresses(ids: number[]): Promise<Replaced> {
    const steps: Command["changes"] = [];
    const changed: Bookmark[] = [];
    let skipped = 0;
    for (const id of ids) {
      const b = live().find((item) => item.id === id);
      const r = b && linkResults.get(id);
      const target = r && r.url === b.url && r.outcome === "moved" ? r.target : null;
      if (!b || !target || bookmarks.some((x) => x.url === target)) {
        skipped++;
        continue;
      }
      const after = change(b, { url: target, domain: new URL(target).hostname.replace(/^www\./, "") });
      steps.push({ id, before: fieldsOf(b), after: fieldsOf(after) });
      changed.push(after);
    }
    const command = remember("replace", steps);
    emitMany("updated", changed);
    return { replaced: changed.length, skipped, address: changed.length === 1 ? changed[0].url : null, command };
  },
  onLinkCheck(fn: (progress: LinkCheckProgress) => void) {
    linkListeners.add(fn);
    return () => {
      linkListeners.delete(fn);
    };
  },
  /** The demo reads no pages: the bookmark stays as it is. */
  async refreshPreview(id: number) {
    const b = bookmarks.find((item) => item.id === id && !item.deleted_at);
    if (!b) throw new CommandError("not_found", "Query returned no rows");
    return { ...b };
  },
  /** The demo library is made in its language already. */
  async createStarterCollections(_names: string[]): Promise<Collection[]> {
    return [];
  },
  async setTrayLabels(_labels: { open: string; quit: string; tooltip: string }) {},
  async feedbackReport(language: string) {
    return ["Koona Pin demo", "Browser preview", `Language: ${language}`, `Capture: ${demoCaptureStatus.state}`, `Protocol: ${demoCaptureStatus.protocol}`].join("\n");
  },
  /** The preview sends nothing: the same checks as the app, then a pause. */
  async sendFeedback(feedback: Feedback) {
    if (!feedback.message.trim()) throw new CommandError("invalid_request", "The message is empty", "empty_message");
    if (length(feedback.message) > MAX_MESSAGE)
      throw new CommandError("invalid_request", "The message is longer than 5000 characters", "message_too_long");
    if (feedback.email && !emailShape(feedback.email.trim()))
      throw new CommandError("invalid_request", "The email address does not look right", "invalid_email");
    await new Promise((resolve) => setTimeout(resolve, 300));
  },
  async getVersion() {
    return "demo";
  },
};
