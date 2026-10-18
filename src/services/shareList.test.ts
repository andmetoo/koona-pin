import { describe, expect, it } from "vitest";
import { draftProblem, escapeMarkdown, fileName, listMarkdown, readDraft, slugify } from "./shareList";

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
