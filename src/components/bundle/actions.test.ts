import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bookmark } from "../../types";

// The prune after library changes (share-bundle.md, piece B): serialised, and never dropping an add
// made while its ids were read.
const api = vi.hoisted(() => ({ getBookmarkIds: vi.fn(), listFeeds: vi.fn() }));
vi.mock("../../services/api", () => ({ api }));
const { bundle } = await import("../../services/bundle");
const { pruneBundle } = await import("./actions");

const b = (id: number) => ({ id, url: `https://example.com/${id}`, title: `Page ${id}`, deleted_at: null, notes: null }) as Bookmark;
const ids = () => bundle.get().sections.flatMap((s) => s.entries.map((e) => e.kind === "bookmark" && e.bookmark.id));

/** An id read that resolves when told to. */
function deferredIds() {
  const reads: ((ids: number[]) => void)[] = [];
  api.getBookmarkIds.mockImplementation(() => new Promise<number[]>((resolve) => reads.push(resolve)));
  api.listFeeds.mockResolvedValue([]);
  return reads;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("pruneBundle", () => {
  afterEach(() => {
    bundle.reset();
    vi.resetAllMocks();
  });

  it("keeps a bookmark added while the prune's ids were read", async () => {
    const reads = deferredIds();
    bundle.addBookmarks([b(1), b(2)]);
    const pruned = pruneBundle();
    await settle();
    // Made and added after the ids were asked for: not in them yet.
    bundle.addBookmarks([b(3)]);
    reads[0]([1]);
    expect(await pruned).toBe(1);
    expect(ids()).toEqual([1, 3]);
    expect(bundle.get().left).toBe(1);
  });

  it("reads the ids at most twice for a burst of changes", async () => {
    const reads = deferredIds();
    bundle.addBookmarks([b(1), b(2), b(3)]);
    const calls = Array.from({ length: 10 }, () => pruneBundle());
    await settle();
    expect(api.getBookmarkIds).toHaveBeenCalledTimes(1);
    reads[0]([1, 2]);
    await settle();
    // One more after the first, for the calls made meanwhile; it reads anew.
    expect(api.getBookmarkIds).toHaveBeenCalledTimes(2);
    reads[1]([1]);
    await Promise.all(calls);
    expect(api.getBookmarkIds).toHaveBeenCalledTimes(2);
    expect(ids()).toEqual([1]);
    expect(bundle.get().left).toBe(2);
    // Settled: the next change starts a prune of its own.
    const next = pruneBundle();
    await settle();
    expect(api.getBookmarkIds).toHaveBeenCalledTimes(3);
    reads[2]([1]);
    expect(await next).toBe(0);
  });

  it("runs the one after even when the first fails", async () => {
    api.listFeeds.mockResolvedValue([]);
    api.getBookmarkIds.mockRejectedValueOnce(new Error("busy")).mockResolvedValueOnce([]);
    bundle.addBookmarks([b(1)]);
    const first = pruneBundle();
    const second = pruneBundle();
    await expect(first).rejects.toThrow("busy");
    expect(await second).toBe(1);
    expect(api.getBookmarkIds).toHaveBeenCalledTimes(2);
  });
});
