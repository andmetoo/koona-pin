import { describe, expect, it } from "vitest";
import { Bookmark } from "../types";
import { clutter, groupsOf, mergedFields, urlKey } from "./duplicates";
import cases from "../../tests/fixtures/url-keys.json";

/** The same cases as `dedupe::tests` in Rust: the demo groups as the app does. */
describe("urlKey", () => {
  it("sets aside what does not change the page", () => {
    for (const same of cases.same) expect(urlKey(same), same).toBe(cases.key);
    for (const different of cases.different) expect(urlKey(different), different).not.toBe(cases.key);
    for (const [a, b] of cases.equal) expect(urlKey(a), a).toBe(urlKey(b));
    for (const [url, key] of Object.entries(cases.keys)) expect(urlKey(url)).toBe(key);
    for (const none of cases.none) expect(urlKey(none), none).toBeNull();
  });

  it("measures clutter", () => {
    expect(clutter("https://example.com/page")).toBe(0);
    expect(clutter("http://www.example.com/page?utm_source=x#top")).toBe(4);
  });
});

const bookmark = (id: number, url: string, created: string, more: Partial<Bookmark> = {}): Bookmark => ({
  id, url, title: url, description: null, image_url: null, favicon_url: null, site_name: null, domain: "example.com", notes: null,
  is_favorite: false, collection_id: null, tags: [], created_at: created, updated_at: created, revision: 1,
  triaged_at: created, deleted_at: null, source: null, reading_at: null, reading_progress: 0, read_at: null, offline_at: null, ...more,
});

describe("groupsOf and mergedFields", () => {
  it("groups by key, the plainest then oldest is main, the dismissed stay hidden", () => {
    const a = bookmark(1, "https://www.example.com/page?utm_source=x", "2026-01-01");
    const b = bookmark(2, "https://example.com/page/", "2026-02-01");
    const c = bookmark(3, "http://example.com/page#top", "2026-03-01");
    const lone = bookmark(4, "https://example.com/other", "2026-03-01");
    const gone = bookmark(5, "https://example.com/other/", "2026-03-01", { deleted_at: "2026-04-01" });
    const groups = groupsOf([a, b, c, lone, gone], new Map());
    expect(groups.map((g) => [g.key, g.main, g.bookmarks.map((x) => x.id)])).toEqual([["example.com/page", 2, [2, 1, 3]]]);
    expect(groupsOf([a, b, c], new Map([["example.com/page", new Set([1, 2, 3])]]))).toEqual([]);
    expect(groupsOf([a, b, c], new Map([["example.com/page", new Set([1, 2])]]))).toHaveLength(1);
  });

  it("merges every tag, note and star without losing any", () => {
    const main = bookmark(1, "https://x.io/a", "2026-03-03", { tags: ["hardware"], triaged_at: null });
    const second = bookmark(2, "http://x.io/a/", "2026-01-18", { tags: ["crypto", "hardware"], notes: "ask", collection_id: 7 });
    const third = bookmark(3, "https://x.io/a#p", "2026-06-01", { notes: "  ", is_favorite: true });
    expect(mergedFields(main, [third, second])).toEqual({
      tags: ["hardware", "crypto"],
      notes: "ask",
      is_favorite: true,
      collection_id: 7,
      triaged_at: "2026-01-18",
      created_at: "2026-01-18",
    });
  });
});
