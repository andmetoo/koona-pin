import { convertFileSrc } from "@tauri-apps/api/core";
import { isTauri } from "./api";
import { pictureUrl } from "./feedsView";

/**
 * The pictures the app keeps a local copy of (NP-146): a bookmark's preview and
 * icon, a feed post's thumbnail, a feed's icon.
 */
export type PictureKind = "bookmark-image" | "bookmark-icon" | "post-thumb" | "feed-icon";

const PATHS: Record<PictureKind, (id: number | string) => string> = {
  "bookmark-image": (id) => `b/${id}/image`,
  "bookmark-icon": (id) => `b/${id}/icon`,
  "post-thumb": (id) => `p/${id}/thumb`,
  "feed-icon": (id) => `f/${id}/icon`,
};

/** Feed pictures pass the same filter as before the cache: https (plain http upgraded) and inline pictures only. */
const FEED_KINDS: ReadonlySet<PictureKind> = new Set(["post-thumb", "feed-icon"]);

/** The address a picture of this kind is shown from, before the cache: null when there is none. */
export function pictureSource(kind: PictureKind, sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl) return null;
  return FEED_KINDS.has(kind) ? pictureUrl(sourceUrl) : sourceUrl;
}

/**
 * FNV-1a, 32 bits, over the UTF-8 bytes of `text`, as 8 lowercase hex digits.
 * The `?v=` of a cached picture: a new source address is a new address for the
 * WebView, so its memory cache cannot show the old picture. The backend ignores it.
 */
export function hash8(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** An id the backend can look the source address up by: a saved bookmark or post, a feed's uid. */
const known = (id: number | string) => (typeof id === "number" ? Number.isInteger(id) && id > 0 : id !== "");

/**
 * The local copy alone, `kpimg://localhost/b%2F12%2Ficon`, for a saved bookmark or a followed feed
 * whose source address the caller does not hold (the list preview, K10). The backend fetches only
 * an address the library already has; nothing falls back to the web. Null in the browser demo.
 */
export function localPictureSrc(kind: PictureKind, id: number | string): string | null {
  if (!isTauri() || !known(id)) return null;
  return convertFileSrc(PATHS[kind](id), "kpimg");
}

/**
 * Where to load a picture from (NP-146): the local copy through the `kpimg`
 * scheme, `kpimg://localhost/b%2F12%2Fimage?v=…` (`http://kpimg.localhost/…` on
 * Windows). The backend reads the source address from the library by the id,
 * serves its copy or fetches one, and answers 404 when it cannot.
 *
 * The source address itself when there is no copy to ask for: in the browser
 * demo, for a link not saved yet (a draft has no id), and for an inline `data:`
 * picture. Null when there is no picture at all.
 */
export function pictureSrc(kind: PictureKind, id: number | string, sourceUrl: string | null | undefined): string | null {
  const source = pictureSource(kind, sourceUrl);
  if (!source) return null;
  if (!isTauri() || !known(id) || source.startsWith("data:")) return source;
  return `${convertFileSrc(PATHS[kind](id), "kpimg")}?v=${hash8(source)}`;
}
