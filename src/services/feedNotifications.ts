// The feeds' notifications (NP-133): new posts of feeds that notify, and feeds that stopped
// updating. A stub until NP-133 lands: App already passes its result into the notification
// centre (NP-132), so only this body changes.
import type { Feed } from "../types";
import type { AppNotification } from "../components/shell/NotificationCenter";

/** What a feed notification's buttons do: the Feeds page, or unfollowing a failing feed. */
export interface FeedNotificationActions {
  /** The Feeds page on All feeds, or on one feed. */
  openFeeds: (feedUid: string | null) => void;
  unfollow: (feed: Feed) => void;
}

export function feedNotifications(feeds: Feed[], actions: FeedNotificationActions): AppNotification[] {
  void feeds;
  void actions;
  return [];
}
