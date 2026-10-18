import type { CSSProperties } from "react";
import { Preview } from "../../../components/library/Bookmarks";
import type { Bookmark } from "../../../types";
import "./editing.css";

/**
 * A link's picture as the editing sheets show it (B1's site row, N1's preview): the page's
 * picture or the site's cover, `size` square, r 14 (doc/mobile-design.md, Radii). The app's own
 * picture hook (local copy first) behind it, through the shared `Preview`.
 */
export function LinkThumb({ bookmark, size }: { bookmark: Bookmark; size: number }) {
  return (
    <span className="ed-thumb" style={{ "--ed-thumb": `${size}px` } as CSSProperties} aria-hidden="true">
      <Preview b={bookmark} small />
    </span>
  );
}
