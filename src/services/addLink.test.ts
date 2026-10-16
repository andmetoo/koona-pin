import { describe, expect, it } from "vitest";
import { carriesLink, destinationOf, linkFrom, samePage, typedLink, webLink } from "./addLink";

describe("adding a link by hand", () => {
  it("puts https:// in front of a bare address, and only there", () => {
    expect(typedLink("  example.com/page ")).toBe("https://example.com/page");
    expect(typedLink("localhost:1420")).toBe("https://localhost:1420");
    expect(typedLink("ftp://example.com/file")).toBe("ftp://example.com/file");
    expect(typedLink("http://example.com")).toBe("http://example.com");
    expect(typedLink("just words")).toBe("just words");
    expect(typedLink("word")).toBe("word");
  });
  it("takes only http and https links with a host", () => {
    expect(webLink("https://example.com")?.hostname).toBe("example.com");
    expect(webLink("ftp://example.com")).toBeNull();
    expect(webLink("mailto:me@example.com")).toBeNull();
    expect(webLink("not a link")).toBeNull();
  });
  it("saves a pasted text only when it is one link", () => {
    expect(linkFrom(" https://example.com/a \n")).toBe("https://example.com/a");
    expect(linkFrom("look at https://example.com/a")).toBeNull();
    expect(linkFrom("https://a.example\nhttps://b.example")).toBeNull();
    expect(linkFrom("javascript:alert(1)")).toBeNull();
    expect(linkFrom("")).toBeNull();
    expect(linkFrom(null)).toBeNull();
    // A uri-list: comments skipped, the first link taken.
    expect(linkFrom("# from Safari\r\nhttps://a.example/\r\nhttps://b.example/", true)).toBe("https://a.example/");
  });
  it("knows the same address under a trailing slash, and leaves variants to Duplicates", () => {
    expect(samePage("https://example.com/a/", "https://example.com/a")).toBe(true);
    expect(samePage("https://www.example.com/a", "https://example.com/a")).toBe(false);
    expect(samePage("https://example.com/a#top", "https://example.com/a")).toBe(false);
    expect(samePage("https://example.com/a", "https://example.com/b")).toBe(false);
  });
  it("saves where the person is: the inbox, Reading, else the library", () => {
    expect(destinationOf({ onlyInbox: true })).toBe("inbox");
    expect(destinationOf({ onlyReading: true })).toBe("reading");
    expect(destinationOf({})).toBe("library");
  });
  it("lights the drop veil for links, never for files", () => {
    expect(carriesLink(["text/uri-list", "text/plain"])).toBe(true);
    expect(carriesLink(["text/plain"])).toBe(true);
    expect(carriesLink(["Files", "text/uri-list"])).toBe(false);
    expect(carriesLink(["text/html"])).toBe(false);
    expect(carriesLink(null)).toBe(false);
  });
});
