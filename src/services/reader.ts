// The article reading mode shows (NP-120, Р-69). Rust fetches the page under the
// metadata request's guard (`reader.rs`); here it is parsed with DOMParser, so the
// page's scripts never run and nothing it names is loaded, the article is taken out
// by Defuddle, and DOMPurify cleans it before anything reaches a live DOM.
//
// The article view (`components/reader/ArticleView.tsx`, NP-123) calls `cachedArticle`
// and shows `article.html`, or the failure card with «Open in browser».
import Defuddle from "defuddle";
import DOMPurify from "dompurify";
import { api } from "./api";

export interface Article {
  /** Where the page ended up, after redirects and a `<meta refresh>`. */
  url: string;
  title: string;
  /** The author as the page names them; none when it is only a date. */
  author: string | null;
  /** The site's own name, if it gives one. */
  site: string | null;
  published: string | null;
  /** BCP 47, as the page declares it. */
  language: string | null;
  /** Clean HTML: no scripts, frames, forms, styles or handlers; https pictures only. */
  html: string;
  words: number;
  /** Letters inside links over all letters, 0–1. A table of contents is mostly links. */
  linkDensity: number;
  /** The text shares a word with the title: a short extract that does not is a side block. */
  onTopic: boolean;
}

/** Why there is no article; the reader offers the browser instead. */
export type ReadFailure =
  /** A local or private address, directly or after a redirect: never requested. */
  | { reason: "refused" }
  | { reason: "timeout" }
  /** No connection, a TLS failure, too many redirects. */
  | { reason: "network" }
  /** The site answered 403, 404, 500…: often a page that refuses requests outside a browser. */
  | { reason: "status"; status: number }
  /** A PDF, a picture, JSON. */
  | { reason: "not_html"; contentType: string }
  /** Nothing came out: an app, a video, a page drawn by scripts. */
  | { reason: "empty" }
  | { reason: "too_short"; words: number }
  /** Mostly links: a table of contents or a link list, better in the browser. */
  | { reason: "links"; words: number; linkDensity: number }
  /** A short extract about something else: a side block, the article is drawn by scripts. */
  | { reason: "off_topic"; words: number };

export type ReadResult = { ok: true; article: Article } | { ok: false; failure: ReadFailure };

/** Fewer words than this is not an article. Short READMEs (revel: 69) still are. */
export const READER_MIN_WORDS = 50;
/** A page where more than this share of the text is links is a list, not an article. */
export const READER_MAX_LINK_DENSITY = 0.5;

/** Fetches `url` and extracts its article. Called when the person opens it. */
export async function readArticle(url: string): Promise<ReadResult> {
  const page = await api.fetchReaderPage(url);
  switch (page.kind) {
    case "page":
      return extractArticle(page.html, page.url);
    case "status":
      return { ok: false, failure: { reason: "status", status: page.status } };
    case "not_html":
      return { ok: false, failure: { reason: "not_html", contentType: page.content_type } };
    case "refused":
      return { ok: false, failure: { reason: "refused" } };
    case "timeout":
      return { ok: false, failure: { reason: "timeout" } };
    case "failed":
      return { ok: false, failure: { reason: "network" } };
  }
}

/** Articles read in this session, by address: going back with ↑ shows one at once. */
const articles = new Map<string, Promise<ReadResult>>();
const KEPT_ARTICLES = 20;

/**
 * `readArticle`, once per address while the app runs. A timeout, a lost
 * connection or a thrown error is not kept: the next open asks again.
 */
export function cachedArticle(url: string): Promise<ReadResult> {
  const known = articles.get(url);
  if (known) return known;
  const forget = () => articles.get(url) === result && articles.delete(url);
  const result = readArticle(url).then(
    (read) => {
      if (!read.ok && (read.failure.reason === "timeout" || read.failure.reason === "network")) forget();
      else if (read.ok && articles.get(url) === result) words.set(url, read.article.words);
      return read;
    },
    (error: unknown) => {
      forget();
      throw error;
    },
  );
  articles.set(url, result);
  // The oldest goes first: a Map keeps the order of insertion.
  if (articles.size > KEPT_ARTICLES) articles.delete(articles.keys().next().value!);
  return result;
}

/** Words of the articles read in this session, kept longer than the articles: a number per address. */
const words = new Map<string, number>();

/**
 * Minutes of an article already read in this session; `null` before that. The
 * reading mode's queue shows them without asking any site for its page.
 */
export const knownMinutes = (url: string) => {
  const count = words.get(url);
  return count === undefined ? null : readingMinutes(count);
};

/** Minutes to read at 230 words a minute, at least one. */
export const readingMinutes = (words: number) => Math.max(1, Math.round(words / 230));

/** The article of a fetched page, or why there is none. `url` is the page's final address. */
export function extractArticle(html: string, url: string): ReadResult {
  const article = articleOf(html, url);
  if (!article) return { ok: false, failure: { reason: "empty" } };
  const failure = verdict(article);
  return failure ? { ok: false, failure } : { ok: true, article };
}

/** Below this many words an extract must share a word with the title to count. */
export const READER_SHORT_WORDS = 200;

/** The rule that decides whether an extracted article is shown (tuned on the 50-link sample). */
export function verdict({ words, linkDensity, onTopic = true }: Pick<Article, "words" | "linkDensity"> & { onTopic?: boolean }): ReadFailure | null {
  if (words === 0) return { reason: "empty" };
  if (words < READER_MIN_WORDS) return { reason: "too_short", words };
  if (linkDensity > READER_MAX_LINK_DENSITY) return { reason: "links", words, linkDensity };
  // A short extract about something else is a side block, not the article (DigitalOcean's
  // tutorial lives in script data; Defuddle finds only the «Become a contributor» cards).
  if (words < READER_SHORT_WORDS && !onTopic) return { reason: "off_topic", words };
  return null;
}

/** Whether the text names something from the title: a word of four letters or more,
 *  compared by its first five so that «персистентность» meets «персистентности». */
export function sharesTitle(title: string, text: string): boolean {
  const stems = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).map((word) => word.slice(0, 5)));
  const inText = stems(text);
  return [...stems(title)].some((stem) => inText.has(stem));
}

/** Defuddle and DOMPurify, without the rule: what the sample run measures. */
export function articleOf(html: string, url: string): Article | null {
  const parser = new DOMParser();
  // Inert: a DOMParser document runs no scripts and loads no pictures or styles.
  const page = parser.parseFromString(html, "text/html");
  promoteLazyImages(page);
  let result;
  try {
    result = new Defuddle(page, {
      url,
      // Only what the page holds: Defuddle's extractors may otherwise ask YouTube or
      // Reddit for more, and the reader sends no request the person did not make.
      useAsync: false,
      fetch: refuseFetch,
    }).parse();
  } catch {
    return null;
  }
  if (!result.content?.trim()) return null;

  // The extract is prepared in another inert document, then cleaned last.
  const extract = parser.parseFromString(result.content, "text/html");
  prepareLinks(extract, url);
  preparePictures(extract);
  const clean = sanitize(extract.body.innerHTML);

  const counted = parser.parseFromString(clean, "text/html").body;
  const language = result.language || page.documentElement.getAttribute("lang") || null;
  const title = result.title?.trim() || page.title.trim() || url;
  return {
    url,
    title,
    author: authorOf(result.author),
    site: result.site?.trim() || null,
    published: result.published?.trim() || null,
    language,
    html: clean,
    words: countWords(counted.textContent ?? "", language),
    linkDensity: linkDensity(counted),
    onTopic: sharesTitle(title, counted.textContent ?? ""),
  };
}

const refuseFetch: typeof globalThis.fetch = () => Promise.reject(new Error("The reader makes no requests of its own"));

/** Pictures that load when scrolled to keep the address in `data-src`; DOMParser runs no script to move it. */
function promoteLazyImages(doc: Document) {
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    if (src && !src.startsWith("data:")) continue;
    const lazy = ["data-src", "data-lazy-src", "data-original", "data-url"].map((name) => img.getAttribute(name)).find(Boolean);
    const lazySet = img.getAttribute("data-srcset") ?? img.getAttribute("data-lazy-srcset");
    if (lazy) img.setAttribute("src", lazy);
    if (lazySet && !img.getAttribute("srcset")) img.setAttribute("srcset", lazySet);
  }
}

/** Links point at absolute web addresses and open in the browser; links within the article stay. */
function prepareLinks(doc: Document, base: string) {
  for (const a of Array.from(doc.querySelectorAll("a"))) {
    const raw = a.getAttribute("href")?.trim();
    for (const name of ["target", "ping", "download", "referrerpolicy"]) a.removeAttribute(name);
    if (!raw) {
      a.removeAttribute("href");
      continue;
    }
    if (raw.startsWith("#")) {
      // DOMPurify renames ids to `user-content-…` so a page cannot clobber the app's own.
      a.setAttribute("href", `#user-content-${raw.slice(1)}`);
      continue;
    }
    let href: URL;
    try {
      href = new URL(raw, base);
    } catch {
      a.removeAttribute("href");
      continue;
    }
    if (href.protocol === "http:" || href.protocol === "https:" || href.protocol === "mailto:") {
      a.setAttribute("href", href.href);
      a.setAttribute("rel", "noopener noreferrer");
    } else {
      a.removeAttribute("href");
    }
  }
}

/** Pictures keep https addresses only; one without any is dropped. */
function preparePictures(doc: Document) {
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const set = (img.getAttribute("srcset") ?? "")
      .split(/,\s+/)
      .map((candidate) => candidate.trim())
      .filter((candidate) => https(candidate.split(/\s+/)[0]));
    const src = img.getAttribute("src")?.trim() ?? "";
    const fallback = set.length ? set[set.length - 1].split(/\s+/)[0] : null;
    const chosen = https(src) ? src : fallback;
    if (!chosen) {
      // A picture alone in a figure leaves an empty frame behind.
      const figure = img.closest("figure");
      if (figure && figure.querySelectorAll("img").length === 1) figure.remove();
      else img.remove();
      continue;
    }
    img.setAttribute("src", chosen);
    if (set.length) img.setAttribute("srcset", set.join(", "));
    else img.removeAttribute("srcset");
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
    // The site learns a picture was loaded, not from where.
    img.setAttribute("referrerpolicy", "no-referrer");
  }
  // `<picture>` keeps its `<img>`; its `<source>` elements are removed by the sanitizer.
  for (const picture of Array.from(doc.querySelectorAll("picture"))) {
    const img = picture.querySelector("img");
    if (img) picture.replaceWith(img);
    else picture.remove();
  }
}

function https(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

const FORBID_TAGS = [
  "script", "noscript", "style", "link", "meta", "base", "template",
  "iframe", "frame", "frameset", "object", "embed", "applet", "portal",
  "form", "input", "button", "select", "option", "optgroup", "textarea", "datalist", "output", "fieldset", "label",
  "video", "audio", "source", "track", "canvas", "dialog", "slot", "svg", "math",
];

/** The last step before the article may reach a document. */
export function sanitize(html: string): string {
  const purify = DOMPurify(window);
  return purify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS,
    FORBID_ATTR: ["style", "class", "srcdoc", "action", "formaction", "background", "poster", "target", "ping"],
    ADD_ATTR: ["referrerpolicy", "loading", "decoding"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    // Ids and names of the page cannot shadow the app's own globals or elements.
    SANITIZE_NAMED_PROPS: true,
    // DOMPurify's own pattern with fewer schemes: http(s) and mailto, or a value with no
    // scheme at all (`#note`, and the plain attributes this pattern also applies to).
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
}

/** Words as the language splits them: Chinese and Japanese have no spaces. */
export function countWords(text: string, language: string | null): number {
  const segmenter = new Intl.Segmenter(language ?? undefined, { granularity: "word" });
  let words = 0;
  for (const segment of segmenter.segment(text)) if (segment.isWordLike) words++;
  return words;
}

/** Letters inside links over all letters, spaces left out. */
export function linkDensity(root: Element): number {
  const letters = (node: Node) => (node.textContent ?? "").replace(/\s+/g, "").length;
  const total = letters(root);
  if (!total) return 0;
  // The HTML parser never nests links, so none is counted twice.
  const linked = Array.from(root.querySelectorAll("a")).reduce((sum, a) => sum + letters(a), 0);
  return Math.min(1, linked / total);
}

/** Blogger and others put the date where the author goes. */
function authorOf(raw: string | undefined): string | null {
  const author = raw?.trim();
  if (!author) return null;
  // Names have no digits; «March 5, 2012», «2012-03-05» and «05.03.2012» do.
  if (/\d/.test(author) && !Number.isNaN(Date.parse(author.replace(/(\d+)\.(\d+)\.(\d{4})/, "$3-$2-$1")))) return null;
  return author;
}
