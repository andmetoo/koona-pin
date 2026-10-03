import { invoke, InvokeArgs } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import {
  AppSettings,
  Bookmark,
  BookmarkChange,
  BookmarkPatch,
  Collection,
  DataSummary,
  DomainCount,
  FilterState,
  LibraryCounts,
  LibraryPlace,
  LibraryStatus,
  ServerStatus,
  Tag,
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
/** Every command rejects with a `CommandError` carrying a machine code. */
const call = <T>(command: string, args?: InvokeArgs) =>
  invoke<T>(command, args).catch((error: unknown) => {
    throw toCommandError(error);
  });
const desktop = {
  getBookmarks: (filters: Partial<FilterState> = {}) =>
    call<Bookmark[]>("get_bookmarks", {
      search: filters.search?.trim() || null,
      collectionId: filters.collectionId ?? null,
      tag: filters.tag || null,
      domain: filters.domain || null,
      onlyFavorites: filters.onlyFavorites ?? false,
    }),
  getCollections: () => call<Collection[]>("get_collections"),
  getTags: () => call<Tag[]>("get_tags"),
  getDomains: () => call<DomainCount[]>("get_domains"),
  getCounts: () => call<LibraryCounts>("get_counts"),
  addBookmark: (data: {
    url: string;
    title?: string;
    collectionId?: number | null;
    tags?: string[];
  }) =>
    call<Bookmark>("add_bookmark", {
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
    call<Bookmark>("update_bookmark", {
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
  deleteBookmark: (id: number) => call<boolean>("delete_bookmark", { id }),
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
  importHtmlBookmarks: (htmlContent: string) =>
    call<number>("import_html_bookmarks", { htmlContent }),
  openUrl: (url: string) => call<void>("open_url_external", { url }),
  onBookmarkChanged: (callback: (change: BookmarkChange) => void) =>
    subscription("bookmark-changed", callback),
  onLibraryInvalidated: (callback: () => void) =>
    subscription("library-invalidated", callback),
  getAppSettings: () => call<AppSettings>("get_app_settings"),
  setCloseToTray: (enabled: boolean) =>
    call<void>("set_close_to_tray", { enabled }),
  getServerStatus: () => call<ServerStatus>("get_server_status"),
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
  getVersion: () => getVersion(),
};
export const api = isTauri() ? desktop : demo;
