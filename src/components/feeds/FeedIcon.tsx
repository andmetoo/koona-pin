import type { Feed } from "../../types";
import { feedName } from "../../services/feeds";
import { feedInitial, feedSite, feedTint } from "../../services/feedsView";
import { usePicture } from "../../hooks/usePicture";

/**
 * A feed's icon (NP-132): its favicon — the local copy first, then the site's
 * address (NP-146) — else a letter tile in a colour of the palette derived from
 * the domain. 16 px rounded square in the sidebar, round 34 px in the list,
 * 20 px in the article's chip.
 */
export function FeedIcon({ feed, size, round = false }: { feed: Pick<Feed, "uid" | "title" | "feed_title" | "url" | "site_url" | "icon_url">; size: number; round?: boolean }) {
  const icon = usePicture("feed-icon", feed.uid, feed.icon_url);
  const shape = round ? "rounded-full" : "rounded-[4.5px]";
  if (icon.src)
    return (
      <img
        src={icon.src}
        alt=""
        referrerPolicy="no-referrer"
        onError={icon.onError}
        className={`shrink-0 bg-card object-cover ${shape}`}
        style={{ width: size, height: size }}
      />
    );
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center font-bold text-on-ink-btn ${shape}`}
      style={{ width: size, height: size, background: feedTint(feedSite(feed)), fontSize: size >= 30 ? 13 : size >= 20 ? 10 : 9, lineHeight: 1 }}
    >
      {feedInitial(feedName(feed))}
    </span>
  );
}
