import { describe, expect, it } from "vitest";
import type { ListPreview } from "../bindings/ListPreview";
import type { ListPreviewItem } from "../bindings/ListPreviewItem";
import { defaultChoices, downloadFailure, downloadShare, fileOf, FOLD_OVER, FOLDED, followAll, hostOf, importCounts, importOptions, nothingNew, otherAppName, previewRows, refusalOf, toggleAll } from "./lists";

const preview = (over: Partial<ListPreview> = {}): ListPreview => ({
  meta: {
    title: "Rust blogs worth following",
    description: null,
    author_name: "Koona",
    author_url: null,
    license: "CC0-1.0",
    language: "en",
    updated: "2026-10-18",
    homepage: null,
    id: "rust-blogs",
    generator: null,
    version: "1.0",
  },
  source: "rust-blogs.kpin",
  newer: false,
  links: 3,
  feeds: 2,
  sections: 2,
  sectioned_links: 3,
  new_links: 2,
  already_saved: 1,
  in_trash: 0,
  repeated: 0,
  not_web: 0,
  invalid: 0,
  feeds_followed: 0,
  skipped_details: 0,
  skipped_items: 0,
  new_feeds: [
    { url: "https://blog.rust-lang.org/feed.xml", title: "Rust Blog", site: null, section: "Compiler and language" },
    { url: "https://without.boats/index.xml", title: null, site: null, section: "Async" },
  ],
  existing_collection: null,
  groups: [],
  ...over,
});

describe("the list dialog's choices", () => {
  it("start from the plan's defaults and count what will be added", () => {
    const p = preview();
    const choices = defaultChoices(p);
    expect(choices).toEqual({
      destination: { kind: "list" },
      toInbox: false,
      feeds: ["https://blog.rust-lang.org/feed.xml", "https://without.boats/index.xml"],
    });
    expect(importCounts(p, choices)).toEqual({ links: 2, feeds: 2 });
    expect(importCounts(p, { ...choices, feeds: [choices.feeds[1]] })).toEqual({ links: 2, feeds: 1 });
    expect(importCounts(p, { ...choices, feeds: [] })).toEqual({ links: 2, feeds: 0 });
  });

  it("become the options of import_list, reusing a collection of the list's name and leaving saved links", () => {
    const p = preview();
    const choices = defaultChoices(p);
    expect(importOptions(p, choices)).toEqual({
      collection: { kind: "new", name: "Rust blogs worth following" },
      to_inbox: false,
      sections_as_tags: true,
      existing_links: "leave",
      follow_feeds: ["https://blog.rust-lang.org/feed.xml", "https://without.boats/index.xml"],
    });
    const reused = preview({ existing_collection: { id: 7, name: "RUST blogs worth following" } });
    expect(importOptions(reused, choices).collection).toEqual({ kind: "existing", id: 7 });
    expect(importOptions(p, { ...choices, destination: { kind: "existing", id: 3 } })).toMatchObject({ collection: { kind: "existing", id: 3 }, sections_as_tags: true });
    expect(importOptions(p, { ...choices, destination: { kind: "none" } })).toMatchObject({ collection: { kind: "none" }, sections_as_tags: true });
    // «No collection, no section tags».
    expect(importOptions(p, { ...choices, destination: { kind: "bare" } })).toMatchObject({ collection: { kind: "none" }, sections_as_tags: false });
    // Unchecked feeds are not followed; the list's order is kept.
    expect(importOptions(p, { ...choices, feeds: ["https://without.boats/index.xml", "https://blog.rust-lang.org/feed.xml"] }).follow_feeds).toEqual([
      "https://blog.rust-lang.org/feed.xml",
      "https://without.boats/index.xml",
    ]);
    expect(importOptions(p, { ...choices, feeds: [] }).follow_feeds).toEqual([]);
  });

  it("know when nothing in the list is new", () => {
    expect(nothingNew(preview())).toBe(false);
    expect(nothingNew(preview({ new_links: 0 }))).toBe(false);
    // Saved links are left as they are, and links in the Trash stay there.
    expect(nothingNew(preview({ new_links: 0, new_feeds: [], already_saved: 3, in_trash: 2 }))).toBe(true);
  });

  it("follow all, none or some feeds", () => {
    const urls = ["a", "b"];
    expect(followAll(urls, ["a", "b", "x"])).toBe("on");
    expect(followAll(urls, ["x"])).toBe("off");
    expect(followAll(urls, ["b"])).toBe("mixed");
    expect(toggleAll(urls, ["b", "x"])).toEqual(["x", "a", "b"]);
    expect(toggleAll(urls, ["a", "b", "x"])).toEqual(["x"]);
    expect(toggleAll(urls, [])).toEqual(["a", "b"]);
  });
});

describe("the preview's rows", () => {
  const item = (url: string, over: Partial<ListPreviewItem> = {}): ListPreviewItem => ({
    kind: "link",
    url,
    title: null,
    host: new URL(url).host,
    site: null,
    status: "new",
    bookmark_id: null,
    feed_uid: null,
    ...over,
  });
  const links = (n: number) => Array.from({ length: n }, (_, i) => item(`https://example.com/${i}`));

  it("put a header over each group, the top level's only when there are others", () => {
    const groups = [
      { name: null, tag: null, items: links(2) },
      { name: "Compiler and language", tag: "compiler-and-language", items: links(1) },
      {
        name: "Feeds",
        tag: null,
        items: [item("https://a.example/feed", { kind: "feed" }), item("https://b.example/feed", { kind: "feed", status: "followed", feed_uid: "f1" })],
      },
    ];
    const rows = previewRows(preview({ groups }), new Set());
    expect(rows.map((r) => r.kind)).toEqual(["group", "item", "item", "group", "item", "group", "item", "item"]);
    expect(rows[3]).toMatchObject({ name: "Compiler and language", tag: "compiler-and-language", count: 1, feedsOnly: false, feeds: [] });
    // «Follow all» covers the new feeds only.
    expect(rows[5]).toMatchObject({ name: "Feeds", feedsOnly: true, feeds: ["https://a.example/feed"] });
    expect(previewRows(preview({ groups: [groups[0]] }), new Set()).map((r) => r.kind)).toEqual(["item", "item"]);
    // A newer MINOR: the notice first.
    expect(previewRows(preview({ groups: [groups[0]], newer: true }), new Set())[0]).toEqual({ kind: "notice" });
  });

  it("fold a group of more than 8 rows to 5 until it is opened", () => {
    const groups = [
      { name: "Eight", tag: "eight", items: links(FOLD_OVER) },
      { name: "Nine", tag: "nine", items: links(FOLD_OVER + 1) },
    ];
    const folded = previewRows(preview({ groups }), new Set());
    expect(folded.filter((r) => r.kind === "item" && r.group === 0)).toHaveLength(8);
    expect(folded.filter((r) => r.kind === "item" && r.group === 1)).toHaveLength(FOLDED);
    expect(folded.at(-1)).toEqual({ kind: "more", group: 1, count: 4 });
    const opened = previewRows(preview({ groups }), new Set([1]));
    expect(opened.filter((r) => r.kind === "item" && r.group === 1)).toHaveLength(9);
    expect(opened.some((r) => r.kind === "more")).toBe(false);
  });
});

describe("refusals and downloads", () => {
  it("map a list's refusal to a state of the dialog", () => {
    expect(refusalOf({ outcome: "needs_newer_app" })).toEqual({ state: "newer" });
    expect(refusalOf({ outcome: "other_app", app: "note" })).toEqual({ state: "otherApp", app: "note" });
    expect(refusalOf({ outcome: "too_big" })).toEqual({ state: "notList", reason: "too_big" });
    expect(refusalOf({ outcome: "empty" })).toEqual({ state: "notList", reason: "empty" });
    expect(otherAppName("note")).toBe("Koona Note");
    expect(otherAppName("<b>x</b>")).toBe("Koona B x b");
    expect(otherAppName("")).toBe("Koona");
  });

  it("give a failed download its reason", () => {
    expect(downloadFailure({ outcome: "status", status: 404 })).toEqual({ key: "status", status: 404 });
    expect(downloadFailure({ outcome: "timeout" })).toEqual({ key: "timeout" });
    expect(downloadFailure({ outcome: "not_https" })).toEqual({ key: "not_https" });
    expect(downloadFailure({ outcome: "done", text: "{}", url: "https://koona.app/x.kpin" })).toBeNull();
    expect(downloadFailure({ outcome: "cancelled" })).toBeNull();
  });

  it("name where a list comes from", () => {
    expect(hostOf("https://koona.app/pin/lists/rust-blogs.kpin")).toBe("koona.app");
    expect(fileOf("https://koona.app/pin/lists/rust%20blogs.kpin?x=1")).toBe("rust blogs.kpin");
    expect(fileOf("https://koona.app/")).toBe("");
    expect(downloadShare(512, 1024)).toBe(0.5);
    expect(downloadShare(512, null)).toBeNull();
  });
});
