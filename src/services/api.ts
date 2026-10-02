import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Bookmark, Collection, Tag, DomainCount, FilterState } from "../types";

export const isTauri = () => {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
};

export const api = {
  async getBookmarks(filters?: Partial<FilterState>): Promise<Bookmark[]> {
    if (!isTauri()) {
      return getMockBookmarks();
    }
    return await invoke<Bookmark[]>("get_bookmarks", {
      search: filters?.search || null,
      collectionId: filters?.collectionId ?? null,
      tag: filters?.tag || null,
      domain: filters?.domain || null,
      onlyFavorites: filters?.onlyFavorites ?? false,
    });
  },

  async addBookmark(data: {
    url: string;
    title?: string;
    collectionId?: number | null;
    tags?: string[];
  }): Promise<Bookmark> {
    if (!isTauri()) {
      console.log("Mock addBookmark:", data);
      return {
        id: Date.now(),
        url: data.url,
        title: data.title || data.url,
        domain: new URL(data.url).hostname,
        is_favorite: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    }
    return await invoke<Bookmark>("add_bookmark", {
      url: data.url,
      title: data.title || null,
      collectionId: data.collectionId ?? null,
      tags: data.tags || [],
    });
  },

  async updateBookmark(
    id: number,
    data: {
      title?: string;
      notes?: string;
      is_favorite?: boolean;
      collection_id?: number | null;
      tags?: string[];
    }
  ): Promise<Bookmark> {
    if (!isTauri()) {
      throw new Error("Tauri required");
    }
    return await invoke<Bookmark>("update_bookmark", {
      id,
      title: data.title ?? null,
      notes: data.notes ?? null,
      isFavorite: data.is_favorite ?? null,
      collectionId: data.collection_id ?? null,
      tags: data.tags ?? null,
    });
  },

  async deleteBookmark(id: number): Promise<boolean> {
    if (!isTauri()) return true;
    return await invoke<boolean>("delete_bookmark", { id });
  },

  async getCollections(): Promise<Collection[]> {
    if (!isTauri()) {
      return [
        { id: 1, name: "Разработка", color: "#6366f1", icon: "code", count: 4, created_at: "" },
        { id: 2, name: "Дизайн & UI", color: "#ec4899", icon: "palette", count: 2, created_at: "" },
        { id: 3, name: "Статьи / Читать", color: "#10b981", icon: "book-open", count: 3, created_at: "" },
      ];
    }
    return await invoke<Collection[]>("get_collections");
  },

  async createCollection(name: string, color?: string, icon?: string): Promise<Collection> {
    if (!isTauri()) {
      return { id: Date.now(), name, color, icon, created_at: new Date().toISOString() };
    }
    return await invoke<Collection>("create_collection", {
      name,
      color: color || null,
      icon: icon || null,
    });
  },

  async deleteCollection(id: number): Promise<boolean> {
    if (!isTauri()) return true;
    return await invoke<boolean>("delete_collection", { id });
  },

  async getTags(): Promise<Tag[]> {
    if (!isTauri()) {
      return [
        { id: 1, name: "rust", count: 3 },
        { id: 2, name: "frontend", count: 5 },
        { id: 3, name: "ai", count: 2 },
      ];
    }
    return await invoke<Tag[]>("get_tags");
  },

  async getDomains(): Promise<DomainCount[]> {
    if (!isTauri()) {
      return [
        { domain: "github.com", count: 5 },
        { domain: "habr.com", count: 3 },
        { domain: "youtube.com", count: 2 },
      ];
    }
    return await invoke<DomainCount[]>("get_domains");
  },

  async openUrl(url: string): Promise<void> {
    if (!isTauri()) {
      window.open(url, "_blank");
      return;
    }
    await invoke("open_url_external", { url });
  },

  async importHtmlBookmarks(htmlContent: string): Promise<number> {
    if (!isTauri()) return 0;
    return await invoke<number>("import_html_bookmarks", { htmlContent });
  },

  onBookmarkAdded(callback: (bookmark: Bookmark) => void) {
    if (!isTauri()) return () => {};
    const unlistenPromise = listen<Bookmark>("bookmark-added", (event) => {
      callback(event.payload);
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  },
};

function getMockBookmarks(): Bookmark[] {
  return [
    {
      id: 1,
      url: "https://tauri.app",
      title: "Tauri — Build smaller, faster, and more secure desktop applications with a web frontend",
      description: "Build smaller, faster, and more secure desktop applications with a web frontend.",
      image_url: "https://tauri.app/meta/social-card.png",
      favicon_url: "https://tauri.app/favicon.ico",
      domain: "tauri.app",
      is_favorite: true,
      collection_id: 1,
      tags: ["rust", "desktop", "tauri"],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 2,
      url: "https://github.com",
      title: "GitHub: Let's build from here",
      description: "GitHub is where over 100 million developers shape the future of software, together.",
      image_url: "https://github.githubassets.com/images/modules/site/social-cards/campaign-social.png",
      favicon_url: "https://github.githubassets.com/favicons/favicon.png",
      domain: "github.com",
      is_favorite: true,
      collection_id: 1,
      tags: ["git", "code"],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 3,
      url: "https://tailwindcss.com",
      title: "Tailwind CSS - Rapidly build modern websites without ever leaving your HTML",
      description: "A utility-first CSS framework packed with classes like flex, pt-4, text-center and rotate-90 that can be composed to build any design, directly in your markup.",
      image_url: "https://tailwindcss.com/api/og",
      favicon_url: "https://tailwindcss.com/favicons/favicon-32x32.png",
      domain: "tailwindcss.com",
      is_favorite: false,
      collection_id: 2,
      tags: ["css", "frontend"],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];
}
