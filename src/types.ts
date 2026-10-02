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
}
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
