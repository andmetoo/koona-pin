// Feeds (NP-128, Р-71): the typed calls and events of src-tauri/src/feeds,
// through `api`, so the browser preview answers them from demoFeeds.ts.
// The hooks and helpers of the feeds page come with the page itself.
import type {
  Feed,
  FeedArticle,
  FeedDestination,
  FeedItemPage,
  FeedItemQuery,
  FeedPreview,
  FeedsChanged,
  FeedsRefresh,
  LinkPreview,
  OpmlImport,
  SavePlace,
  Bookmark,
} from "../types";
import { api } from "./api";
import { toCommandError } from "./errors";

/** The name a feed goes by: the person's, else its own, else its address's site. */
export function feedName(feed: Pick<Feed, "title" | "feed_title" | "url">): string {
  if (feed.title) return feed.title;
  if (feed.feed_title) return feed.feed_title;
  try {
    return new URL(feed.url).hostname.replace(/^www\./, "");
  } catch {
    return feed.url;
  }
}

/** A command whose task has not landed yet answers `not_implemented` (NP-128). */
export const isNotImplemented = (error: unknown) => toCommandError(error).code === "not_implemented";

export const listFeeds = (): Promise<Feed[]> => api.listFeeds();
/** `title` null: the feed's own; an address already followed answers its subscription. */
export const subscribeFeed = (url: string, title: string | null, destination: FeedDestination): Promise<Feed> =>
  api.subscribeFeed(url, title, destination);
/** Null keeps a field; an empty title goes back to the feed's own. */
export const updateFeed = (uid: string, title: string | null, destination: FeedDestination | null): Promise<Feed> =>
  api.updateFeed(uid, title, destination);
export const unsubscribeFeed = (uid: string): Promise<void> => api.unsubscribeFeed(uid);
export const previewLink = (url: string): Promise<LinkPreview> => api.previewLink(url);
export const previewFeed = (url: string): Promise<FeedPreview> => api.previewFeed(url);
export const listFeedItems = (query: FeedItemQuery): Promise<FeedItemPage> => api.listFeedItems(query);
export const getFeedArticle = (id: number): Promise<FeedArticle> => api.getFeedArticle(id);
export const setFeedItemsRead = (ids: number[], read: boolean): Promise<void> => api.setFeedItemsRead(ids, read);
/** `feedUid` null: every feed; `upTo`: only posts fetched by then. How many were marked. */
export const markFeedRead = (feedUid: string | null, upTo: string | null = null): Promise<number> =>
  api.markFeedRead(feedUid, upTo);
export const saveFeedItem = (id: number, place: SavePlace, favorite = false): Promise<Bookmark> =>
  api.saveFeedItem(id, place, favorite);
/** `feedUid` null: every feed. */
export const refreshFeeds = (feedUid: string | null = null): Promise<void> => api.refreshFeeds(feedUid);
export const clearFeedCache = (): Promise<void> => api.clearFeedCache();
export const importOpml = (path: string): Promise<OpmlImport> => api.importOpml(path);
export const exportOpml = (path: string): Promise<number> => api.exportOpml(path);
/** Minutes between checks; 0 only on refresh. */
export const setFeedsRefreshMinutes = (minutes: number): Promise<void> => api.setFeedsRefreshMinutes(minutes);

/** `feeds-changed`: every subscription, after a fetch, read mark, save or subscription change. */
export const onFeedsChanged = (callback: (change: FeedsChanged) => void): (() => void) => api.onFeedsChanged(callback);
/** `feeds-refresh`: a check under way, and when it ends. */
export const onFeedsRefresh = (callback: (progress: FeedsRefresh) => void): (() => void) => api.onFeedsRefresh(callback);
