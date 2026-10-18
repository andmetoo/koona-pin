import { describe, expect, it } from "vitest";
import { draftProblem, escapeMarkdown, escapeProse, fileName, listMarkdown, markdownUrl, mayHoldKey, publicUrl, readDraft, slugify } from "./listText";

const text = JSON.stringify({
  format: "koona",
  app: "pin",
  kind: "list",
  version: "1.0",
  title: "Rust [blogs] (2026)",
  description: "Personal and team blogs.",
  sections: [
    {
      name: "Feeds",
      items: [
        { type: "feed", url: "https://blog.rust-lang.org/feed.xml", site: "https://blog.rust-lang.org", title: "Rust Blog" },
        { type: "feed", url: "https://without.boats/index.xml" },
      ],
    },
  ],
  items: [
    { type: "link", url: "https://doc.rust-lang.org/nomicon/", title: "The `unsafe` [book]", description: "Dark\narts (of) Rust." },
    { type: "link", url: "https://en.wikipedia.org/wiki/Rust_(programming_language)" },
  ],
});

describe("Copy as Markdown", () => {
  it("escapes what would break a link or start code", () => {
    expect(escapeMarkdown("a [b] (c) \\d `e`")).toBe("a \\[b\\] \\(c\\) \\\\d \\`e\\`");
    expect(escapeMarkdown("plain words")).toBe("plain words");
    expect(escapeMarkdown("<b>bold</b>")).toBe("\\<b\\>bold\\</b\\>");
    // Emphasis would change the title readers see.
    expect(escapeMarkdown("*nix tips: snake_case")).toBe("\\*nix tips: snake\\_case");
  });

  it("keeps a description's lines prose: no heading, list, quote or numbered item at a line's start", () => {
    for (const [raw, safe] of [
      ["# Not a heading", "\\# Not a heading"],
      ["- not an item", "\\- not an item"],
      ["+ not an item", "\\+ not an item"],
      ["* not an item", "\\* not an item"],
      ["> not a quote", "\\> not a quote"],
      ["1. not numbered", "1\\. not numbered"],
      ["`code` at the start", "\\`code\\` at the start"],
      ["a - b # c 2. d", "a - b # c 2. d"],
    ]) expect(escapeProse(raw)).toBe(safe);
    expect(escapeProse("first\n  - second")).toBe("first\n  \\- second");
  });

  it("encodes what would end an address early and drops user names", () => {
    expect(markdownUrl("https://example.com/a b\\c(d)")).toBe("https://example.com/a%20b%5Cc%28d%29");
    expect(markdownUrl("https://me:pw@example.com/x")).toBe("https://example.com/x");
    expect(publicUrl("https://example.com/x?y=1")).toBe("https://example.com/x?y=1");
  });

  it("warns of addresses whose query looks like a key", () => {
    for (const url of ["https://a.example/feed?token=1", "https://a.example/?API_KEY=x", "https://a.example/?x=1&Sig=2", "https://a.example/?apikey=1"])
      expect(mayHoldKey(url)).toBe(true);
    // Names made of words: GitLab's feed_token, OAuth's access_token, apiKey.
    for (const url of ["https://gitlab.example/u.atom?feed_token=abc", "https://a.example/?access_token=x", "https://a.example/?apiKey=1", "https://a.example/?private-token=1"])
      expect(mayHoldKey(url)).toBe(true);
    for (const url of ["https://a.example/?q=token", "https://a.example/token", "https://a.example/?keys=1", "https://a.example/?monkey=1", "https://a.example/?design=1", undefined])
      expect(mayHoldKey(url)).toBe(false);
  });

  it("gives a heading, the description and the items grouped under their sections", () => {
    expect(listMarkdown(readDraft(text), "feed")).toBe(
      [
        "# Rust \\[blogs\\] \\(2026\\)",
        "",
        "Personal and team blogs.",
        "",
        "- [The \\`unsafe\\` \\[book\\]](https://doc.rust-lang.org/nomicon/) — Dark arts \\(of\\) Rust.",
        "- [en.wikipedia.org](https://en.wikipedia.org/wiki/Rust_%28programming_language%29)",
        "",
        "## Feeds",
        "",
        "- [Rust Blog](https://blog.rust-lang.org) · [feed](https://blog.rust-lang.org/feed.xml)",
        "- [without.boats](https://without.boats/index.xml)",
        "",
      ].join("\n"),
    );
  });
});

describe("the preview of a built list", () => {
  it("counts links, feeds, sections and bytes, the top level first", () => {
    const draft = readDraft(text);
    expect([draft.links, draft.feeds, draft.sections]).toEqual([2, 2, 1]);
    expect(draft.groups.map((g) => g.name)).toEqual([null, "Feeds"]);
    expect(draft.bytes).toBe(new TextEncoder().encode(text).length);
    expect(draftProblem(draft)).toBeNull();
    expect(draftProblem({ ...draft, title: "  " })).toBe("title");
    expect(draftProblem({ ...draft, links: 0, feeds: 0 })).toBe("empty");
    expect(draftProblem({ ...draft, links: 5_001 })).toBe("too_big");
  });

  it("suggests an id and a file name from the title", () => {
    expect(slugify("Rust blogs, worth following!")).toBe("rust-blogs-worth-following");
    expect(slugify("Блоги о Rust")).toBe("rust");
    expect(slugify("Блоги")).toBe("");
    expect(fileName("")).toBe("list.kpin");
    expect(fileName("rust-blogs")).toBe("rust-blogs.kpin");
  });
});
