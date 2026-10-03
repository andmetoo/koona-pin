export interface Bookmark {
  id: number;
  url: string;
  title: string;
  description?: string;
  image_url?: string;
  favicon_url?: string;
  domain: string;
  notes?: string;
  is_favorite: boolean;
  collection_id?: number | null;
  created_at: string;
  updated_at: string;
  tags?: string[];
  revision?: number;
  preview_kind?:
    "rams" | "architecture" | "type" | "code" | "photo" | "article";
}

export interface BookmarkChange {
  kind: "created" | "updated" | "deleted";
  id: number;
  revision: number;
  bookmark: Bookmark | null;
}
export interface LibraryCounts {
  total: number;
  favorites: number;
}
export interface ServerStatus {
  running: boolean;
  address: string;
  error: string | null;
  /** The port is held by OddClicks, which writes to its own library. */
  legacy_app?: boolean;
}
/** Why the library was not opened; texts by `code` are in libraryMessages.ts. */
export interface OpenFailure {
  code:
    | "DB_LOCKED"
    | "DB_NEWER_SCHEMA"
    | "DB_FOREIGN"
    | "DB_NOT_DATABASE"
    | "DB_CORRUPT"
    | "BACKUP_FAILED"
    | "MIGRATION_FAILED"
    | "DB_OPEN_FAILED";
  detail: string;
  database: string;
  folder: string;
  backup: string | null;
  schema: number | null;
  supported: number;
  version: string;
}
export type LibraryStatus =
  | { state: "opening" }
  | { state: "ready"; damaged: boolean; moved_aside: string | null }
  | ({ state: "failed" } & OpenFailure);
export type LibraryPlace = "data" | "backups" | "backup";
export interface AppSettings {
  capture_token: string;
  close_to_tray: boolean;
}

export interface Collection {
  id: number;
  name: string;
  color?: string;
  icon?: string;
  count?: number;
  created_at: string;
}

export interface Tag {
  id: number;
  name: string;
  count?: number;
}

export interface DomainCount {
  domain: string;
  count: number;
}

export type ViewMode = "grid" | "list";

export interface FilterState {
  search: string;
  collectionId: number | null;
  tag: string | null;
  domain: string | null;
  onlyFavorites: boolean;
}
