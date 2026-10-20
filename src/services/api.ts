import { invoke, InvokeArgs } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import {
  AddedLink,
  AppSettings,
  BackupCopy,
  BackupRestoreOutcome,
  BackupSource,
  Bookmark,
  BookmarkChange,
  BookmarkPage,
  BookmarkPatch,
  BookmarkQuery,
  BookmarkSort,
  BulkChange,
  BulkChanged,
  CaptureStatus,
  Changed,
  Collection,
  DataSummary,
  Desktop,
  DomainCount,
  Feed,
  FeedArticle,
  FeedDestination,
  FeedItemPage,
  FeedSave,
  FeedItemQuery,
  FeedPreview,
  FeedsChanged,
  FeedsRefresh,
  FilterState,
  LinkPreview,
  OpmlExport,
  OpmlImport,
  SavePlace,
  CsvColumns,
  ExportFormat,
  ExportOutcome,
  Feedback,
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
  PreviewCounts,
  PreviewRefresh,
  PreviewScope,
  McpAccess,
  McpSetup,
  McpStatus,
  OfflineArticle,
  OfflineCopy,
  OfflineCopyContent,
  OfflineStats,
  Replaced,
  PickedCopy,
  SaveCopyOutcome,
  StarterLibrary,
  StarterLink,
  Suggestion,
  SupporterPrices,
  SupporterStatus,
  PlanInterval,
  CheckoutState,
  PlayOffer,
  PlayState,
  BackupFolder,
  SyncAccount,
  SyncStatus,
  Tag,
  TrayLabels,
  Undo,
  UpdateStatus,
} from "../types";
import type { ReaderPage } from "../bindings/ReaderPage";
import type { ListCheck } from "../bindings/ListCheck";
import type { ListDownload } from "../bindings/ListDownload";
import type { ListDownloadProgress } from "../bindings/ListDownloadProgress";
import type { ListFile } from "../bindings/ListFile";
import type { ListImportOptions } from "../bindings/ListImportOptions";
import type { ListImportReport } from "../bindings/ListImportReport";
import { demo } from "./demo";
import { toCommandError } from "./errors";
import { desktopCommands } from "../platform/capabilities";

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
/** Which page to read (the first by default) in which order, or one bookmark by `id`. */
export type PageRequest = Pick<BookmarkQuery, "after" | "limit" | "id" | "since" | "sort">;
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
  only_reading: filters.onlyReading ?? false,
  only_offline: filters.onlyOffline ?? false,
  ...page,
});
/** Every command rejects with a `CommandError` carrying a machine code. */
const call = <T>(command: string, args?: InvokeArgs) =>
  invoke<T>(command, args).catch((error: unknown) => {
    throw toCommandError(error);
  });
const native = {
  getBookmarks: (filters: Partial<FilterState> = {}, page: PageRequest = {}) =>
    call<BookmarkPage>("get_bookmarks", { query: toQuery(filters, page) }),
  /** Every match in list order, ids only, loaded or not (NP-028). */
  getBookmarkIds: (filters: Partial<FilterState> = {}, sort?: BookmarkSort) =>
    call<number[]>("get_bookmark_ids", { query: toQuery(filters, { sort }) }),
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
  /** How far an article was read, 0 to 1 (NP-121, for the reader): at 1 it is read. No undo. */
  setReadingProgress: (id: number, progress: number) => call<Bookmark>("set_reading_progress", { id, progress }),
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
  /** «Обновить превью»: the page read again for its picture and icon (NP-087). */
  refreshPreview: (id: number) => call<Bookmark>("refresh_preview", { id }),
  /** A new library's first collections, named in the interface's language; once (NP-085). */
  createStarterCollections: (names: string[]) => call<Collection[]>("create_starter_collections", { names }),
  /** The same, with the starter links in the inbox; their previews load in the background (NP-117). */
  createStarterLibrary: (names: string[], links: StarterLink[]) =>
    call<StarterLibrary>("create_starter_library", { names, links }),
  /** The starter links still in the library: triage names them (NP-117). */
  getStarterLinks: () => call<number[]>("get_starter_links"),
  /** The sidebar's order after a move: every collection's id, first to last (NP-114). */
  reorderCollections: (ids: number[]) => call<void>("reorder_collections", { ids }),
  /** «Title A–Z» and «Site A–Z» compare in this language; true when the keys were written anew (NP-114). */
  setSortLanguage: (language: string) => call<boolean>("set_sort_language", { language }),
  deleteCollection: async (id: number) => {
    await call("delete_collection", { id });
    return true;
  },
  /** Folders by the rule of Р-10, into the library or the inbox; the report of frame 28. */
  importHtmlBookmarks: (htmlContent: string, toInbox = false) =>
    call<ImportSummary>("import_html_bookmarks", { htmlContent, toInbox }),
  onImportProgress: (callback: (progress: ImportProgress) => void) =>
    subscription("import-progress", callback),
  // `.kpin` lists (NP-138, src-tauri/src/lists): preview, import, the one-click download.
  /** What the list would do to the library; writes nothing. `source` is a file name or a host. */
  previewList: (text: string, source: string) => call<ListCheck>("preview_list", { text, source }),
  /** One transaction; progress comes through onImportProgress. */
  importList: (text: string, options: ListImportOptions) => call<ListImportReport>("import_list", { text, options }),
  /** A `.kpin` the system opened with the app, by the path Rust checked. */
  readListFile: (path: string) => call<ListFile>("read_list_file", { path }),
  /** Only after **Download**: https, the guard, 2 MB, 15 s. */
  downloadList: (url: string, ticket: number) => call<ListDownload>("download_list", { url, ticket }),
  /** A ticket for the next download: tickets only grow while the app runs, also across a reload of the page. */
  nextListTicket: () => call<number>("next_list_ticket"),
  /** `ticket` is the download's; a Cancel sent before it started still stops it. */
  cancelListDownload: (ticket: number) => call<void>("cancel_list_download", { ticket }),
  /** Whether a list dialog is open or a list waits for it: Rust then brings no window forward for another. */
  setListOpen: (open: boolean) => call<void>("set_list_open", { open }),
  onListDownloadProgress: (callback: (progress: ListDownloadProgress) => void) => subscription("list-download-progress", callback),
  /** The Save dialog and the file (NP-032); CSV needs its column titles; `ids` — only the selected (NP-029). */
  exportLibrary: (format: ExportFormat, columns?: CsvColumns, ids?: number[]) =>
    call<ExportOutcome>("export_library", { format, columns: columns ?? null, ids: ids ?? null }),
  /** Reads and checks a JSON copy; changes nothing (NP-033). */
  checkRestore: (content: string) => call<RestoreCheck>("check_restore", { content }),
  /** Merges the copy or replaces the library with it, after a backup. */
  restoreLibrary: (content: string, mode: RestoreMode) =>
    call<RestoreOutcome>("restore_library", { content, mode }),
  openUrl: (url: string) => call<void>("open_url_external", { url }),
  /** The page of an article, under the metadata request's guard (NP-120); `readArticle` extracts it. */
  fetchReaderPage: (url: string) => call<ReaderPage>("fetch_reader_page", { url }),
  // Offline copies of articles (NP-126): only on this computer, never synced or exported.
  /** The article reading mode extracted, with its pictures downloaded next to it; replaces an older copy. */
  saveOfflineCopy: (bookmarkId: number, article: OfflineArticle) => call<OfflineCopy>("save_offline_copy", { bookmarkId, article }),
  /** The copy with its pictures as `data:` addresses; none when there is no copy. */
  getOfflineCopy: (bookmarkId: number) => call<OfflineCopyContent | null>("get_offline_copy", { bookmarkId }),
  removeOfflineCopy: (bookmarkId: number) => call<void>("remove_offline_copy", { bookmarkId }),
  /** «Remove all copies»: how many went. */
  removeAllOfflineCopies: () => call<number>("remove_all_offline_copies"),
  offlineStats: () => call<OfflineStats>("offline_stats"),
  onBookmarkChanged: (callback: (change: BookmarkChange) => void) =>
    subscription("bookmark-changed", callback),
  /** Many changes at once: a bulk action or an undo of one (NP-029). */
  onBookmarksChanged: (callback: (changes: BookmarkChange[]) => void) =>
    subscription("bookmarks-changed", callback),
  onLibraryInvalidated:(callback: () => void) =>
    subscription("library-invalidated", callback),
  /** A phone brought the app back to the screen (NP-151); never on a desktop. */
  onResumed: (callback: () => void) => subscription("tauri://resumed", callback),
  getAppSettings: () => call<AppSettings>("get_app_settings"),
  setReadingMarkAtEnd: (enabled: boolean) => call<void>("set_reading_mark_at_end", { enabled }),
  /** «Save articles I open in Reading» (NP-126). */
  setReadingSaveOffline: (enabled: boolean) => call<void>("set_reading_save_offline", { enabled }),
  getLibraryStatus: () => call<LibraryStatus>("get_library_status"),
  onLibraryStatus: (callback: (status: LibraryStatus) => void) =>
    subscription("library-status", callback),
  retryLibrary: () => call<void>("retry_library"),
  getDataSummary: () => call<DataSummary>("get_data_summary"),
  backUpNow: () => call<DataSummary>("back_up_now"),
  /** «Save a copy…» (NP-034): the Save dialog, then a checked copy there. */
  saveBackupCopy: () => call<SaveCopyOutcome>("save_backup_copy"),
  listBackups: () => call<BackupCopy[]>("list_backups"),
  /** «Choose a file…»: the Open dialog, then the file checked in full. */
  pickBackup: () => call<PickedCopy>("pick_backup"),
  /** Replaces the library with a copy, after saving the current one. */
  restoreBackup: (source: BackupSource) => call<BackupRestoreOutcome>("restore_backup", { source }),
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
  /** «Refresh previews» for many bookmarks: the run of this session, picked up after a reload. */
  getPreviewRefresh: () => call<PreviewRefresh>("get_preview_refresh"),
  /** The counts of the choice in Settings → Data. */
  getPreviewCounts: () => call<PreviewCounts>("get_preview_counts"),
  /** A scope, or the selected ids; in the background, reported by onPreviewRefresh. While one runs, its state. */
  startPreviewRefresh: (target: { scope: PreviewScope } | { ids: number[] }) =>
    call<PreviewRefresh>("start_preview_refresh", "ids" in target ? { ids: target.ids, scope: null } : { scope: target.scope, ids: null }),
  /** The pages under way finish; no other starts. */
  stopPreviewRefresh: () => call<void>("stop_preview_refresh"),
  onPreviewRefresh: (callback: (progress: PreviewRefresh) => void) => subscription("preview-refresh", callback),
  /** The report «Show report» shows and «Attach report» sends (NP-088). */
  feedbackReport: (language: string) => call<string>("feedback_report", { language }),
  /** «Send»: the one request to the feedback service; nothing goes out before it (NP-088). */
  sendFeedback: (feedback: Feedback) => call<void>("send_feedback", { feedback }),
  getVersion: () => getVersion(),
  /** Supporter (NP-066, sheet 45): the plan as kept, no request. */
  getSupporterStatus: () => call<SupporterStatus>("get_supporter_status"),
  onSupporterStatus: (callback: (status: SupporterStatus) => void) => subscription("supporter-status", callback),
  getSupporterPrices: () => call<SupporterPrices>("get_supporter_prices"),
  /** «Continue»: the payment page opens in the browser. */
  startCheckout: (interval: PlanInterval) => call<string>("start_checkout", { interval }),
  openCheckout: (url: string) => call<void>("open_checkout", { url }),
  /** Only while the dialog waits for the payment. */
  pollCheckout: () => call<CheckoutState>("poll_checkout"),
  /** `automatic`: the dialog opening or coming back into focus, not asked again if just checked. */
  refreshSupporter: (automatic = false) => call<SupporterStatus>("refresh_supporter", { automatic }),
  openSupporterPortal: () => call<void>("open_supporter_portal"),
  sendSignInCode: (email: string) => call<void>("send_sign_in_code", { email }),
  verifySignInCode: (email: string, code: string) => call<SupporterStatus>("verify_sign_in_code", { email, code }),
  signOutSupporter: () => call<SupporterStatus>("sign_out_supporter"),
  // Supporter through Google Play Billing (NP-154): registered in the Play build only, where
  // `capabilities.purchase` is "play". A purchase waiting here shows in `SupporterStatus.play`.
  /** Google Play's prices for the sheet; `available: false` where Play cannot sell (no Play Store). */
  getPlayOffer: () => call<PlayOffer>("get_play_offer"),
  /** Play's sheet for this plan, then the server's verdict: `paid`, `email`, `sign_in`, `pending`… */
  startPlayPurchase: (interval: PlanInterval) => call<PlayState>("start_play_purchase", { interval }),
  /** The email step: the code is sent there (`sign_in`); then `verifySignInCode` binds the purchase. */
  playClaimEmail: (email: string) => call<PlayState>("play_claim_email", { email }),
  // Supporter's backups to a folder of one's choice (commercial/backup_folder.rs).
  getBackupFolder: () => call<BackupFolder>("get_backup_folder"),
  onBackupFolder: (callback: (folder: BackupFolder) => void) => subscription("backup-folder", callback),
  stopBackupFolder: () => call<BackupFolder>("stop_backup_folder"),
  // Sync between a Supporter's computers (commercial/sync, NP-059); every command answers the new status.
  getSyncStatus: () => call<SyncStatus>("get_sync_status"),
  /** Before the first turn-on: whether the account has a main computer already; fails like the connection. */
  getSyncAccount: () => call<SyncAccount>("get_sync_account"),
  onSyncStatus: (callback: (status: SyncStatus) => void) => subscription("sync-status", callback),
  /** The first device becomes the hub; another one waits to be paired from it. Empty name: the computer's. */
  enableSync: (name?: string) => call<SyncStatus>("enable_sync", { name: name ?? null }),
  /** Stops syncing here; the library and the device's place on the account stay. */
  disableSync: () => call<SyncStatus>("disable_sync"),
  /** On the hub, after the person compared the six digits. */
  approveDevice: (device: string) => call<SyncStatus>("approve_device", { device }),
  rejectDevice: (device: string) => call<SyncStatus>("reject_device", { device }),
  /** On the hub: the device is removed and the library key rotated. */
  removeDevice: (device: string) => call<SyncStatus>("remove_device", { device }),
  /** «Make this the main computer»: the main computer is asked; offline, this fails with `hub_offline`. */
  requestMain: () => call<SyncStatus>("request_main"),
  /** On the main computer: Allow hands it over to the asking computer, Deny keeps it. */
  answerMainRequest: (allow: boolean) => call<SyncStatus>("answer_main_request", { allow }),
  /** «Start over from this computer», step one: a code to the account's email, which comes back to show. */
  sendStartOverCode: () => call<string>("send_start_over_code"),
  /** Step two: this computer becomes the main one with a new key; every other one is disconnected. */
  startOver: (code: string) => call<SyncStatus>("start_over", { code }),
  /** «Join…» after sync was started over elsewhere: paired with the new main computer, bookmarks merged back. */
  joinSyncAgain: () => call<SyncStatus>("join_sync_again"),
  dismissSyncNotice: (id: string) => call<SyncStatus>("dismiss_sync_notice", { id }),
  renameDevice: (device: string, name: string) => call<SyncStatus>("rename_device", { device, name }),
  /** A full exchange now; on a device waiting to be paired, the offer again. */
  syncNow: () => call<SyncStatus>("sync_now"),
  /** Diagnostics for support: states and ids, no library content. */
  copySyncReport: () => call<string>("copy_sync_report"),
  // feeds — RSS, Atom and JSON Feed (NP-128, src-tauri/src/feeds). Later feeds tasks add here only.
  // Until NP-129 and NP-131 land, every command but the first four rejects with `not_implemented`.
  /** Every subscription with its counts and health. */
  listFeeds: () => call<Feed[]>("list_feeds"),
  /** Follows a feed address; one already followed answers its subscription. */
  subscribeFeed: (url: string, title: string | null, destination: FeedDestination) =>
    call<Feed>("subscribe_feed", { url, title, destination }),
  /** Rename (an empty title goes back to the feed's own) and «Where new posts go»; null keeps. */
  updateFeed: (uid: string, title: string | null, destination: FeedDestination | null) =>
    call<Feed>("update_feed", { uid, title, destination }),
  unsubscribeFeed: (uid: string) => call<void>("unsubscribe_feed", { uid }),
  acceptFeedMove: (uid: string) => call<Feed>("accept_feed_move", { uid }),
  /** «New link»: the pasted page's head, its metadata and the feeds it names; one request. */
  previewLink: (url: string) => call<LinkPreview>("preview_link", { url }),
  /** The feed itself, only once the «Follow» toggle is on. */
  previewFeed: (url: string) => call<FeedPreview>("preview_feed", { url }),
  listFeedItems: (query: FeedItemQuery) => call<FeedItemPage>("list_feed_items", { query }),
  getFeedArticle: (id: number) => call<FeedArticle>("get_feed_article", { id }),
  setFeedItemsRead: (ids: number[], read: boolean) => call<void>("set_feed_items_read", { ids, read }),
  /** One feed, or all of them with null, up to a fetch time; how many were marked. */
  markFeedRead: (feedUid: string | null, upTo: string | null) => call<number>("mark_feed_read", { feedUid, upTo }),
  /** S, R and F: the post as an ordinary bookmark, through the journal. */
  saveFeedItem: (id: number, place: SavePlace, favorite: boolean): Promise<FeedSave> =>
    call<FeedSave>("save_feed_item", { id, place, favorite }),
  /** One feed, or all of them with null, now; progress comes through onFeedsRefresh. */
  refreshFeeds: (feedUid: string | null) => call<void>("refresh_feeds", { feedUid }),
  clearFeedCache: () => call<void>("clear_feed_cache"),
  importOpml: (content: string) => call<OpmlImport>("import_opml", { content }),
  /** How many feeds were written. */
  exportOpml: () => call<OpmlExport>("export_opml"),
  /** «Check for new posts»: minutes, 0 only on refresh. */
  setFeedsRefreshMinutes: (minutes: number) => call<void>("set_feeds_refresh_minutes", { minutes }),
  onFeedsChanged: (callback: (change: FeedsChanged) => void) => subscription("feeds-changed", callback),
  onFeedsRefresh: (callback: (progress: FeedsRefresh) => void) => subscription("feeds-refresh", callback),
  // end feeds
};
/** The desktop's own commands (src-tauri/src/desktop/commands.rs and the desktop block of ipc.rs); a phone has none. */
const nativeDesktop = {
  /** The last exported file in Explorer. */
  revealExport: () => call<void>("reveal_export"),
  /** The copies' folder in Finder or Explorer, made if missing. */
  revealOfflineFolder: () => call<void>("reveal_offline_folder"),
  setCloseToTray: (enabled: boolean) =>
    call<void>("set_close_to_tray", { enabled }),
  getCaptureStatus: () => call<CaptureStatus>("get_capture_status"),
  onCaptureStatus: (callback: (status: CaptureStatus) => void) =>
    subscription("capture-status", callback),
  repairCapture: () => call<CaptureStatus>("repair_capture"),
  revealLibraryPlace: (place: LibraryPlace) =>
    call<void>("reveal_library_place", { place }),
  quitApp: () => call<void>("quit_app"),
  /** The window buttons the system wants and whether a tray shows the icon (NP-053). */
  getDesktop: () => call<Desktop>("get_desktop"),
  /** «Hide window» after the first close without a tray (NP-096). */
  hideToBackground: () => call<void>("hide_to_background"),
  onCloseToBackground: (callback: () => void) =>
    subscription("close-to-background", callback),
  getAutostart: () => call<boolean>("get_autostart"),
  setAutostart: (enabled: boolean) => call<void>("set_autostart", { enabled }),
  /** A copy in the backups folder, selected in Explorer. */
  revealBackup: (fileName: string) => call<void>("reveal_backup", { fileName }),
  /** The app's own update (NP-038, sheet 42): checked by Rust at the start and once a day. */
  getUpdateStatus: () => call<UpdateStatus>("get_update_status"),
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => subscription("update-status", callback),
  /** «Check for updates» and «Try again» in Settings. */
  checkForUpdates: () => call<UpdateStatus>("check_for_updates"),
  /** «Update»: the download starts; progress, installation and failure come through onUpdateStatus. */
  installUpdate: () => call<void>("install_update"),
  cancelUpdate: () => call<void>("cancel_update"),
  /** The tray menu and tooltip in the interface's language (NP-085). */
  setTrayLabels: (labels: TrayLabels) => call<void>("set_tray_labels", { labels }),
  /** Settings → AI assistants (NP-091): access, the last request, and how to connect. */
  getMcpStatus: () => call<McpStatus>("get_mcp_status"),
  setMcpAccess: (access: McpAccess) => call<McpStatus>("set_mcp_access", { access }),
  onMcpStatus: (callback: (status: McpStatus) => void) => subscription("mcp-status", callback),
  getMcpSetup: () => call<McpSetup>("get_mcp_setup"),
  /** «Save for Claude Desktop…»: the .mcpb package where the person saves it; its file name, none when cancelled. */
  saveMcpb: () => call<string | null>("save_mcpb"),
  /** The system's folder picker with this title; cancelling it changes nothing. */
  chooseBackupFolder: (title: string) => call<BackupFolder>("choose_backup_folder", { title }),
  openBackupFolder: () => call<void>("open_backup_folder"),
};
/** The calls every build has. */
export type Api = typeof native;
/** The calls only a desktop has (NP-072a): reached through {@link desktopApi}. */
export type DesktopApi = typeof nativeDesktop;
export const api: Api = isTauri() ? native : demo;
/**
 * The desktop's own calls, or null in a build without them (a phone). Shared code shows what uses
 * them only with the matching capability (src/platform/capabilities.ts).
 */
export const desktopApi: DesktopApi | null = !desktopCommands ? null : isTauri() ? nativeDesktop : demo;

/**
 * The desktop's calls, in code only a desktop reaches: a component shown with the matching
 * capability. In a build without them this is a bug, said at once.
 */
export function desktopOnly(): DesktopApi {
  if (!desktopApi) throw new Error("A desktop-only call in a build without the desktop's commands");
  return desktopApi;
}
