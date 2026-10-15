// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countWords, dekOf, extractArticle, linkDensity, READER_MIN_WORDS, sanitize, sharesTitle, READER_SHORT_WORDS, verdict } from "./reader";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", "reader", name), "utf8");
const dom = (html: string) => new DOMParser().parseFromString(html, "text/html").body;

describe("extractArticle", () => {
  it("takes the article out of a blog page", () => {
    const result = extractArticle(fixture("blog.html"), "https://blog.example.org/2024/05/makefiles/");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { article } = result;
    expect(article.title).toBe("Don't be afraid of makefiles");
    expect(article.author).toBe("Rosa Example");
    expect(article.words).toBeGreaterThan(200);
    const body = dom(article.html);
    // Menus, the cookie banner, the share buttons and the comments form are gone.
    expect(body.textContent).not.toMatch(/Accept all cookies|Subscribe to the newsletter|Share on/);
    expect(body.textContent).toContain("A makefile is a list of rules");
    // Code keeps its lines and indents.
    expect(body.querySelector("pre")?.textContent).toMatch(/build:\n\s+go build \.\/\.\.\.\n/);
    // Relative links and pictures are made absolute.
    expect(body.querySelector("a[href='https://blog.example.org/2024/04/go-modules/']")).not.toBeNull();
    expect(body.querySelector("img")?.getAttribute("src")).toBe("https://blog.example.org/images/make.png");
  });

  it("reads a short README: a short article is still an article", () => {
    const result = extractArticle(fixture("readme.html"), "https://github.com/example/web");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.article.words).toBeGreaterThanOrEqual(READER_MIN_WORDS);
    expect(result.article.words).toBeLessThan(200);
    expect(dom(result.article.html).textContent).toContain("A high productivity web framework");
  });

  it("reads Cyrillic text and does not mistake a date for the author", () => {
    const result = extractArticle(fixture("cyrillic.html"), "https://www.example.ru/2012/03/mock-vs-stub.html");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.article.title).toBe("Mock против Stub");
    expect(result.article.author).toBeNull();
    expect(result.article.language).toBe("ru");
    expect(dom(result.article.html).textContent).toContain("Заглушка возвращает заранее заданные ответы");
  });

  it("turns away an app shell and a table of contents", () => {
    expect(extractArticle(fixture("app-shell.html"), "https://app.example.com/")).toEqual({ ok: false, failure: { reason: "empty" } });
    const toc = extractArticle(fixture("toc.html"), "https://gobyexample.example/");
    expect(toc.ok).toBe(false);
    if (toc.ok) return;
    expect(toc.failure.reason).toBe("links");
  });
});

describe("verdict", () => {
  it("shows an article with enough words and few links", () => {
    expect(verdict({ words: 69, linkDensity: 0.02 })).toBeNull();
    expect(verdict({ words: 0, linkDensity: 0 })).toEqual({ reason: "empty" });
    expect(verdict({ words: READER_MIN_WORDS - 1, linkDensity: 0 })).toEqual({ reason: "too_short", words: READER_MIN_WORDS - 1 });
    expect(verdict({ words: 228, linkDensity: 0.69 })).toEqual({ reason: "links", words: 228, linkDensity: 0.69 });
  });

  it("turns away a short extract about something else", () => {
    expect(verdict({ words: 113, linkDensity: 0.08, onTopic: false })).toEqual({ reason: "off_topic", words: 113 });
    expect(verdict({ words: 113, linkDensity: 0.08, onTopic: true })).toBeNull();
    expect(verdict({ words: READER_SHORT_WORDS, linkDensity: 0.08, onTopic: false })).toBeNull();
  });

  it("finds the title's words in the text", () => {
    expect(sharesTitle("How To Install and Use PostgreSQL on Ubuntu 18.04", "Become a contributor for community. Start building today.")).toBe(false);
    expect(sharesTitle("revel/revel: A high productivity, full-stack web framework", "Revel Framework. A high productivity web framework")).toBe(true);
    expect(sharesTitle("Персистентность — Life-Prog", "ПЕРСИСТЕНТНОСТЬ в программировании")).toBe(true);
    expect(sharesTitle("Go", "Go is a language")).toBe(false);
  });
});

/** No element or attribute that can run code, load a frame, submit, restyle the app or clobber its names. */
function expectHarmless(html: string) {
  const body = dom(html);
  for (const tag of ["script", "iframe", "frame", "object", "embed", "form", "input", "button", "textarea", "select", "style", "link", "meta", "base", "svg", "math", "video", "audio", "source", "template", "noscript"]) {
    expect(body.querySelectorAll(tag), tag).toHaveLength(0);
  }
  for (const el of Array.from(body.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      expect(attr.name, `${el.tagName} ${attr.name}`).not.toMatch(/^on|^style$|^class$|^srcdoc$|^formaction$|^action$|^target$|^ping$|^data-/);
      expect(attr.value.toLowerCase(), `${el.tagName} ${attr.name}`).not.toMatch(/^\s*(javascript|vbscript):/);
    }
  }
  // Ids and names cannot shadow the app's own elements or globals.
  for (const el of Array.from(body.querySelectorAll("[id], [name]"))) {
    expect(el.getAttribute("id") ?? el.getAttribute("name")).toMatch(/^user-content-/);
  }
}

describe("hostile HTML", () => {
  const hostile = fixture("hostile.html");
  const result = extractArticle(hostile, "https://evil.example/post");

  it("still gives the article", () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(dom(result.article.html).textContent).toContain("The honest paragraph survives");
  });

  it("lets no script, frame, form, style, handler or plain-http picture through", () => {
    if (!result.ok) throw new Error("no article");
    const html = result.article.html;
    expectHarmless(html);
    const body = dom(html);
    for (const img of Array.from(body.querySelectorAll("img"))) {
      expect(img.getAttribute("src")).toMatch(/^https:\/\//);
      for (const candidate of (img.getAttribute("srcset") ?? "").split(",").filter(Boolean)) {
        expect(candidate.trim()).toMatch(/^https:\/\//);
      }
      expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    }
    for (const a of Array.from(body.querySelectorAll("a[href]"))) {
      expect(a.getAttribute("href")).toMatch(/^(https?:|mailto:|#user-content-)/);
    }
    expect(html).not.toMatch(/alert|evil\.example\/steal|http:\/\/tracker|data:/i);
  });

  it("the sanitizer alone is enough, whatever Defuddle lets through", () => {
    // The whole hostile page, straight into DOMPurify: the last step holds on its own.
    const html = sanitize(hostile);
    expectHarmless(html);
    expect(html).not.toMatch(/alert\(/);
    expect(dom(html).textContent).toContain("The honest paragraph survives");
  });
  it("keeps the https picture and the article's own links", () => {
    if (!result.ok) throw new Error("no article");
    const body = dom(result.article.html);
    expect(Array.from(body.querySelectorAll("img")).map((img) => img.getAttribute("src"))).toEqual(["https://cdn.example.org/diagram.png"]);
    expect(body.querySelector("a[href='#user-content-note-1']")).not.toBeNull();
    expect(body.querySelector("a[href='https://example.org/source']")?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(body.querySelector("a[href='https://other.example/page']")).not.toBeNull();
  });

  it("sanitize alone drops the dangerous parts of a fragment", () => {
    const clean = dom(
      sanitize(
        `<p onclick="x()" style="position:fixed">a</p><img src="https://a.example/x.png" onerror="x()"><a href="javascript:x()">b</a>` +
          `<math><mi xlink:href="javascript:x()">c</mi></math><svg><script>x()</script></svg><form action="https://a.example"><input></form>` +
          `<iframe srcdoc="<script>x()</script>"></iframe><div data-x="1" class="fixed inset-0">d</div>`,
      ),
    );
    expect(clean.innerHTML).toBe(`<p>a</p><img src="https://a.example/x.png"><a>b</a><div>d</div>`);
  });
});

describe("counting", () => {
  it("counts words in languages without spaces", () => {
    expect(countWords("Go is an open source programming language.", "en")).toBe(7);
    expect(countWords("Заглушка возвращает ответы.", "ru")).toBe(3);
    expect(countWords("日本語の記事を読む", "ja")).toBeGreaterThan(2);
  });

  it("measures how much of the text is links", () => {
    expect(linkDensity(dom(`<p>one two <a href="#">three four</a></p>`))).toBeCloseTo(9 / 15);
    expect(linkDensity(dom("<p></p>"))).toBe(0);
  });
});

describe("dek", () => {
  const body = (html: string) => new DOMParser().parseFromString(html, "text/html").body;
  const text = body("<p>Most secure elements are sold as black boxes. You trust the vendor, and nobody can check.</p><p>Second.</p>");
  it("keeps a description the text does not open with", () => {
    expect(dekOf("Why a secure element you can inspect matters, and what changes when the files are public.", text)).toBe(
      "Why a secure element you can inspect matters, and what changes when the files are public.",
    );
  });
  it("drops one that repeats the first paragraph, whole or cut short", () => {
    expect(dekOf("Most secure elements are sold as black boxes. You trust the vendor, and nobody can check.", text)).toBeNull();
    expect(dekOf("Most secure elements are sold as black boxes. You trust the…", text)).toBeNull();
    expect(dekOf("  most SECURE elements are sold as black   boxes — you trust the vendor  ", text)).toBeNull();
  });
  it("drops none or a stub", () => {
    expect(dekOf(undefined, text)).toBeNull();
    expect(dekOf("Blog", text)).toBeNull();
  });
});
