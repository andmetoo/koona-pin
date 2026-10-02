import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AppSettings,
  Bookmark,
  BookmarkChange,
  Collection,
  DomainCount,
  FilterState,
  LibraryCounts,
  ServerStatus,
  Tag,
} from "../types";
import { demo } from "./demo";

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
const desktop = {
  getBookmarks: (filters: Partial<FilterState> = {}) =>
    invoke<Bookmark[]>("get_bookmarks", {
      search: filters.search?.trim() || null,
      collectionId: filters.collectionId ?? null,
      tag: filters.tag || null,
      domain: filters.domain || null,
      onlyFavorites: filters.onlyFavorites ?? false,
    }),
  getCollections: () => invoke<Collection[]>("get_collections"),
  getTags: () => invoke<Tag[]>("get_tags"),
  getDomains: () => invoke<DomainCount[]>("get_domains"),
  getCounts: () => invoke<LibraryCounts>("get_counts"),
  addBookmark: (data: {
    url: string;
    title?: string;
    collectionId?: number | null;
    tags?: string[];
  }) =>
    invoke<Bookmark>("add_bookmark", {
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
    invoke<Bookmark>("update_bookmark", {
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
      },
    }),
  deleteBookmark: (id: number) => invoke<boolean>("delete_bookmark", { id }),
  createCollection: (name: string, color?: string, icon?: string) =>
    invoke<Collection>("create_collection", {
      name,
      color: color ?? null,
      icon: icon ?? null,
    }),
  deleteCollection: async (id: number) => {
    await invoke("delete_collection", { id });
    return true;
  },
  importHtmlBookmarks: (htmlContent: string) =>
    invoke<number>("import_html_bookmarks", { htmlContent }),
  openUrl: (url: string) => invoke<void>("open_url_external", { url }),
  onBookmarkChanged: (callback: (change: BookmarkChange) => void) =>
    subscription("bookmark-changed", callback),
  onLibraryInvalidated: (callback: () => void) =>
    subscription("library-invalidated", callback),
  getAppSettings: () => invoke<AppSettings>("get_app_settings"),
  setCloseToTray: (enabled: boolean) =>
    invoke<void>("set_close_to_tray", { enabled }),
  getServerStatus: () => invoke<ServerStatus>("get_server_status"),
};
export const api = isTauri() ? desktop : demo;
