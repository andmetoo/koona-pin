import { describe, expect, it } from "vitest";
import { isOpml, opmlRoot } from "./Dialogs";

describe("opmlRoot (NP-133)", () => {
  it("finds <opml> past the declaration, comments and white space", () => {
    expect(opmlRoot('<?xml version="1.0"?>\n<!-- a -->\n<!-- b --><opml version="2.0">')).toBe(true);
    expect(opmlRoot("  <OPML>")).toBe(true);
  });
  it("refuses other roots and unclosed comments", () => {
    expect(opmlRoot("<rss version=\"2.0\">")).toBe(false);
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
