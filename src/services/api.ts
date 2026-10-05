import { invoke, InvokeArgs } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import {
  AddedLink,
  AppSettings,
  BackupCopy,
  BackupRestoreOutcome,
  BackupSource,
  BookmarkChange,
  BookmarkPage,
  BookmarkPatch,
  BookmarkQuery,
  BulkChange,
  BulkChanged,
  CaptureStatus,
  Changed,
  Collection,
  DataSummary,
  DomainCount,
  FilterState,
  CsvColumns,
  ExportFormat,
  ExportOutcome,
  ImportProgress,
  ImportSummary,
  LibraryCounts,
  LibraryPlace,
  LibraryStatus,
  RestoreCheck,
  RestoreMode,
  RestoreOutcome,
  DuplicateGroup,
  MergeGroup,
  Merged,
  LinkCheckProgress,
  LinkCheckReport,
  Replaced,
  PickedCopy,
  SaveCopyOutcome,
  Suggestion,
  Tag,
  Undo,
} from "../types";
import { demo } from "./demo";
import { toCommandError } from "./errors";

export const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
function subscription<T>(event: string, callback: (payload: T) => void) {
  let disposed = false;
  const promise = listen<T>(event, (e) => {
    if (!disposed) callback(e.payload);
  });
  return () => {
    disposed = true;
    void promise.then((unlisten) => unlisten()).catch(console.error);
  };
}
/** Which page to read (the first by default), or one bookmark by `id`. */
export type PageRequest = Pick<BookmarkQuery, "after" | "limit" | "id" | "since">;
const toQuery = (
  filters: Partial<FilterState>,
  page: PageRequest,
): BookmarkQuery => ({
  search: filters.search?.trim() || undefined,
  collection_id: filters.collectionId ?? undefined,
  tag: filters.tag || undefined,
  domain: filters.domain || undefined,
  only_favorites: filters.onlyFavorites ?? false,
  only_inbox: filters.onlyInbox ?? false,
  only_trash: filters.onlyTrash ?? false,
  ...page,
});
/** Every command rejects with a `CommandError` carrying a machine code. */
const call = <T>(command: string, args?: InvokeArgs) =>
  invoke<T>(command, args).catch((error: unknown) => {
    throw toCommandError(error);
  });
const desktop = {
  getBookmarks: (filters: Partial<FilterState> = {}, page: PageRequest = {}) =>
    call<BookmarkPage>("get_bookmarks", { query: toQuery(filters, page) }),
  /** Every match in list order, ids only, loaded or not (NP-028). */
  getBookmarkIds: (filters: Partial<FilterState> = {}) =>
    call<number[]>("get_bookmark_ids", { query: toQuery(filters, {}) }),
  rebuildSearchIndex: () => call<number>("rebuild_search_index"),
  getCollections: () => call<Collection[]>("get_collections"),
  getTags: () => call<Tag[]>("get_tags"),
  getDomains: () => call<DomainCount[]>("get_domains"),
  /** Triage: where the site's other bookmarks mostly lie (NP-026); none when unclear. */
  suggestCollection: (id: number) => call<Suggestion | null>("suggest_collection", { id }),
  getCounts: () => call<LibraryCounts>("get_counts"),
  addBookmark: (data: {
    url: string;
    title?: string;
    collectionId?: number | null;
    tags?: string[];
  }) =>
    call<AddedLink>("add_bookmark", {
      url: data.url,
      title: data.title || null,
      collectionId: data.collectionId ?? null,
      tags: data.tags ?? [],
    }),
  updateBookmark: (
    id: number,
    data: {
      title?: string;
      notes?: string;
      is_favorite?: boolean;
      collection_id?: number | null;
      tags?: string[];
    },
  ) =>
    call<Changed>("update_bookmark", {
      id,
      patch: {
        title: data.title,
        notes: data.notes,
        is_favorite: data.is_favorite,
        tags: data.tags,
        collection:
          data.collection_id === undefined
            ? { action: "keep" }
            : data.collection_id === null
              ? { action: "clear" }
              : { action: "set", id: data.collection_id },
      } satisfies BookmarkPatch,
    }),
  trashBookmark: (id: number) => call<Changed>("trash_bookmark", { id }),
  restoreBookmark: (id: number) => call<Changed>("restore_bookmark", { id }),
  /** The last command, or `command` from an undo notice (NP-024). */
  undo: (command?: number | null) =>
    call<Undo>("undo", { command: command ?? null }),
  /** One action on every selected bookmark: one transaction, one command to undo (NP-029). */
  bulkUpdate: (ids: number[], change: BulkChange) => call<BulkChanged>("bulk_update", { ids, change }),
  /** Every selected bookmark has a star: the bar offers «Из избранного». */
  allFavorite: (ids: number[]) => call<boolean>("all_favorite", { ids }),
  /** The id, and so the colour, the next collection gets. */
  nextCollectionId: () => call<number>("next_collection_id"),
  /** Only bookmarks in the trash; there is no way back. */
  deleteForever: (id: number) => call<void>("delete_forever", { id }),
  /** The selection in the trash, for good: how many went. */
  deleteForeverMany: (ids: number[]) => call<number>("delete_forever_many", { ids }),
  emptyTrash: () => call<number>("empty_trash"),
  createCollection: (name: string, color?: string, icon?: string) =>
    call<Collection>("create_collection", {
      name,
      color: color ?? null,
      icon: icon ?? null,
    }),
  deleteCollection: async (id: number) => {
    await call("delete_collection", { id });
    return true;
  },
  /** Folders by the rule of Р-10, into the library or the inbox; the report of frame 28. */
  importHtmlBookmarks: (htmlContent: string, toInbox = false) =>
    call<ImportSummary>("import_html_bookmarks", { htmlContent, toInbox }),
  onImportProgress: (callback: (progress: ImportProgress) => void) =>
    subscription("import-progress", callback),
  /** The Save dialog and the file (NP-032); CSV needs its column titles; `ids` — only the selected (NP-029). */
  exportLibrary: (format: ExportFormat, columns?: CsvColumns, ids?: number[]) =>
    call<ExportOutcome>("export_library", { format, columns: columns ?? null, ids: ids ?? null }),
  /** The last exported file in Explorer. */
  revealExport: () => call<void>("reveal_export"),
  /** Reads and checks a JSON copy; changes nothing (NP-033). */
  checkRestore: (content: string) => call<RestoreCheck>("check_restore", { content }),
  /** Merges the copy or replaces the library with it, after a backup. */
  restoreLibrary: (content: string, mode: RestoreMode) =>
    call<RestoreOutcome>("restore_library", { content, mode }),
  openUrl: (url: string) => call<void>("open_url_external", { url }),
  onBookmarkChanged: (callback: (change: BookmarkChange) => void) =>
    subscription("bookmark-changed", callback),
  /** Many changes at once: a bulk action or an undo of one (NP-029). */
  onBookmarksChanged: (callback: (changes: BookmarkChange[]) => void) =>
    subscription("bookmarks-changed", callback),
  onLibraryInvalidated:(callback: () => void) =>
    subscription("library-invalidated", callback),
  getAppSettings: () => call<AppSettings>("get_app_settings"),
  setCloseToTray: (enabled: boolean) =>
    call<void>("set_close_to_tray", { enabled }),
  getCaptureStatus: () => call<CaptureStatus>("get_capture_status"),
  onCaptureStatus: (callback: (status: CaptureStatus) => void) =>
    subscription("capture-status", callback),
  repairCapture: () => call<CaptureStatus>("repair_capture"),
  getLibraryStatus: () => call<LibraryStatus>("get_library_status"),
  onLibraryStatus: (callback: (status: LibraryStatus) => void) =>
    subscription("library-status", callback),
  retryLibrary: () => call<void>("retry_library"),
  revealLibraryPlace: (place: LibraryPlace) =>
    call<void>("reveal_library_place", { place }),
  quitApp: () => call<void>("quit_app"),
  getAutostart: () => call<boolean>("get_autostart"),
  setAutostart: (enabled: boolean) => call<void>("set_autostart", { enabled }),
  getDataSummary: () => call<DataSummary>("get_data_summary"),
  backUpNow: () => call<DataSummary>("back_up_now"),
  /** «Save a copy…» (NP-034): the Save dialog, then a checked copy there. */
  saveBackupCopy: () => call<SaveCopyOutcome>("save_backup_copy"),
  listBackups: () => call<BackupCopy[]>("list_backups"),
  /** «Choose a file…»: the Open dialog, then the file checked in full. */
  pickBackup: () => call<PickedCopy>("pick_backup"),
  /** Replaces the library with a copy, after saving the current one. */
  restoreBackup: (source: BackupSource) => call<BackupRestoreOutcome>("restore_backup", { source }),
  /** A copy in the backups folder, selected in Explorer. */
  revealBackup: (fileName: string) => call<void>("reveal_backup", { fileName }),
  /** The section «Дубликаты» (NP-035): groups of the same page. */
  getDuplicates: () => call<DuplicateGroup[]>("get_duplicates"),
  /** One transaction and one journal command for all the groups. */
  mergeDuplicates: (groups: MergeGroup[]) => call<Merged>("merge_duplicates", { groups }),
  dismissDuplicates: (key: string, ids: number[]) => call<number>("dismiss_duplicates", { key, ids }),
  undismissDuplicates: (key: string, ids: number[]) => call<number>("undismiss_duplicates", { key, ids }),
  /** «Не дубликаты» or its undo: groups changed, no bookmark did. */
  onDuplicatesChanged: (callback: () => void) => subscription("duplicates-changed", callback),
  /** The section «Проверка ссылок» (NP-036): results and the run under way. */
  getLinkCheck: () => call<LinkCheckReport>("get_link_check"),
  /** In the background, reported by onLinkCheck; ids — only those, esume — go on with the one stopped. */
  startLinkCheck: (ids: number[] | null, resume: boolean) => call<void>("start_link_check", { ids, resume }),
  stopLinkCheck: () => call<void>("stop_link_check"),
  /** «Заменить адрес»: one journal command for all of them. */
  replaceAddresses: (ids: number[]) => call<Replaced>("replace_addresses", { ids }),
  onLinkCheck: (callback: (progress: LinkCheckProgress) => void) => subscription("link-check", callback),
  getVersion: () => getVersion(),
};
export const api = isTauri() ? desktop : demo;
