// @vitest-environment jsdom
import { createElement } from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bookmark, BookmarkChange, FilterState } from "../types";

// The list's event handling against a fake backend: the events are delivered by hand.
const handlers: { one?: (c: BookmarkChange) => void; many?: (c: BookmarkChange[]) => void } = {};
const fake = vi.hoisted(() => ({
  getBookmarks: vi.fn(),
  getBookmarkIds: vi.fn(),
  getCollections: vi.fn(async () => []),
  getTags: vi.fn(async () => []),
  getDomains: vi.fn(async () => []),
  getCounts: vi.fn(async () => ({})),
  createStarterLibrary: vi.fn(async () => ({ collections: [], links: [] })),
  setSortLanguage: vi.fn(async () => true),
  reorderCollections: vi.fn(async () => {}),
  onBookmarkChanged: vi.fn(),
  onBookmarksChanged: vi.fn(),
  onLibraryInvalidated: vi.fn(() => () => {}),
  onDuplicatesChanged: vi.fn(() => () => {}),
}));
vi.mock("../services/api", () => ({ api: fake }));
vi.mock("../i18n", () => ({ default: { language: "en", t: (key: string) => key, on: () => {}, off: () => {} } }));

import { useLibrary } from "./useLibrary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row: Bookmark = {
  id: 1,
  url: "https://example.com/",
  title: "Example words",
  description: null,
  image_url: null,
  favicon_url: null,
  site_name: null,
  notes: null,
  domain: "example.com",
  is_favorite: false,
  reading_at: null,
  reading_progress: 0,
  read_at: null,
  offline_at: null,
  collection_id: null,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  revision: 1,
  tags: [],
  triaged_at: "2026-10-01T00:00:00Z",
  deleted_at: null,
  source: "app",
};
const filters: FilterState = {
  search: "words",
  collectionId: null,
  tag: null,
  domain: null,
  onlyFavorites: false,
  onlyInbox: false,
  onlyTrash: false,
  onlyReading: false,
  onlyOffline: false,
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let root: Root;
let state: ReturnType<typeof useLibrary>;
function Probe() {
  state = useLibrary(filters, "newest", { current: null });
  return null;
}

beforeEach(() => {
  fake.onBookmarkChanged.mockImplementation((fn: (c: BookmarkChange) => void) => ((handlers.one = fn), () => {}));
  fake.onBookmarksChanged.mockImplementation((fn: (c: BookmarkChange[]) => void) => ((handlers.many = fn), () => {}));
  fake.getBookmarks.mockImplementation(async (_f: FilterState, cursor: { id?: number; limit?: number }) =>
    cursor.limit === 1 ? { items: [], total: 0, next: null } : { items: [row], total: 1, next: null },
  );
});
afterEach(() => {
  act(() => root.unmount());
  vi.clearAllMocks();
});

describe("useLibrary events", () => {
  it("a batch answered after a newer deletion does not bring the row back", async () => {
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    await act(() => wait(200));
    expect(state.bookmarks.map((b) => b.id)).toEqual([1]);
    expect(state.total).toBe(1);

    // A bulk edit: under a search the database is asked which rows still match…
    let answer!: (ids: number[]) => void;
    fake.getBookmarkIds.mockImplementation(() => new Promise<number[]>((resolve) => (answer = resolve)));
    await act(async () => {
      void handlers.many!([{ kind: "updated", id: 1, revision: 2, bookmark: { ...row, revision: 2, title: "Example words, edited" } }]);
    });
    // …and before it answers the bookmark is deleted.
    await act(async () => handlers.one!({ kind: "deleted", id: 1, revision: 3, bookmark: null }));
    expect(state.bookmarks).toEqual([]);
    expect(state.total).toBe(0);

    // The answer was read before the deletion: the row matched then.
    await act(async () => answer([1]));
    await act(() => wait(500));
    expect(state.bookmarks).toEqual([]);
    expect(state.total).toBe(0);
  });

  it("reads the first list and a section at once, and waits only for typing", async () => {
    let current = filters;
    function Switching() {
      state = useLibrary(current, "newest", { current: null });
      return null;
    }
    // First pages only: no cursor to continue from, not the total alone.
    const reads = () => fake.getBookmarks.mock.calls.filter(([, cursor]) => !cursor.limit && !cursor.after).map(([f]) => f as FilterState);
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Switching)));
    expect(reads()).toHaveLength(1);

    current = { ...filters, onlyInbox: true };
    await act(async () => root.render(createElement(Switching)));
    expect(reads()).toHaveLength(2);
    expect(reads()[1].onlyInbox).toBe(true);

    current = { ...current, search: "word" };
    await act(async () => root.render(createElement(Switching)));
    current = { ...current, search: "wor" };
    await act(async () => root.render(createElement(Switching)));
    expect(reads()).toHaveLength(2);
    await act(() => wait(200));
    // The pause read the last word once.
    expect(reads()).toHaveLength(3);
    expect(reads()[2].search).toBe("wor");
  });
});
