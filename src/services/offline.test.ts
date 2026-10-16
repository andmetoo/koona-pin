// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfflineCopyContent } from "../types";
import type { ReaderPage } from "../bindings/ReaderPage";

// Offline copies of articles (NP-126): the reader opens the copy first, the page otherwise.
const api = vi.hoisted(() => ({
  fetchReaderPage: vi.fn(),
  getOfflineCopy: vi.fn(),
  saveOfflineCopy: vi.fn(),
}));
vi.mock("./api", () => ({ api }));
const { openArticle, sanitize, saveOffline } = await import("./reader");

const blog = readFileSync(join(__dirname, "fixtures", "reader", "blog.html"), "utf8");
const page = (url: string): ReaderPage => ({ kind: "page", url, status: 200, charset: "utf-8", html: blog, truncated: false });
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const content = (url: string, html: string): OfflineCopyContent => ({
  copy: { bookmark_id: 7, saved_at: "2026-10-03T09:00:00Z", url, bytes: 1200, images: 1, words: 240 },
  article: { url, title: "Saved", author: null, site: "Example", published: null, description: null, language: "en", html, words: 240 },
});

beforeEach(() => {
  api.fetchReaderPage.mockReset();
  api.getOfflineCopy.mockReset();
  api.saveOfflineCopy.mockReset();
});

describe("openArticle", () => {
  it("opens the copy at once, without asking the site", async () => {
    const url = "https://blog.example.org/copy-first/";
    api.getOfflineCopy.mockResolvedValue(content(url, `<p>Kept text</p><img src="${PNG}" alt=""><script>alert(1)</script>`));
    const opened = await openArticle({ id: 7, url, offline_at: "2026-10-03T09:00:00Z" });
    expect(api.fetchReaderPage).not.toHaveBeenCalled();
    expect(api.getOfflineCopy).toHaveBeenCalledWith(7);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.offlineAt).toBe("2026-10-03T09:00:00Z");
    expect(opened.article.title).toBe("Saved");
    // The copy goes through the same sanitize as a live page: its picture stays, the script does not.
    expect(opened.article.html).toContain(PNG);
    expect(opened.article.html).not.toContain("script");
  });

  it("reads the page when the bookmark has no copy, or its copy is gone", async () => {
    const url = "https://blog.example.org/no-copy/";
    api.fetchReaderPage.mockResolvedValue(page(url));
    const fresh = await openArticle({ id: 8, url, offline_at: null });
    expect(api.getOfflineCopy).not.toHaveBeenCalled();
    expect(fresh.ok && fresh.offlineAt).toBe(null);

    const gone = "https://blog.example.org/copy-gone/";
    api.getOfflineCopy.mockResolvedValue(null);
    api.fetchReaderPage.mockResolvedValue(page(gone));
    const opened = await openArticle({ id: 9, url: gone, offline_at: "2026-10-03T09:00:00Z" });
    expect(api.fetchReaderPage).toHaveBeenCalledWith(gone);
    expect(opened.ok).toBe(true);
    expect(opened.ok && opened.offlineAt).toBe(null);
  });

  it("asks the site for «Try live page», and keeps the copy when the site cannot be reached", async () => {
    const url = "https://blog.example.org/live/";
    api.getOfflineCopy.mockResolvedValue(content(url, "<p>Kept text</p>"));
    api.fetchReaderPage.mockResolvedValue({ kind: "failed" });
    const offline = await openArticle({ id: 7, url, offline_at: "2026-10-03T09:00:00Z" }, true);
    expect(api.fetchReaderPage).toHaveBeenCalledWith(url);
    expect(offline.ok && offline.offlineAt).toBe("2026-10-03T09:00:00Z");

    api.fetchReaderPage.mockResolvedValue(page(url));
    const live = await openArticle({ id: 7, url, offline_at: "2026-10-03T09:00:00Z" }, true);
    expect(live.ok && live.offlineAt).toBe(null);
    expect(live.ok && live.article.title).toBe("Don't be afraid of makefiles");
  });
});

describe("saveOffline", () => {
  it("saves the article on screen without a second request, and only what reading mode extracted", async () => {
    const url = "https://blog.example.org/on-screen/";
    api.fetchReaderPage.mockResolvedValue(page(url));
    const shown = await openArticle({ id: 3, url, offline_at: null });
    if (!shown.ok) throw new Error("no article");
    api.fetchReaderPage.mockClear();
    api.saveOfflineCopy.mockResolvedValue(content(url, "").copy);
    const saved = await saveOffline({ id: 3, url }, shown.article);
    expect(saved.ok).toBe(true);
    expect(api.fetchReaderPage).not.toHaveBeenCalled();
    const [id, article] = api.saveOfflineCopy.mock.calls[0];
    expect(id).toBe(3);
    expect(Object.keys(article).sort()).toEqual(["author", "description", "html", "language", "published", "site", "title", "url", "words"]);
  });

  it("reads an unopened page first and says why when it cannot", async () => {
    api.fetchReaderPage.mockResolvedValue({ kind: "status", url: "https://blog.example.org/gone/", status: 404 });
    const failed = await saveOffline({ id: 4, url: "https://blog.example.org/gone/" });
    expect(failed).toEqual({ ok: false, failure: { reason: "status", status: 404 } });
    expect(api.saveOfflineCopy).not.toHaveBeenCalled();

    api.fetchReaderPage.mockResolvedValue(page("https://blog.example.org/unopened/"));
    api.saveOfflineCopy.mockResolvedValue(content("https://blog.example.org/unopened/", "").copy);
    expect((await saveOffline({ id: 5, url: "https://blog.example.org/unopened/" })).ok).toBe(true);
    expect(api.saveOfflineCopy).toHaveBeenCalledOnce();
  });
});

describe("sanitize and data: pictures", () => {
  const dom = (html: string) => new DOMParser().parseFromString(sanitize(html), "text/html").body;
  it("keeps a copy's inline picture of the saved formats", () => {
    for (const type of ["png", "jpeg", "gif", "webp", "avif"])
      expect(dom(`<img src="data:image/${type};base64,AAAA">`).querySelector("img")?.getAttribute("src")).toBe(`data:image/${type};base64,AAAA`);
  });
  it("drops SVG and every data: address outside a picture's src", () => {
    expect(dom(`<img src="data:image/svg+xml;base64,PHN2Zz4=">`).querySelector("img")?.getAttribute("src")).toBeNull();
    expect(dom(`<img src="data:text/html;base64,PGI+">`).querySelector("img")?.getAttribute("src")).toBeNull();
    expect(dom(`<a href="${PNG}">x</a>`).querySelector("a")?.getAttribute("href")).toBeNull();
    expect(dom(`<img src="https://example.com/a.png">`).querySelector("img")?.getAttribute("src")).toBe("https://example.com/a.png");
  });
});
