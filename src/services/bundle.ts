// The bundle (share-bundle.md, piece B): links, collections, tags and feeds gathered to share as one
// `.kpin` list. It lives in memory for the app session and goes when the app closes: nothing here
// touches localStorage, the settings, sync, backups or the network. Sections are a snapshot of what
// was added; the builder reads each item's fields from the library when the file is built.
import type { TFunction } from "i18next";
import type { Bookmark, Collection, Feed, FilterState } from "../types";
import type { BundleModel, BundleOrigin } from "./bundleApi";
import { feedName } from "./feeds";

/** The title at most, as `TITLE_LEN` in the format. */
export const TITLE_LEN = 120;

/**
 * One thing in the bundle with what the panel shows of it, as it was when added. `useNote`: «Add my
 * note», the note goes in as the item's description.
 */
export type BundleEntry = { kind: "bookmark"; bookmark: Bookmark; useNote: boolean } | { kind: "feed"; feed: Feed };

export interface BundleSection {
  /** Stable for the session: `links`, `feeds`, `collection:12`, `tag:crypto`. */
  key: string;
  origin: BundleOrigin;
  /** A collection's or a tag's name; a collection's follows its renames. Empty for Links and Feeds. */
  name: string;
  entries: BundleEntry[];
}

export interface BundleState {
  /** Links first, named sections in the order added, Feeds last. */
  sections: BundleSection[];
  /** The person's title; it stops following the sections once edited. */
  title: string;
  titleEdited: boolean;
  description: string;
  author: string;
  /** × on the resting capsule: hidden for the session; the contents stay. */
  hidden: boolean;
  /** The panel is open. */
  open: boolean;
  /** Bundled items that were deleted or moved to Trash since the last change: one meta line. */
  left: number;
  /** A section added again: its header flashes. The nonce makes each flash new. */
  flash: { key: string; nonce: number } | null;
}

/** What an add did, for the announcement. */
export type Added =
  | { kind: "bookmarks"; added: number; total: number }
  | { kind: "feeds"; added: number; total: number }
  | { kind: "section"; name: string; added: number; total: number }
  | { kind: "already"; name: string };

const initial = (): BundleState => ({
  sections: [],
  title: "",
  titleEdited: false,
  description: "",
  author: "",
  hidden: false,
  open: false,
  left: 0,
  flash: null,
});

export const sectionKey = (origin: BundleOrigin) =>
  origin.kind === "collection" ? `collection:${origin.id}` : origin.kind === "tag" ? `tag:${origin.name}` : origin.kind;

export const entryKey = (entry: BundleEntry) => (entry.kind === "bookmark" ? `b:${entry.bookmark.id}` : `f:${entry.feed.uid}`);

/** Links on top, the named sections as added, Feeds last. */
function ordered(sections: BundleSection[]) {
  const rank = (s: BundleSection) => (s.origin.kind === "links" ? 0 : s.origin.kind === "feeds" ? 2 : 1);
  return [...sections].sort((a, b) => rank(a) - rank(b));
}

export const itemCount = (state: Pick<BundleState, "sections">) => state.sections.reduce((sum, s) => sum + s.entries.length, 0);

/**
 * The title while the person has not edited it (N1): the first named section's name, «and N more»
 * for the other named ones; Links and Feeds never count. None named: «Untitled list».
 */
export function defaultTitle(sections: BundleSection[], t: TFunction): string {
  const named = sections.filter((s) => s.origin.kind === "collection" || s.origin.kind === "tag");
  if (!named.length) return t("bundle.untitled");
  const first = named[0].name;
  return (named.length > 1 ? t("bundle.titleMore", { name: first, count: named.length - 1 }) : first).slice(0, TITLE_LEN);
}

export const titleOf = (state: BundleState, t: TFunction) => (state.titleEdited ? state.title : defaultTitle(state.sections, t));

/** What the builder takes (piece A): ids only, the Links section as top-level items. */
export function toModel(state: BundleState, t: TFunction): BundleModel {
  return {
    title: titleOf(state, t).trim() || t("bundle.untitled"),
    description: state.description,
    author_name: state.author,
    feeds_section: t("bundle.feeds"),
    sections: state.sections.map((s) => ({
      name: s.origin.kind === "links" ? t("bundle.links") : s.origin.kind === "feeds" ? t("bundle.feeds") : s.name,
      origin: s.origin,
      items: s.entries.map((e) => (e.kind === "bookmark" ? { kind: "bookmark", id: e.bookmark.id, use_note: e.useNote } : { kind: "feed", uid: e.feed.uid })),
    })),
  };
}

/** A copy of what Clear takes away, for Undo. */
export type BundleSnapshot = Pick<BundleState, "sections" | "title" | "titleEdited" | "description" | "author">;

/** The store, in the style of `createOpenRequests`: plain state, `subscribe`, no storage of any kind. */
export function createBundle() {
  let state = initial();
  let nonce = 0;
  const listeners = new Set<() => void>();
  const set = (next: Partial<BundleState>) => {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  };
  const has = (key: string) => state.sections.some((s) => s.entries.some((e) => entryKey(e) === key));
  /** The entries not in the bundle yet, each once. */
  const fresh = (entries: BundleEntry[]) => {
    const seen = new Set<string>();
    return entries.filter((e) => {
      const key = entryKey(e);
      if (seen.has(key) || has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  /** Into the section of this origin, made if missing. */
  const into = (origin: BundleOrigin, name: string, entries: BundleEntry[]) => {
    const key = sectionKey(origin);
    const existing = state.sections.find((s) => s.key === key);
    const sections = existing
      ? state.sections.map((s) => (s === existing ? { ...s, entries: [...s.entries, ...entries] } : s))
      : [...state.sections, { key, origin, name, entries }];
    set({ sections: ordered(sections), left: 0 });
  };
  const named = (origin: Extract<BundleOrigin, { kind: "collection" | "tag" }>, name: string, bookmarks: Bookmark[]): Added => {
    if (state.sections.some((s) => s.key === sectionKey(origin))) {
      set({ flash: { key: sectionKey(origin), nonce: ++nonce } });
      return { kind: "already", name };
    }
    const entries = fresh(bookmarks.map((bookmark) => ({ kind: "bookmark", bookmark, useNote: false })));
    into(origin, name, entries);
    return { kind: "section", name, added: entries.length, total: itemCount(state) };
  };
  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Bookmarks dragged, a selection, or a view of links: into «Links», each once in the bundle. */
    addBookmarks(bookmarks: Bookmark[]): Added {
      const entries = fresh(bookmarks.filter((b) => !b.deleted_at).map((bookmark) => ({ kind: "bookmark", bookmark, useNote: false })));
      if (entries.length) into({ kind: "links" }, "", entries);
      return { kind: "bookmarks", added: entries.length, total: itemCount(state) };
    },
    /** A collection's links at this moment; added again, its header flashes. */
    addCollection: (collection: Pick<Collection, "id" | "name">, bookmarks: Bookmark[]) =>
      named({ kind: "collection", id: collection.id }, collection.name, bookmarks.filter((b) => !b.deleted_at)),
    addTag: (name: string, bookmarks: Bookmark[]) => named({ kind: "tag", name }, name, bookmarks.filter((b) => !b.deleted_at)),
    /** A feed row or All feeds: into «Feeds». */
    addFeeds(feeds: Feed[]): Added {
      const entries = fresh(feeds.map((feed) => ({ kind: "feed", feed })));
      if (entries.length) into({ kind: "feeds" }, "", entries);
      return { kind: "feeds", added: entries.length, total: itemCount(state) };
    },
    removeEntry(key: string) {
      const sections = state.sections.map((s) => ({ ...s, entries: s.entries.filter((e) => entryKey(e) !== key) })).filter((s) => s.entries.length);
      set({ sections });
    },
    removeSection(key: string) {
      set({ sections: state.sections.filter((s) => s.key !== key) });
    },
    setUseNote(key: string, useNote: boolean) {
      set({
        sections: state.sections.map((s) => ({
          ...s,
          entries: s.entries.map((e) => (e.kind === "bookmark" && entryKey(e) === key ? { ...e, useNote } : e)),
        })),
      });
    },
    setTitle: (title: string) => set({ title: title.slice(0, TITLE_LEN), titleEdited: true }),
    setDescription: (description: string) => set({ description }),
    setAuthor: (author: string) => set({ author }),
    setHidden: (hidden: boolean) => set({ hidden }),
    setOpen: (open: boolean) => set({ open }),
    /** Clear: everything goes; the snapshot brings it back with Undo. */
    clear(): BundleSnapshot {
      const { sections, title, titleEdited, description, author } = state;
      set({ sections: [], title: "", titleEdited: false, description: "", left: 0 });
      return { sections, title, titleEdited, description, author };
    },
    restore: (snapshot: BundleSnapshot) => set({ ...snapshot, sections: ordered(snapshot.sections) }),
    /**
     * Drops bookmarks no longer in the library or in Trash, and feeds no longer followed (`feeds`
     * null: not known, kept). The count is the meta line «N items left the bundle».
     */
    prune(live: ReadonlySet<number>, feeds: ReadonlySet<string> | null = null): number {
      const keep = (e: BundleEntry) => (e.kind === "bookmark" ? live.has(e.bookmark.id) : !feeds || feeds.has(e.feed.uid));
      const gone = state.sections.reduce((sum, s) => sum + s.entries.filter((e) => !keep(e)).length, 0);
      if (gone) set({ sections: state.sections.map((s) => ({ ...s, entries: s.entries.filter(keep) })).filter((s) => s.entries.length), left: state.left + gone });
      return gone;
    },
    /** A collection's section follows a rename; one deleted keeps its stored name. */
    follow(collections: Collection[]) {
      let changed = false;
      const sections = state.sections.map((s) => {
        if (s.origin.kind !== "collection") return s;
        const id = s.origin.id;
        const name = collections.find((c) => c.id === id)?.name;
        if (!name || name === s.name) return s;
        changed = true;
        return { ...s, name };
      });
      if (changed) set({ sections });
    },
    /** Tests only: as at the start of the app. */
    reset: () => set(initial()),
  };
}

export type Bundle = ReturnType<typeof createBundle>;

/** The app's bundle, for this session. */
export const bundle = createBundle();

/**
 * The view on screen as «Add {view}» adds it (N6): a collection or a tag makes its own section;
 * All bookmarks, a search, Inbox, Favorites, Reading and Offline go into Links; a feed or All feeds
 * into Feeds. Trash offers nothing.
 */
export type BundleView =
  | { kind: "collection"; collection: Collection }
  | { kind: "tag"; name: string }
  | { kind: "links"; label: string; filters: Partial<FilterState> }
  | { kind: "feeds"; label: string; feeds: Feed[] };

export function bundleView({
  page,
  filters,
  collections,
  section,
  feeds,
  feedUid,
  t,
}: {
  page: string;
  filters: FilterState;
  collections: Collection[];
  /** The toolbar's title of the section. */
  section: string;
  feeds: Feed[] | null;
  feedUid: string | null;
  t: TFunction;
}): BundleView | null {
  if (page === "feeds") {
    if (!feeds?.length) return null;
    if (feedUid === null) return { kind: "feeds", label: t("feeds.all"), feeds };
    const feed = feeds.find((f) => f.uid === feedUid);
    return feed ? { kind: "feeds", label: feedName(feed), feeds: [feed] } : null;
  }
  if (page !== "library" || filters.onlyTrash) return null;
  const plain = !filters.search.trim() && !filters.domain;
  const anySection = filters.onlyFavorites || filters.onlyInbox || filters.onlyReading || filters.onlyOffline;
  if (plain && filters.tag && !filters.collectionId && !anySection) return { kind: "tag", name: filters.tag };
  const collection = filters.collectionId ? collections.find((c) => c.id === filters.collectionId) : undefined;
  if (plain && !filters.tag && collection) return { kind: "collection", collection };
  return { kind: "links", label: filters.tag && !collection && !anySection ? filters.tag : section, filters };
}

export const viewLabel = (view: BundleView) =>
  view.kind === "collection" ? view.collection.name : view.kind === "tag" ? view.name : view.label;
