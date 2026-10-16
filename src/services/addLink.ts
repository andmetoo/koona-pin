// Adding a link by hand (2026-10-16): the sheet's field, ⌘V in the library and a link dropped on the window.
import { Bookmark, PageMetadata } from "../types";

/** Where a link saved by hand goes: sorted into the library, waiting in the inbox, or sorted and in Reading. */
export type Destination = "library" | "inbox" | "reading";

/** An address with a scheme of its own: `mailto:`, `ftp://`, `https://`. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * What the field means: the text as typed, with `https://` in front of a bare
 * address such as `example.com/page`. Anything else is left for the save to judge.
 */
export function typedLink(text: string): string {
  const value = text.trim();
  // `localhost:1420` reads like a scheme, but a port is digits.
  const scheme = SCHEME.test(value) && !/^[^/:]+:\d+([/?#]|$)/.test(value);
  if (!value || scheme || /\s/.test(value)) return value;
  // A host with a dot, or localhost, before an optional port and path.
  return /^(localhost|[^/?#.]+(\.[^/?#.]+)+)(:\d+)?([/?#]|$)/i.test(value) ? `https://${value}` : value;
}

/** The address as a web link, or null: only http(s) with a host. */
export function webLink(text: string): URL | null {
  try {
    const url = new URL(text.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? url : null;
  } catch {
    return null;
  }
}

/**
 * A pasted or dropped text that is one web link, and nothing else: a sentence
 * with a link in it is not saved by itself. `text/uri-list` may carry comments
 * (`#`) and several links; its first one is taken.
 */
export function linkFrom(text: string | null | undefined, uriList = false): string | null {
  if (!text) return null;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !(uriList && line.startsWith("#")));
  const first = uriList ? lines[0] : lines.length === 1 ? lines[0] : undefined;
  if (!first || /\s/.test(first)) return null;
  return webLink(first)?.href ?? null;
}

/** The domain as the library keeps it: the host without `www.`. */
export const domainOf = (url: URL) => url.hostname.replace(/^www\./, "");

/**
 * The same address for the purposes of «already saved», as strictly as the save
 * itself judges: only a trailing slash is forgiven. Variants (`www.`, a fragment,
 * tracking) are saved and left to «Duplicates».
 */
const sameKey = (raw: string) => (webLink(raw)?.href ?? raw.trim()).replace(/\/$/, "");
export const samePage = (a: string, b: string) => sameKey(a) === sameKey(b);

/**
 * A bookmark-shaped stand-in for a link not saved yet: the cover of the preview
 * is drawn from its domain alone. Nothing is fetched for it.
 */
export function draftBookmark(url: URL): Bookmark {
  const now = new Date(0).toISOString();
  return {
    id: -1,
    url: url.href,
    title: "",
    description: null,
    image_url: null,
    favicon_url: null,
    site_name: null,
    notes: null,
    domain: domainOf(url),
    collection_id: null,
    tags: [],
    is_favorite: false,
    reading_at: null,
    reading_progress: 0,
    read_at: null,
    offline_at: null,
    created_at: now,
    updated_at: now,
    revision: 1,
    triaged_at: now,
    deleted_at: null,
    source: "app",
  };
}

/**
 * The stand-in with what the page said of itself (NP-133): its real title, picture and
 * icon, from the sheet's one request to it, before anything is saved.
 */
export function previewedBookmark(url: URL, page: Pick<PageMetadata, "title" | "image_url" | "favicon_url" | "site_name">): Bookmark {
  return {
    ...draftBookmark(url),
    title: page.title?.trim() ?? "",
    image_url: page.image_url,
    favicon_url: page.favicon_url,
    site_name: page.site_name,
  };
}

/** Where ⌘V and a drop save without asking: the section the person is in, else the library. */
export function destinationOf(section: { onlyInbox?: boolean; onlyReading?: boolean }): Destination {
  return section.onlyInbox ? "inbox" : section.onlyReading ? "reading" : "library";
}

/** A drag that carries a link from outside: not files, not the app's own drag. */
export function carriesLink(types: readonly string[] | DOMStringList | null | undefined): boolean {
  if (!types) return false;
  const list = Array.from(types as ArrayLike<string>);
  if (list.includes("Files")) return false;
  return list.includes("text/uri-list") || list.includes("text/plain");
}
