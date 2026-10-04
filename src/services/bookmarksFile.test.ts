import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBookmarksFile, parseTime } from "./bookmarksFile";

// The same files and expectations as `import.rs`: the preview and the demo follow the desktop rule.
const file = (name: string) => readFileSync(new URL(`../../tests/fixtures/bookmarks/${name}.html`, import.meta.url), "utf8");
const now = new Date(Date.UTC(2026, 9, 4, 12));
const placed = (name: string) => {
  const parsed = parseBookmarksFile(file(name), now);
  return {
    links: parsed.links.map((l) => [l.url, l.collection, l.tags]),
    skipped: parsed.skipped.map((s) => [s.address, s.reason]),
    folders: parsed.folders,
  };
};

describe("browser bookmarks file", () => {
  it("Chrome: roots are not folders, top-level ones are collections, nested ones tags", () => {
    expect(placed("chrome")).toEqual({
      links: [
        ["https://news.ycombinator.com/", null, []],
        ["https://github.com/", "Работа", []],
        ["https://doc.rust-lang.org/book/", "Работа", ["rust"]],
        ["https://tokio.rs/", "Работа", ["rust", "async"]],
        ["https://habr.com/ru/articles/", null, []],
        ["https://example.com/long-read", "Чтение", []],
        ["https://m.example.com/", null, []],
      ],
      skipped: [
        ["javascript:void(document.title)", "not_web"],
        ["https://github.com/", "repeated"],
        ["chrome://settings/", "not_web"],
      ],
      folders: 4,
    });
    const first = parseBookmarksFile(file("chrome"), now).links[0];
    expect([first.title, first.addedAt]).toEqual(["Hacker News", "2024-09-26T12:01:40.000Z"]);
  });

  it("Edge: roots and addresses that are not saved", () => {
    expect(placed("edge")).toMatchObject({
      links: [
        ["https://learn.microsoft.com/", null, []],
        ["https://www.figma.com/", "Design", []],
        ["https://rsms.me/inter/", "Design", ["fonts"]],
        ["https://linear.app/", "работа", []],
      ],
      skipped: [
        ["file:///C:/Users/me/notes.html", "not_web"],
        ["https://", "invalid"],
      ],
    });
  });

  it("Firefox: menu folders are collections, marked roots are not, its tags come along", () => {
    expect(placed("firefox")).toMatchObject({
      links: [
        ["https://www.mozilla.org/en-US/firefox/central/", null, []],
        ["https://support.mozilla.org/en-US/products/firefox", "Mozilla Firefox", []],
        ["https://cooking.example/borscht", "Recipes", ["soup", "beets"]],
        ["https://cooking.example/syrniki", "Recipes", ["desserts", "breakfast"]],
        ["https://developer.mozilla.org/", null, []],
        ["https://example.org/essay", "Reading", []],
        ["https://example.net/unfiled", null, ["later"]],
      ],
      skipped: [["place:sort=8&maxResults=10", "not_web"]],
    });
    expect(parseBookmarksFile(file("firefox"), now).links[2].title).toBe("Borscht");
  });

  it("save dates in seconds, milliseconds, microseconds or ISO; nonsense is ignored", () => {
    expect(parseTime("1727352000", now)).toBe("2024-09-26T12:00:00.000Z");
    expect(parseTime("1727352000123", now)).toBe("2024-09-26T12:00:00.123Z");
    expect(parseTime("1727352000123456", now)).toBe("2024-09-26T12:00:00.123Z");
    expect(parseTime("2024-09-26T15:00:00+03:00", now)).toBe("2024-09-26T12:00:00.000Z");
    for (const raw of ["", "0", "315532800", "4102444800", "22 ноября 2026", "-5"]) expect(parseTime(raw, now)).toBeNull();
  });
});
