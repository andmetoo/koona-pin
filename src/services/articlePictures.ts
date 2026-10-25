// The pictures of an article, for reading mode (`reader.ts`) and a feed post
// (`feedsView.ts`) alike. A page parsed by DOMParser runs no script, so what a
// site's lazy loader would have done is done here: the real address moves into
// `src`, a `<noscript>` copy replaces its placeholder, a `<picture>`'s sources
// reach its `<img>`. Then every address is made absolute and https: a plain-http
// picture is asked for over https (most hosts answer both), never in the clear.

/** Where lazy loaders keep the real address, the likeliest first. */
const LAZY_SRC = [
  "data-src",
  "data-lazy-src",
  "data-original",
  "data-original-src",
  "data-lazy",
  "data-hi-res-src",
  "data-full-url",
  "data-actualsrc",
  "data-echo",
  "data-orig-file",
  "data-url",
];
const LAZY_SRCSET = ["data-srcset", "data-lazy-srcset", "data-original-srcset"];

/** A value that names a picture, not a flag or a number. */
const ADDRESS = /^(?:https?:)?\/\/|^\.{0,2}\/|\.(?:jpe?g|png|gif|webp|avif)(?:[?#]|$)/i;
/** A `src` a lazy loader puts first: empty, inline, or a blank, spacer or loading picture. */
const PLACEHOLDER = /^(?:data:|about:)|(?:placeholder|blank|spacer|transparent|lazy|loading|pixel)[\w-]*\.(?:gif|png|svg|jpe?g|webp)/i;

const placeholder = (img: Element) => {
  const src = img.getAttribute("src")?.trim() ?? "";
  return !src || PLACEHOLDER.test(src);
};

/** One candidate of a `srcset`: its address and its `2x` or `800w`, if any. */
export interface SrcsetCandidate {
  url: string;
  descriptor: string;
}

/**
 * A `srcset` as the HTML standard reads it: an address runs to the next
 * whitespace, so Cloudinary's `w_600,h_400` stays whole, and a comma right
 * after it ends the candidate even with no space (`a.jpg 1x,b.jpg 2x`).
 */
export function parseSrcset(raw: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /[\s,]/.test(raw[i])) i++;
    let start = i;
    while (i < raw.length && !/\s/.test(raw[i])) i++;
    let url = raw.slice(start, i);
    let descriptor = "";
    if (url.endsWith(",")) url = url.replace(/,+$/, "");
    else {
      start = i;
      while (i < raw.length && raw[i] !== ",") i++;
      descriptor = raw.slice(start, i).trim();
    }
    if (url) candidates.push({ url, descriptor });
  }
  return candidates;
}

/** An https address for a picture, resolved against `base`; plain http is upgraded, anything else is none. */
export function pictureAddress(raw: string | null | undefined, base?: string): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === "http:") url.protocol = "https:";
  return url.protocol === "https:" ? url.href : null;
}

/**
 * What the page's scripts would have done for its pictures; on the whole page,
 * before Defuddle picks the article, which may drop `data-*` and `<noscript>`.
 */
export function restorePictures(doc: Document) {
  // `<img class="lazy" src="blank.gif"><noscript><img src="real.jpg"></noscript>`.
  for (const noscript of Array.from(doc.querySelectorAll("noscript"))) {
    const copy = noscript.querySelector("img");
    const shown = noscript.previousElementSibling;
    if (copy && shown?.tagName === "IMG" && placeholder(shown) && !LAZY_SRC.some((name) => shown.hasAttribute(name))) {
      shown.replaceWith(copy);
      noscript.remove();
    }
  }
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const lazy = LAZY_SRC.map((name) => img.getAttribute(name)?.trim()).find((value) => value && ADDRESS.test(value));
    const lazySet = LAZY_SRCSET.map((name) => img.getAttribute(name)?.trim()).find(Boolean);
    // The loader's address wins: the `src` beside it is its placeholder.
    if (lazy) img.setAttribute("src", lazy);
    if (lazySet) img.setAttribute("srcset", lazySet);
    else if (lazy && placeholder(img)) img.removeAttribute("srcset");
  }
  // A `<picture>` often names the picture only in its `<source>`s.
  for (const picture of Array.from(doc.querySelectorAll("picture"))) {
    const img = picture.querySelector("img");
    if (!img || (img.getAttribute("srcset") && !placeholder(img))) continue;
    const sources = Array.from(picture.querySelectorAll("source"));
    const source = sources.find((s) => !s.getAttribute("media")) ?? sources[sources.length - 1];
    const set = source && (source.getAttribute("srcset") ?? LAZY_SRCSET.map((name) => source.getAttribute(name)).find(Boolean));
    if (!set) continue;
    img.setAttribute("srcset", set);
    if (placeholder(img)) {
      const candidates = parseSrcset(set);
      if (candidates.length) img.setAttribute("src", candidates[candidates.length - 1].url);
    }
  }
  // WordPress and others draw emoji as pictures; the letter is in `alt`.
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const alt = img.getAttribute("alt")?.trim() ?? "";
    const emoji = /emoji|smiley/i.test(`${img.getAttribute("class") ?? ""} ${img.getAttribute("src") ?? ""}`);
    if (emoji && alt && [...alt].length <= 8 && /\p{Extended_Pictographic}/u.test(alt)) img.replaceWith(doc.createTextNode(alt));
  }
}

/**
 * A picture's name without its size, format or host: `photo-640x349.jpg?w=1024`,
 * `photo.webp` and Cloudinary's `fetch/w_400/https://…/photo.jpg` are one picture.
 */
function pictureKey(raw: string, base?: string): string | null {
  try {
    const url = new URL(raw, base);
    // An image service's `?href=` or `?url=` names the picture.
    const inner = url.searchParams.get("href") ?? url.searchParams.get("url");
    const path = inner && /^https?:/.test(inner) ? new URL(inner).pathname : url.pathname;
    const file = decodeURIComponent(path.split("/").pop() ?? "").toLowerCase();
    return file.replace(/\.\w+$/, "").replace(/(-\d+x\d+|@\dx|-scaled)$/, "") || null;
  } catch {
    return null;
  }
}

/** One name is the other, or ends with it (`l-intro-1792` and `intro-1792`). */
const samePicture = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 8 && (a.endsWith(b) || b.endsWith(a)));

/** The text opens with a picture before any words. */
function opensWithPicture(doc: Document): boolean {
  // NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT: the first picture or words, in reading order.
  const walker = doc.createTreeWalker(doc.body, 0x1 | 0x4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 3) {
      if ((node.textContent ?? "").trim()) return false;
    } else if ((node as Element).tagName === "IMG") return true;
  }
  return false;
}

/**
 * The page's lead picture (`og:image`) over the text, as a reader shows it: news
 * sites keep it in the page's header, outside what Defuddle takes. Not when the
 * text already opens with a picture or holds this one at any size, nor for a logo
 * or a share card drawn from the title (Habr's `/share/publication/…`).
 */
export function addLeadPicture(doc: Document, image: string | null | undefined, base: string, alt = "") {
  const address = pictureAddress(image, base);
  const key = address && pictureKey(address);
  if (!address || !key || /logo|favicon|default|placeholder/i.test(key) || /\/share\//i.test(address) || opensWithPicture(doc)) return;
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const shown = [img.getAttribute("src") ?? "", ...parseSrcset(img.getAttribute("srcset") ?? "").map((c) => c.url)];
    if (shown.some((raw) => {
      const other = raw && pictureKey(raw, base);
      return other && samePicture(key, other);
    })) return;
  }
  const figure = doc.createElement("figure");
  const img = doc.createElement("img");
  img.setAttribute("src", address);
  img.setAttribute("alt", alt);
  figure.append(img);
  doc.body.prepend(figure);
}

const pixel = (img: Element) => ["width", "height"].some((name) => /^\s*[01](?:px)?\s*$/.test(img.getAttribute(name) ?? ""));

/**
 * The pictures of an extract, last before the sanitizer: https addresses
 * resolved against `base`, the srcset kept to those, lazy and async loading, no
 * referrer. A picture with no address left, or a 1 × 1 counter, is dropped; a
 * figure it leaves empty goes with it.
 */
export function preparePictures(doc: Document, base?: string) {
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const set = parseSrcset(img.getAttribute("srcset") ?? "")
      .map(({ url, descriptor }) => ({ url: pictureAddress(url, base), descriptor }))
      .filter((candidate): candidate is SrcsetCandidate => candidate.url !== null);
    const chosen = pictureAddress(img.getAttribute("src"), base) ?? set[set.length - 1]?.url ?? null;
    if (!chosen || pixel(img)) {
      const figure = img.closest("figure");
      if (figure && figure.querySelectorAll("img").length === 1) figure.remove();
      else img.remove();
      continue;
    }
    img.setAttribute("src", chosen);
    if (set.length) img.setAttribute("srcset", set.map(({ url, descriptor }) => (descriptor ? `${url} ${descriptor}` : url)).join(", "));
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

/** Up to this size, in CSS pixels, a picture stays in the line: a badge, an icon, a formula. */
const INLINE_HEIGHT = 40;
const INLINE_WIDTH = 240;

/**
 * Pictures of the article on screen, as they load: one that fails, even over the
 * upgraded https, is hidden with the figure it was alone in rather than shown
 * broken; a 1 × 1 one is hidden too; a small one stays in its line. Returns the
 * cleanup for an effect.
 */
export function watchPictures(body: HTMLElement): () => void {
  const hide = (img: HTMLImageElement) => {
    const figure = img.closest("figure");
    if (figure && body.contains(figure) && figure.querySelectorAll("img").length === 1) figure.hidden = true;
    else img.hidden = true;
  };
  const settle = (img: HTMLImageElement) => {
    if (!img.naturalWidth || !img.naturalHeight || (img.naturalWidth <= 1 && img.naturalHeight <= 1)) hide(img);
    else if (img.naturalHeight <= INLINE_HEIGHT && img.naturalWidth <= INLINE_WIDTH) img.dataset.inline = "";
  };
  const onLoad = (e: Event) => e.target instanceof HTMLImageElement && settle(e.target);
  const onError = (e: Event) => e.target instanceof HTMLImageElement && hide(e.target);
  // `load` and `error` do not bubble: they are caught on the way down.
  body.addEventListener("load", onLoad, true);
  body.addEventListener("error", onError, true);
  // Those the memory cache gave before the listeners were there.
  for (const img of Array.from(body.querySelectorAll("img"))) if (img.complete && img.getAttribute("src")) settle(img);
  return () => {
    body.removeEventListener("load", onLoad, true);
    body.removeEventListener("error", onError, true);
  };
}
