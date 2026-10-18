import { useState } from "react";
import { pictureSource, pictureSrc, type PictureKind } from "../services/pictures";

export type Picture = {
  /** The address to show now; null when there is no picture or every address failed. */
  src: string | null;
  /** For the `<img>`'s `onError`: moves on to the next address. */
  onError: () => void;
  /** There was a picture, and none of its addresses loaded: show the fallback. */
  failed: boolean;
};

/**
 * A picture with its fallback chain (NP-146): the local copy first, then, when
 * online, the source address once, as before the cache — a site may refuse the
 * backend and still serve the WebView; then nothing, and the component shows its
 * cover, monogram or letter. `webFirst` turns the order round while online, for
 * a picture wanted at full size (the feed article's lead): the web, then the copy.
 *
 * The state is kept with the addresses it was learnt for, not as a flag: a
 * cached failure arrives before any effect could reset one, and a new source
 * address starts the chain again.
 */
export function usePicture(kind: PictureKind, id: number | string, sourceUrl: string | null | undefined, { webFirst = false } = {}): Picture {
  const source = pictureSource(kind, sourceUrl);
  const cached = pictureSrc(kind, id, sourceUrl);
  const online = typeof navigator === "undefined" || navigator.onLine;
  const chain = !source || !cached ? [] : cached === source ? [source] : webFirst && online ? [source, cached] : [cached, source];
  const key = chain.join(" ");
  const [state, setState] = useState<{ key: string; index: number }>({ key, index: 0 });
  const index = state.key === key ? state.index : 0;
  const onError = () => {
    let next = index + 1;
    // Offline the source address cannot load: straight to the fallback.
    while (next < chain.length && chain[next] === source && !navigator.onLine) next++;
    setState({ key, index: next });
  };
  return { src: chain[index] ?? null, onError, failed: chain.length > 0 && index >= chain.length };
}
