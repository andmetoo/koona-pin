import { type CSSProperties, memo, type ReactNode, useEffect, useMemo, useState } from "react";
import { Heart } from "lucide-react";
import { usePicture } from "../../../hooks/usePicture";
import { coverOf, monogram, pendingFor } from "../../../services/cover";
import type { Bookmark, FeedItem } from "../../../types";
import { useLongPress } from "../ui/useLongPress";
import { shortAge } from "./age";

/**
 * The phone's bookmark row and grid card (doc/mobile-design.md, Cards and lists): opaque paper,
 * one picture, at most two small glyphs (the collection's dot and a heart), no hover, no tooltip;
 * a tap opens it, a long press its menu sheet. Both are memoized: a list redraws only what changed.
 */

/** The page's picture through the app's picture chain (NP-146), else the site's colours and letter. */
export function Thumb({ b, className = "" }: { b: Bookmark; className?: string }) {
  const picture = usePicture("bookmark-image", b.id, b.image_url);
  // A link just saved waits for its metadata: a shimmer, not the cover, until it comes or times out.
  const [, recheck] = useState(0);
  const pending = picture.src ? 0 : pendingFor(b);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => recheck((n) => n + 1), pending);
    return () => window.clearTimeout(timer);
  }, [pending > 0, b.id]);
  return (
    <span className={`lib-thumb ${className}`} data-preview>
      {picture.src ? (
        <img key={picture.src} src={picture.src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={picture.onError} onLoad={picture.onLoad} />
      ) : pending ? (
        <span className="cover-pending" />
      ) : (
        <Cover domain={b.domain} url={b.url} title={b.title} />
      )}
    </span>
  );
}

/** No picture: the site's gradient (services/cover.ts, as on the desktop) and its letter. */
function Cover({ domain, url, title }: { domain: string; url: string; title: string }) {
  const cover = useMemo(() => coverOf(domain, url), [domain, url]);
  return (
    <span className="lib-cover" style={{ "--from": cover.from, "--to": cover.to } as CSSProperties} aria-hidden="true">
      {monogram(domain, title)}
    </span>
  );
}

/** Domain · age, after the collection's dot, with a small filled heart for a favourite. */
function Meta({ b, dot, language, favorite }: { b: Bookmark; dot: string | null; language: string; favorite: string }) {
  const age = shortAge(b.created_at, language);
  return (
    <span className="lib-meta ph-meta">
      {dot && <span className="ph-chip-dot" style={{ "--dot": dot } as CSSProperties} aria-hidden="true" />}
      <span className="lib-meta-text">
        {b.domain}
        {age && ` · ${age}`}
      </span>
      {b.is_favorite && (
        <>
          <Heart className="lib-heart" size={12} strokeWidth={1.2} fill="currentColor" aria-hidden="true" />
          <span className="sr-only">{favorite}</span>
        </>
      )}
    </span>
  );
}

type TileProps = {
  bookmark: Bookmark;
  /** Its collection's colour, when it is in one. */
  dot: string | null;
  language: string;
  onOpen: (b: Bookmark) => void;
  onMenu: (b: Bookmark) => void;
};

/** L1's row: title 2 lines, the meta line, a 64 picture r 14 on the right. */
export const BookmarkRow = memo(function BookmarkRow({
  bookmark: b,
  dot,
  language,
  onOpen,
  onMenu,
  favorite,
  first,
  last,
}: TileProps & { favorite: string; first: boolean; last: boolean }) {
  const press = useLongPress(() => onMenu(b));
  return (
    <button
      type="button"
      className="lib-row"
      data-bookmark-id={b.id}
      data-first={first || undefined}
      data-last={last || undefined}
      onClick={() => onOpen(b)}
      {...press}
    >
      <span className="lib-row-text">
        <span className="ph-row lib-clamp-2">{b.title || b.url}</span>
        <Meta b={b} dot={dot} language={language} favorite={favorite} />
      </span>
      <Thumb b={b} />
    </button>
  );
});

/** L2's card: paper r 22, the picture inset 4 r 18, the title up to 3 lines, the meta line. */
export const BookmarkCard = memo(function BookmarkCard({ bookmark: b, dot, language, onOpen, onMenu, favorite }: TileProps & { favorite: string }) {
  const press = useLongPress(() => onMenu(b));
  return (
    <button type="button" className="lib-card" data-bookmark-id={b.id} onClick={() => onOpen(b)} {...press}>
      <Thumb b={b} className="lib-card-picture" />
      <span className="lib-card-title lib-clamp-3 ph-row">{b.title || b.url}</span>
      <Meta b={b} dot={dot} language={language} favorite={favorite} />
    </button>
  );
});

/** A feed's post among search results: the same row, the feed's name in place of the domain. */
export const PostRow = memo(function PostRow({
  post,
  source,
  language,
  onOpen,
  first,
  last,
}: {
  post: FeedItem;
  source: string;
  language: string;
  onOpen: (post: FeedItem) => void;
  first: boolean;
  last: boolean;
}) {
  const picture = usePicture("post-thumb", post.id, post.thumbnail_url);
  const age = shortAge(post.published_at ?? post.fetched_at, language);
  const domain = useMemo(() => hostOf(post.url), [post.url]);
  let thumb: ReactNode;
  if (picture.src)
    thumb = <img key={picture.src} src={picture.src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={picture.onError} onLoad={picture.onLoad} />;
  else thumb = <Cover domain={domain || source} url={post.url ?? source} title={post.title} />;
  return (
    <button
      type="button"
      className="lib-row"
      data-post-id={post.id}
      data-first={first || undefined}
      data-last={last || undefined}
      onClick={() => onOpen(post)}
    >
      <span className="lib-row-text">
        <span className="ph-row lib-clamp-2">{post.title}</span>
        <span className="lib-meta ph-meta">
          <span className="lib-meta-text">
            {source}
            {age && ` · ${age}`}
          </span>
        </span>
      </span>
      <span className="lib-thumb" data-preview>
        {thumb}
      </span>
    </button>
  );
});

function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
