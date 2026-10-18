import { describe, expect, it } from "vitest";
import type { ListPreview } from "../bindings/ListPreview";
import { defaultChoices, downloadFailure, downloadShare, fileOf, footerAction, hostOf, importCounts, importOptions, nothingNew, otherAppName, refusalOf } from "./lists";

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
  ...over,
});

describe("the list dialog's choices", () => {
  it("start from the plan's defaults and count what will be imported", () => {
    const p = preview();
    const choices = defaultChoices(p);
    expect(choices).toEqual({
      destination: { kind: "list" },
      toInbox: false,
      sectionsAsTags: true,
      existing: "leave",
      follow: true,
      feeds: ["https://blog.rust-lang.org/feed.xml", "https://without.boats/index.xml"],
    });
    expect(importCounts(p, choices)).toEqual({ links: 2, feeds: 2 });
    expect(importCounts(p, { ...choices, feeds: [choices.feeds[1]] })).toEqual({ links: 2, feeds: 1 });
    expect(importCounts(p, { ...choices, follow: false })).toEqual({ links: 2, feeds: 0 });
  });

  it("become the options of import_list, reusing a collection of the list's name", () => {
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
    expect(importOptions(p, { ...choices, destination: { kind: "existing", id: 3 } }).collection).toEqual({ kind: "existing", id: 3 });
    expect(importOptions(p, { ...choices, destination: { kind: "none" } }).collection).toEqual({ kind: "none" });
    // Unchecked feeds and a switched-off «Follow» follow nothing more; the list's order is kept.
    expect(importOptions(p, { ...choices, feeds: ["https://without.boats/index.xml", "https://blog.rust-lang.org/feed.xml"] }).follow_feeds).toEqual([
      "https://blog.rust-lang.org/feed.xml",
      "https://without.boats/index.xml",
    ]);
    expect(importOptions(p, { ...choices, follow: false }).follow_feeds).toEqual([]);
  });

  it("know when nothing in the list is new, and what the footer offers", () => {
    expect(nothingNew(preview())).toBe(false);
    expect(nothingNew(preview({ new_links: 0 }))).toBe(false);
    // Saved links could still get the list's tags.
    expect(nothingNew(preview({ new_links: 0, new_feeds: [] }))).toBe(false);
    expect(nothingNew(preview({ new_links: 0, new_feeds: [], already_saved: 0 }))).toBe(true);
    const p = preview();
    const choices = defaultChoices(p);
    expect(footerAction(p, choices)).toEqual({ kind: "import", links: 2, feeds: 2 });
    const saved = preview({ new_links: 0, already_saved: 3 });
    expect(footerAction(saved, { ...choices, follow: false })).toEqual({ kind: "close" });
    expect(footerAction(saved, { ...choices, feeds: [] })).toEqual({ kind: "close" });
    expect(footerAction(saved, { ...choices, follow: false, existing: "add_tags" })).toEqual({ kind: "tags", links: 3 });
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
