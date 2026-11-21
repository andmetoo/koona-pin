import { describe, expect, it } from "vitest";
import cases from "../../tests/fixtures/url-keys.json";
import { vectors } from "../../tests/kpin-conformance";
import i18n from "../i18n";
import { Bookmark, CheckedLink, LinkCheckReport } from "../types";
import { carriesLink, destinationOf, linkFrom, samePage, typedLink, webLink } from "./addLink";
import { demoAnswer } from "./demo";
import { clutter, groupsOf, mergedFields, urlKey } from "./duplicates";
import { checkedWhen, etaText, finishedLine, replacedNotice, resultLabel } from "./linkcheck";

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

/** The same cases as `dedupe::tests` in Rust: the demo groups as the app does. */
describe("urlKey", () => {
  it("finds the same page as the .kpin conformance suite says", () => {
    for (const { a, b, same } of vectors<{ a: string; b: string; same: boolean }>("same-page.json")) expect(urlKey(a) === urlKey(b), `${a} · ${b}`).toBe(same);
  });

  it("sets aside what does not change the page", () => {
    for (const same of cases.same) expect(urlKey(same), same).toBe(cases.key);
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

describe("link check words (sheet 35)", () => {
  const ru = i18n.getFixedT("ru");
  const en = i18n.getFixedT("en");

  const link = (status: number | null, reason: CheckedLink["reason"] = null): CheckedLink => ({
    bookmark: { id: 1, url: "https://example.com/" } as Bookmark,
    status,
    reason,
    target: null,
    conflict: false,
    checked_at: "2026-10-05T12:00:00.000Z",
  });

  it("name what the site answered", () => {
    expect(resultLabel(ru, link(404), "gone")).toBe("404 · Не найдена");
    expect(resultLabel(ru, link(410), "gone")).toBe("410 · Удалена");
    expect(resultLabel(ru, link(301), "moved")).toBe("301 · Переехала");
    expect(resultLabel(ru, link(null, "timeout"), "failed")).toBe("Нет ответа за 10 с");
    expect(resultLabel(ru, link(null, "no_site"), "failed")).toBe("Сайт не найден");
    expect(resultLabel(ru, link(999, "status"), "failed")).toBe("Отказ · 999");
    expect(resultLabel(ru, link(503, "status"), "failed")).toBe("Ошибка сервера · 503");
    expect(resultLabel(en, link(429, "status"), "failed")).toBe("Too many requests · 429");
    expect(resultLabel(en, link(400, "status"), "failed")).toBe("Answer 400");
  });

  it("say when and how long", () => {
    const now = new Date(2026, 9, 5, 15, 0);
    expect(checkedWhen(ru, new Date(2026, 9, 5, 9, 0).toISOString(), "ru", now)).toBe("Проверено сегодня");
    expect(checkedWhen(en, new Date(2026, 9, 4, 9, 0).toISOString(), "en", now)).toBe("Checked yesterday");
    expect(etaText(ru, 200)).toBe("ещё ≈ 3 мин");
    expect(etaText(ru, 20)).toBe("меньше минуты");
    expect(etaText(ru, null)).toBeNull();
    const report = { library: 1248, unchecked: 0, open: 1226, local: 3, finished_at: new Date(2026, 9, 5, 14, 2).toISOString() } as LinkCheckReport;
    expect(finishedLine(ru, report, "ru", now)).toBe(
      "Проверено 1248 ссылок сегодня в 14:02 · 1226 открываются · 3 на этом компьютере или в локальной сети не запрашивались",
    );
  });

  it("count replaced addresses, and say why some were not", () => {
    expect(replacedNotice(ru, { replaced: 1, skipped: 0, address: "https://www.onorca.dev/", command: 3 })).toEqual({
      text: "Адрес заменён: onorca.dev",
      alert: false,
    });
    expect(replacedNotice(ru, { replaced: 12, skipped: 0, address: null, command: 3 }).text).toBe("Заменено 12 адресов");
    expect(replacedNotice(ru, { replaced: 12, skipped: 1, address: null, command: 3 }).text).toBe(
      "Заменено 12 адресов · не заменено 1: новый адрес уже сохранён",
    );
    expect(replacedNotice(ru, { replaced: 0, skipped: 1, address: null, command: null })).toEqual({
      text: "Не заменено: новый адрес уже есть в библиотеке",
      alert: true,
    });
  });
});

describe("the demo's made-up answers", () => {
  it("never request anything and stay the same for an address", () => {
    expect(demoAnswer("http://localhost:8080/").outcome).toBe("local");
    expect(demoAnswer("http://192.168.1.1/admin").outcome).toBe("local");
    expect(demoAnswer("not a url").outcome).toBe("local");
    const url = "https://www.archdaily.com/";
    expect(demoAnswer(url)).toEqual(demoAnswer(url));
    const outcomes = new Set(Array.from({ length: 60 }, (_, i) => demoAnswer(`https://example.com/${i}`).outcome));
    expect([...outcomes].sort()).toEqual(["failed", "gone", "moved", "ok"]);
  });
});
