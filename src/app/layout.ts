import { useEffect, useState } from "react";

/** Below this width the sidebar becomes a strip of icons (frame 16). */
export const NARROW = "(max-width: 999px)";
/** From this width the editor docks on the right instead of covering the content. */
export const WIDE = "(min-width: 1150px)";

/** Whether the media query matches now, following it live. */
export function useMedia(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}
