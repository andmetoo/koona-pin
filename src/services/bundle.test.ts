import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { Bookmark, Collection, Feed, FilterState } from "../types";
import { bundleView, createBundle, defaultTitle, itemCount, titleOf, toModel } from "./bundle";

const t = i18n.getFixedT("en");
const b = (id: number, extra: Partial<Bookmark> = {}) => ({ id, url: `https://example.com/${id}`, title: `Page ${id}`, deleted_at: null, notes: null, ...extra }) as Bookmark;
const feed = (uid: string) => ({ uid, url: `https://example.com/${uid}.xml`, title: uid, feed_title: null, site_url: null }) as Feed;
const collection = (id: number, name: string) => ({ id, name, count: 2 }) as Collection;
const filters = (extra: Partial<FilterState> = {}): FilterState => ({
  search: "",
  tag: null,
  domain: null,
  collectionId: null,
  onlyFavorites: false,
  onlyInbox: false,
  onlyTrash: false,
  onlyReading: false,
  onlyOffline: false,
  ...extra,
});

describe("the bundle store", () => {
  afterEach(() => vi.restoreAllMocks());

  it("adds a bookmark once, in the section it entered first", () => {
    const bundle = createBundle();
    expect(bundle.addBookmarks([b(1), b(2), b(2)])).toEqual({ kind: "bookmarks", added: 2, total: 2 });
    expect(bundle.addCollection(collection(7, "Design"), [b(2), b(3)])).toEqual({ kind: "section", name: "Design", added: 1, total: 3 });
    expect(bundle.addBookmarks([b(3)])).toMatchObject({ added: 0 });
    const [links, design] = bundle.get().sections;
    expect(links.entries.map((e) => e.kind === "bookmark" && e.bookmark.id)).toEqual([1, 2]);
    expect(design.entries.map((e) => e.kind === "bookmark" && e.bookmark.id)).toEqual([3]);
    // Trashed bookmarks never come in.
    expect(bundle.addBookmarks([b(9, { deleted_at: "2026-10-01" })])).toMatchObject({ added: 0 });
  });

  it("adds thousands of links to a big bundle quickly, not one scan of the bundle per link", () => {
    const bundle = createBundle();
    bundle.addBookmarks(Array.from({ length: 4000 }, (_, i) => b(i)));
    const more = Array.from({ length: 3000 }, (_, i) => b(2000 + i));
    const started = performance.now();
    expect(bundle.addBookmarks(more)).toEqual({ kind: "bookmarks", added: 1000, total: 5000 });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("flashes a collection or a tag added again instead of adding it twice", () => {
    const bundle = createBundle();
    bundle.addTag("crypto", [b(1)]);
    expect(bundle.addTag("crypto", [b(2)])).toEqual({ kind: "already", name: "crypto" });
    expect(bundle.get().flash?.key).toBe("tag:crypto");
    expect(itemCount(bundle.get())).toBe(1);
  });

  it("keeps Links on top, named sections in the order added and Feeds last", () => {
    const bundle = createBundle();
    bundle.addFeeds([feed("a")]);
    bundle.addTag("rust", [b(1)]);
    bundle.addBookmarks([b(2)]);
    bundle.addCollection(collection(3, "Design"), [b(4)]);
    expect(bundle.get().sections.map((s) => s.key)).toEqual(["links", "tag:rust", "collection:3", "feeds"]);
    const model = toModel(bundle.get(), t);
    expect(model.sections.map((s) => [s.name, s.origin.kind])).toEqual([
      ["Links", "links"],
      ["rust", "tag"],
      ["Design", "collection"],
      ["Feeds", "feeds"],
    ]);
    expect([model.feeds_section, model.links_word]).toEqual(["Feeds", "links"]);
    expect(model.sections[0].items).toEqual([{ kind: "bookmark", id: 2, use_note: false }]);
  });

  it("titles itself from the named sections until the title is edited (N1)", () => {
    const bundle = createBundle();
    expect(titleOf(bundle.get(), t)).toBe("Untitled list");
    bundle.addBookmarks([b(1)]);
    bundle.addFeeds([feed("a")]);
    expect(titleOf(bundle.get(), t)).toBe("Untitled list");
    bundle.addCollection(collection(1, "Design & UI"), [b(2)]);
    expect(titleOf(bundle.get(), t)).toBe("Design & UI");
    bundle.addTag("crypto", [b(3)]);
    // Links and Feeds never count: K7a's sample.
    expect(defaultTitle(bundle.get().sections, t)).toBe("Design & UI and 1 more");
    bundle.setTitle("My list");
    bundle.addTag("rust", [b(4)]);
    expect(titleOf(bundle.get(), t)).toBe("My list");
    bundle.setTitle("x".repeat(200));
    expect(titleOf(bundle.get(), t)).toHaveLength(120);
  });

  it("follows a collection's rename and keeps the name of one deleted", () => {
    const bundle = createBundle();
    bundle.addCollection(collection(1, "Dev"), [b(1)]);
    bundle.follow([collection(1, "Development")]);
    expect(bundle.get().sections[0].name).toBe("Development");
    bundle.follow([]);
    expect(bundle.get().sections[0].name).toBe("Development");
  });

  it("drops what left the library and counts it for the meta line", () => {
    const bundle = createBundle();
    bundle.addBookmarks([b(1), b(2)]);
    bundle.addTag("solo", [b(3)]);
    bundle.addFeeds([feed("a"), feed("b")]);
    expect(bundle.prune(new Set([1]), new Set(["a"]))).toBe(3);
    expect(bundle.get().left).toBe(3);
    expect(bundle.get().sections.map((s) => s.key)).toEqual(["links", "feeds"]);
    // Feeds unknown: kept.
    expect(bundle.prune(new Set([1]), null)).toBe(0);
    // The next add starts a new count.
    bundle.addBookmarks([b(5)]);
    expect(bundle.get().left).toBe(0);
  });

  it("prunes only what was added by the generation its ids were read at", () => {
    const ids = (store: ReturnType<typeof createBundle>) => store.get().sections.flatMap((s) => s.entries.map((e) => e.kind === "bookmark" && e.bookmark.id));
    const bundle = createBundle();
    bundle.addBookmarks([b(1), b(2)]);
    const before = bundle.generation();
    bundle.addTag("later", [b(3)]);
    bundle.addFeeds([feed("a")]);
    // Ids and feeds read before the tag and the feed came in: those two stay.
    expect(bundle.prune(new Set([1]), new Set(), before)).toBe(1);
    expect(bundle.get().sections.map((s) => s.key)).toEqual(["links", "tag:later", "feeds"]);
    // Removed and added again: as new, so only the tag and the feed go.
    bundle.removeEntry("b:1");
    const again = bundle.generation();
    bundle.addBookmarks([b(1)]);
    expect(bundle.prune(new Set(), new Set(), again)).toBe(2);
    expect(ids(bundle)).toEqual([1]);
    expect(bundle.prune(new Set(), new Set())).toBe(1);
  });

  it("clears with an undo, and the note goes in only when asked", () => {
    const bundle = createBundle();
    bundle.addBookmarks([b(1, { notes: "mine" })]);
    bundle.setUseNote("b:1", true);
    expect(toModel(bundle.get(), t).sections[0].items).toEqual([{ kind: "bookmark", id: 1, use_note: true }]);
    const snapshot = bundle.clear();
    expect(itemCount(bundle.get())).toBe(0);
    bundle.restore(snapshot);
    expect(itemCount(bundle.get())).toBe(1);
  });

  it("never touches storage", () => {
    // Tests run in Node: a storage that records every call stands in for the browser's.
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(), key: vi.fn(), length: 0 };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);
    const calls = [storage.getItem, storage.setItem, storage.removeItem, storage.clear, storage.key];
    const bundle = createBundle();
    bundle.addBookmarks([b(1)]);
    bundle.addCollection(collection(2, "Design"), [b(2)]);
    bundle.addFeeds([feed("a")]);
    bundle.setTitle("Shared");
    bundle.setDescription("About");
    bundle.setAuthor("Me");
    bundle.setHidden(true);
    bundle.setOpen(true);
    bundle.prune(new Set([1]));
    bundle.restore(bundle.clear());
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    // A new store, as after a restart, is empty.
    expect(itemCount(createBundle().get())).toBe(0);
  });
});

describe("«Add {view}» (N6)", () => {
  const collections = [collection(4, "Development")];
  const view = (extra: Partial<FilterState>, page = "library") =>
    bundleView({ page, filters: filters(extra), collections, section: "Section", feeds: [feed("a"), feed("b")], feedUid: null, t });

  it("makes a section of a collection or a tag", () => {
    expect(view({ collectionId: 4 })).toEqual({ kind: "collection", collection: collections[0] });
    expect(view({ tag: "crypto" })).toEqual({ kind: "tag", name: "crypto" });
  });

  it("puts everything else into Links", () => {
    for (const extra of [{}, { search: "rust" }, { onlyInbox: true }, { onlyFavorites: true }, { onlyReading: true }, { collectionId: 4, search: "x" }])
      expect(view(extra)?.kind).toBe("links");
    expect(view({ onlyInbox: true })).toMatchObject({ label: "Section", filters: { onlyInbox: true } });
  });

  it("offers nothing in Trash or Settings", () => {
    expect(view({ onlyTrash: true })).toBeNull();
    expect(view({}, "settings")).toBeNull();
  });

  it("puts All feeds or one feed into Feeds", () => {
    expect(view({}, "feeds")).toMatchObject({ kind: "feeds", label: "All feeds" });
    const one = bundleView({ page: "feeds", filters: filters(), collections, section: "", feeds: [feed("a"), feed("b")], feedUid: "b", t });
    expect(one).toMatchObject({ kind: "feeds", label: "b", feeds: [{ uid: "b" }] });
  });
});
