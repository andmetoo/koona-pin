import { SyntheticEvent, useState, useSyncExternalStore } from "react";
import { pictureSource, pictureSrc, type PictureKind } from "../services/pictures";

export type Picture = {
  /** The address to show now; null when there is no picture or every address failed. */
  src: string | null;
  /** For the `<img>`'s `onError`: moves on to the next address. */
  onError: () => void;
  /** For the `<img>`'s `onLoad`: a refused copy (see below) goes straight to the fallback. */
  onLoad: (e: SyntheticEvent<HTMLImageElement>) => void;
  /** There was a picture, and none of its addresses loaded: show the fallback. */
  failed: boolean;
};

// Bumped when the network comes back, so every failed picture tries again.
// One listener for all of them, added with the first picture on screen.
let generation = 0;
const listeners = new Set<() => void>();
const bump = () => {
  generation++;
  listeners.forEach((listener) => listener());
};
function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener("online", bump);  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("online", bump);
  };
}
const currentGeneration = () => generation;

/**
 * A picture with its fallback chain (NP-146): the local copy first, then the
 * source address once, as before the cache — a site may refuse the backend and
 * still serve the WebView, and offline the WebView may still hold it in its own
 * cache; then nothing, and the component shows its cover, monogram or letter.
 * `webFirst` turns the order round while online, for a picture wanted at full
 * size (the feed article's lead): the web, then the copy.
 *
 * The backend answers an address it refuses to fetch (a private network) with
 * a 1×1 transparent picture: that copy loads, and the chain ends there without
 * trying the address in the WebView either.
 *
 * The state is kept with the addresses it was learnt for, not as a flag: a
 * cached failure arrives before any effect could reset one, and a new source
 * address starts the chain again. So does the network coming back.
 */
export function usePicture(kind: PictureKind, id: number | string, sourceUrl: string | null | undefined, { webFirst = false } = {}): Picture {
  const round = useSyncExternalStore(subscribe, currentGeneration, currentGeneration);
  const source = pictureSource(kind, sourceUrl);
  const cached = pictureSrc(kind, id, sourceUrl);
  const online = typeof navigator === "undefined" || navigator.onLine;
  const chain = !source || !cached ? [] : cached === source ? [source] : webFirst && online ? [source, cached] : [cached, source];
  const key = `${round} ${chain.join(" ")}`;
  const [state, setState] = useState<{ key: string; index: number }>({ key, index: 0 });
  const index = state.key === key ? state.index : 0;
  const src = chain[index] ?? null;
  const onError = () => setState({ key, index: index + 1 });
  const onLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    // 1×1 exactly, not ≤ 1: an SVG icon without a size of its own can report 0.
    const { naturalWidth, naturalHeight } = e.currentTarget;
    if (src === cached && cached !== source && naturalWidth === 1 && naturalHeight === 1) setState({ key, index: chain.length });
  };
  return { src, onError, onLoad, failed: chain.length > 0 && index >= chain.length };
}
