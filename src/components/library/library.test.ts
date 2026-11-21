import { describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { Bookmark } from "../../types";
import type { MenuItem } from "../ui/Menu";
import { BookmarkActions, menuEntries } from "./Bookmarks";
import { isOpml, opmlRoot } from "./Dialogs";

const b: Bookmark = {
  id: 1,
  url: "https://example.com/",
  title: "Example",
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
  created_at: "2026-10-01",
  updated_at: "2026-10-01",
  revision: 1,
  tags: [],
  triaged_at: "2026-10-01",
  deleted_at: null,
  source: "app",
};
const actions = { offline: vi.fn() } as unknown as BookmarkActions;
const t = i18n.getFixedT("en");
const entry = (bookmark: Bookmark, id: string) =>
  menuEntries(bookmark, [], actions, t).find((e): e is MenuItem => typeof e === "object" && "id" in e && e.id === id);

describe("the offline entry of a bookmark's menu (NP-126, frame O2)", () => {
  it("saves one without a copy, under the key O", () => {
    const save = entry(b, "offline");
    expect(save?.label).toBe("Save for offline");
    expect(save?.keys).toBe("O");
    save?.onSelect?.();
    expect(actions.offline).toHaveBeenCalledWith(b);
  });
  it("removes the copy of one that has it", () => {
    expect(entry({ ...b, offline_at: "2026-10-03T09:00:00Z" }, "offline")?.label).toBe("Remove offline copy");
  });
  it("is not offered in the trash", () => {
    expect(entry({ ...b, deleted_at: "2026-10-05" }, "offline")).toBeUndefined();
  });
});

describe("opmlRoot (NP-133)", () => {
  it("finds <opml> past the declaration, comments and white space", () => {
    expect(opmlRoot('<?xml version="1.0"?>\n<!-- a -->\n<!-- b --><opml version="2.0">')).toBe(true);
    expect(opmlRoot("  <OPML>")).toBe(true);
  });
  it("refuses other roots and unclosed comments", () => {
    expect(opmlRoot('<rss version="2.0">')).toBe(false);
    expect(opmlRoot("<!-- never closed <opml>")).toBe(false);
    expect(opmlRoot("<opmlx>")).toBe(false);
  });
  it("stays fast on hostile text", () => {
    const hostile = "<!--" + "--><!--".repeat(50_000);
    const start = performance.now();
    expect(opmlRoot(hostile)).toBe(false);
    expect(performance.now() - start).toBeLessThan(200);
  });
  it("trusts the file name first", () => {
    expect(isOpml("feeds.opml", "")).toBe(true);
    expect(isOpml("bookmarks.html", "<!DOCTYPE NETSCAPE-Bookmark-file-1>")).toBe(false);
  });
});
