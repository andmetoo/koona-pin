import { useState } from "react";
import type { Feed } from "../../types";
import { feedName } from "../../services/feeds";
import { feedInitial, feedSite, feedTint, pictureUrl } from "../../services/feedsView";
import { usePublicImage } from "../../services/imageGuard";

/**
 * A feed's icon (NP-132): its favicon, else a letter tile in a colour of the palette derived
 * from the domain. 16 px rounded square in the sidebar, round 34 px in the list, 20 px in the
 * article's chip.
 */
export function FeedIcon({ feed, size, round = false }: { feed: Pick<Feed, "title" | "feed_title" | "url" | "site_url" | "icon_url">; size: number; round?: boolean }) {
  const [broken, setBroken] = useState(false);
  const safeIcon = usePublicImage(pictureUrl(feed.icon_url));
  const icon = broken ? null : safeIcon;
  const shape = round ? "rounded-full" : "rounded-[4.5px]";
  if (icon)
    return (
      <img
        src={icon}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
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
