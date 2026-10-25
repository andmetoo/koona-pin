import { useSyncExternalStore } from "react";
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
const changed = () => listeners.forEach((listener) => listener());

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

/** For tests. */
export function forgetPosts() {
  posts.clear();
  listed.clear();
  changed();
}

