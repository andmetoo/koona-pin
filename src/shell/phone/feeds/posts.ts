import { useMemo, useSyncExternalStore } from "react";
import type { FeedItem } from "../../../types";

/**
 * The posts the Feeds screen has shown, by id (NP-072b): the post view pushed over it reads its
 * post from here, and sees it change (saved, read) as the list reloads underneath; what the post
 * view changes itself is written back, so a post the list keeps on Unread shows it too. There is
 * no command for one post: the list is where posts come from.
 */
const posts = new Map<number, FeedItem>();
/** The list's own last copy of each: only a new one from the list replaces what the post view wrote. */
const listed = new Map<number, FeedItem>();
const listeners = new Set<() => void>();
let version = 0;

const changed = () => {
  version++;
  listeners.forEach((listener) => listener());
};

/** The list's posts as it loaded them; each new copy is told to its readers. */
export function rememberPosts(items: FeedItem[]) {
  let any = false;
  for (const item of items) {
    if (listed.get(item.id) === item) continue;
    listed.set(item.id, item);
    posts.set(item.id, item);
    any = true;
  }
  if (any) changed();
}

/** What the post view did to a post it shows (read, saved), before the list hears of it. */
export function updatePost(id: number, patch: Partial<Pick<FeedItem, "read" | "bookmark_id">>) {
  const item = posts.get(id);
  if (!item || Object.entries(patch).every(([key, value]) => item[key as keyof FeedItem] === value)) return;
  posts.set(id, { ...item, ...patch });
  changed();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** One post as last known; undefined when the list never showed it. */
export const postOf = (id: number): FeedItem | undefined => posts.get(id);

/** {@link postOf}, followed. */
export function usePost(id: number): FeedItem | undefined {
  return useSyncExternalStore(subscribe, () => postOf(id));
}

/** These posts as last known, the ones never shown left out; a new array when any changes. */
export function usePosts(ids: ReadonlySet<number>): FeedItem[] {
  const now = useSyncExternalStore(subscribe, () => version);
  return useMemo(() => [...ids].flatMap((id) => posts.get(id) ?? []), [ids, now]);
}

/** For tests. */
export function forgetPosts() {
  posts.clear();
  listed.clear();
  changed();
}

const timeOf = (item: FeedItem) => Date.parse(item.published_at ?? item.fetched_at) || 0;

/**
 * Unread posts, plus those opened here since the switch was set: a post opened from Unread is
 * marked read after a second, and it stays on the list it was opened from until the person
 * changes the feed, the switch or checks again. Newest first, as the cache lists them; a kept
 * post the list has again is the list's.
 */
export function withKept(items: FeedItem[], kept: readonly FeedItem[]): FeedItem[] {
  const listed = new Set(items.map((item) => item.id));
  const extra = kept.filter((item) => !listed.has(item.id));
  if (!extra.length) return items;
  // Only within what is loaded: a kept post older than the last one waits for the next page.
  const last = items.length ? timeOf(items[items.length - 1]) : -Infinity;
  const merged = [...items, ...extra.filter((item) => timeOf(item) >= last)];
  return merged.sort((a, b) => timeOf(b) - timeOf(a) || b.id - a.id);
}
