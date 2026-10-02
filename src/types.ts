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
