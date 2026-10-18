import { useFeedActions } from "../components/feeds/FeedMenu";
import { useFeeds } from "../components/feeds/useFeeds";
import type { linkActions } from "./actions";
import type { Navigation } from "./navigation";
import type { Notices } from "./notices";

/**
 * The feeds (NP-128, NP-132): the subscriptions with their counts, refreshed in the background, and
 * a feed's row menu in the sidebar with its dialogs. The feed and post open on the Feeds page are
 * where the person is (navigation.ts).
 */
export function useFeedsView(
  { setNotice }: Pick<Notices, "setNotice">,
  { copy, open }: ReturnType<typeof linkActions>,
  { setFeedPlace }: Pick<Navigation, "setFeedPlace">,
) {
  const { feeds, refreshing: feedsRefreshing } = useFeeds();
  /** A feed's row menu in the sidebar and its dialogs (NP-132). */
  const feedMenu = useFeedActions({
    onNotice: (text, alert = false) => setNotice({ text, alert }),
    onOpen: open,
    onCopy: (text) => void copy(text),
    onUnfollowed: (feed) => setFeedPlace((place) => (place.feed === feed.uid ? { feed: null, item: null } : place)),
  });
  return { feeds, feedsRefreshing, feedMenu, feedActions: feedMenu.actions };
}

export type FeedsView = ReturnType<typeof useFeedsView>;
