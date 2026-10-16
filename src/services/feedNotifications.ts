// The feeds' notifications (NP-133, plan §6.6): new posts of the feeds set to «Also notify
// me», and a feed that hasn't updated for a week. App adds them to the notification centre.
import type { TFunction } from "i18next";
import { Rss, TriangleAlert } from "lucide-react";
import type { Bookmark, Feed } from "../types";
import type { AppNotification } from "../components/shell/NotificationCenter";
import i18n from "../i18n";
import { previewedBookmark } from "./addLink";
import { feedName } from "./feeds";

export interface FeedNotificationActions {
  /** «Read»: the feeds page on All feeds, narrowed to these feeds. */
  onRead: (uids: string[]) => void;
  /** «Show» of a feed that isn't updating: the feeds page on that feed. */
  onShow: (uid: string) => void;
  /** «Unfollow» of a feed that isn't updating. */
  onUnfollow: (uid: string) => void;
}

/** A week of failed checks before the feed is called a problem: a site down for a day is not one. */
export const FAILING_DAYS = 7;
const DAY = 86_400_000;

/** A feed as a thumbnail of the fan: its site's cover and icon, as a link of that site would look. */
function feedThumb(feed: Feed, index: number): Bookmark | null {
  try {
    const site = new URL(feed.site_url ?? feed.url);
    const name = feedName(feed);
    return { ...previewedBookmark(site, { title: name, image_url: null, favicon_url: feed.icon_url, site_name: name }), id: -1 - index };
  } catch {
    return null;
  }
}

/** «from A», «from A and B», «from A, B and 1 more». */
function fromNames(names: string[], t: TFunction): string {
  if (names.length === 1) return t("notifications.feedsFromOne", { a: names[0] });
  if (names.length === 2) return t("notifications.feedsFromTwo", { a: names[0], b: names[1] });
  return t("notifications.feedsFromMore", { a: names[0], b: names[1], count: names.length - 2 });
}

/**
 * One `feeds` notification for the unread posts of the feeds that notify, newest batch
 * first; its key is the newest `fetched_at`, so each batch is a new, unread notification.
 * Then a `problem` for each feed failing for a week, with «Show» and «Unfollow».
 */
export function feedNotifications(
  feeds: Feed[],
  actions: FeedNotificationActions,
  t: TFunction = i18n.t.bind(i18n),
  now = Date.now(),
): AppNotification[] {
  const out: AppNotification[] = [];
  const fresh = feeds
    .filter((f) => f.destination === "notify" && f.unread > 0 && f.fetched_at)
    .sort((a, b) => b.fetched_at!.localeCompare(a.fetched_at!) || b.unread - a.unread);
  if (fresh.length) {
    const count = fresh.reduce((sum, f) => sum + f.unread, 0);
    const newest = fresh[0].fetched_at!;
    out.push({
      key: `feeds:${newest}`,
      kind: "feeds",
      icon: Rss,
      title: t("notifications.feedsTitle", { count }),
      text: fromNames(fresh.map(feedName), t),
      at: newest,
      thumbs: fresh
        .slice(0, 3)
        .map(feedThumb)
        .filter((b): b is Bookmark => b !== null),
      action: { label: t("notifications.feedsRead"), run: () => actions.onRead(fresh.map((f) => f.uid)) },
    });
  }
  for (const feed of feeds) {
    if (feed.health.state !== "failing") continue;
    const since = Date.parse(feed.health.since);
    if (Number.isNaN(since) || now - since < FAILING_DAYS * DAY) continue;
    out.push({
      key: `feed-failing:${feed.uid}:${feed.health.since}`,
      kind: "problem",
      icon: TriangleAlert,
      title: t("notifications.feedsFailing", { name: feedName(feed) }),
      text: t("notifications.feedsFailingText"),
      action: { label: t("notifications.feedsShow"), run: () => actions.onShow(feed.uid) },
      secondary: { label: t("notifications.feedsUnfollow"), run: () => actions.onUnfollow(feed.uid) },
    });
  }
  return out;
}
