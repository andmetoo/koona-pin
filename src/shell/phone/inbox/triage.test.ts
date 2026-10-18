import { describe, expect, it } from "vitest";
import type { Bookmark } from "../../../types";
import { current, isDone, minutesSpent, progress, summary, type TriageAction, triageReducer, type TriageState, upcoming } from "./triage";

const bookmark = (id: number, fields: Partial<Bookmark> = {}): Bookmark => ({
  id,
  url: `https://example.com/${id}`,
  title: `Link ${id}`,
  description: null,
  image_url: null,
  favicon_url: null,
  site_name: null,
  domain: "example.com",
  notes: null,
  is_favorite: false,
  collection_id: null,
  created_at: "2026-10-18T10:00:00.000Z",
  updated_at: "2026-10-18T10:00:00.000Z",
  tags: [],
  revision: 1,
  triaged_at: null,
  deleted_at: null,
  source: "app",
  reading_at: null,
  reading_progress: 0,
  read_at: null,
  offline_at: null,
  ...fields,
});

const SORTED = "2026-10-18T11:00:00.000Z";
const run = (actions: TriageAction[], state: TriageState | null = null) => actions.reduce(triageReducer, state);
const loaded = (count: number, at = 0) => run([{ type: "loaded", bookmarks: Array.from({ length: count }, (_, i) => bookmark(i + 1)), at }]);
/** A decision about the card on screen, saved with `commands`. */
const decided = (state: TriageState | null, kind: "keep" | "trash" | "move" | "reading", commands: number[], at = 0, collectionId?: number) => {
  const id = current(state)!.id;
  return run(
    [
      { type: "decide", id, kind, collectionId, at },
      { type: "settled", id, bookmark: bookmark(id, { triaged_at: SORTED, revision: 2 }), commands },
    ],
    state,
  );
};

describe("phone triage", () => {
  it("starts on the first card with the next two peeking", () => {
    const state = loaded(4);
    expect(current(state)?.id).toBe(1);
    expect(upcoming(state, 2).map((b) => b.id)).toEqual([2, 3]);
    expect(progress(state)).toEqual({ done: 1, total: 4 });
    expect(isDone(state)).toBe(false);
  });

  it("an empty inbox is done at once", () => {
    const state = loaded(0);
    expect(isDone(state)).toBe(true);
    expect(current(state)).toBeUndefined();
    expect(progress(state)).toEqual({ done: 0, total: 0 });
  });

  it("a decision moves on at once and learns its commands when saved", () => {
    let state = run([{ type: "decide", id: 1, kind: "keep", at: 1000 }], loaded(3));
    expect(current(state)?.id).toBe(2);
    expect(state?.steps).toMatchObject([{ id: 1, kind: "keep", pending: true, commands: [] }]);
    state = run([{ type: "settled", id: 1, bookmark: bookmark(1, { triaged_at: SORTED, revision: 2 }), commands: [7] }], state);
    expect(state?.steps).toMatchObject([{ id: 1, pending: false, commands: [7] }]);
    expect(state?.items[1].triaged_at).toBe(SORTED);
    expect(state?.lastAt).toBe(1000);
  });

  it("ignores a decision about a card no longer on screen", () => {
    const state = loaded(2);
    expect(run([{ type: "decide", id: 2, kind: "trash", at: 0 }], state)).toBe(state);
  });

  it("a failed decision brings its card back and drops the ones queued after it", () => {
    let state = run(
      [
        { type: "decide", id: 1, kind: "keep", at: 0 },
        { type: "decide", id: 2, kind: "trash", at: 0 },
      ],
      loaded(3),
    );
    expect(current(state)?.id).toBe(3);
    state = run([{ type: "failed", id: 1 }], state);
    expect(current(state)?.id).toBe(1);
    expect(state?.steps).toEqual([]);
  });

  it("undo returns the last card to the screen, even from the done state", () => {
    let state = decided(loaded(2), "keep", [1]);
    state = decided(state, "trash", [2]);
    expect(isDone(state)).toBe(true);
    state = run([{ type: "undone", bookmark: bookmark(2) }], state);
    expect(isDone(state)).toBe(false);
    expect(current(state)?.id).toBe(2);
    expect(state?.items[2].triaged_at).toBeNull();
    expect(state?.steps.map((s) => s.id)).toEqual([1]);
  });

  it("a decision that cannot come back is forgotten without moving", () => {
    let state = decided(loaded(2), "keep", [1]);
    state = run([{ type: "forgotten" }], state);
    expect(state?.steps).toEqual([]);
    expect(current(state)?.id).toBe(2);
  });

  it("skips cards sorted or deleted elsewhere", () => {
    let state = run([{ type: "changed", change: { kind: "updated", id: 2, revision: 2, bookmark: bookmark(2, { triaged_at: SORTED, revision: 2 }) } }], loaded(3));
    expect(upcoming(state, 2).map((b) => b.id)).toEqual([3]);
    state = decided(state, "keep", [1]);
    expect(current(state)?.id).toBe(3);
  });

  it("the card on screen leaves when it is trashed or deleted elsewhere", () => {
    let state = run([{ type: "changed", change: { kind: "updated", id: 1, revision: 2, bookmark: bookmark(1, { deleted_at: SORTED, revision: 2 }) } }], loaded(3));
    expect(current(state)?.id).toBe(2);
    state = run([{ type: "changed", change: { kind: "deleted", id: 2, revision: 3, bookmark: null } }], state);
    expect(current(state)?.id).toBe(3);
  });

  it("keeps a newer version against an older change", () => {
    const state = run([{ type: "patched", bookmark: bookmark(1, { is_favorite: true, revision: 3 }) }], loaded(1));
    const after = run([{ type: "changed", change: { kind: "updated", id: 1, revision: 2, bookmark: bookmark(1, { revision: 2 }) } }], state);
    expect(after?.items[1].is_favorite).toBe(true);
  });

  it("a link saved while sorting joins the end, also after the last card", () => {
    let state = decided(loaded(1), "keep", [1]);
    expect(isDone(state)).toBe(true);
    state = run([{ type: "changed", change: { kind: "created", id: 9, revision: 1, bookmark: bookmark(9) } }], state);
    expect(state?.fresh).toBe(1);
    expect(current(state)?.id).toBe(9);
    // Created, but not waiting (saved straight to the library): not ours.
    const other = run([{ type: "changed", change: { kind: "created", id: 10, revision: 1, bookmark: bookmark(10, { triaged_at: SORTED }) } }], state);
    expect(other).toBe(state);
  });

  it("sums up the decisions and the collections filed into", () => {
    let state = loaded(6, 0);
    state = decided(state, "keep", [1], 10_000);
    state = decided(state, "move", [2], 20_000, 4);
    state = decided(state, "move", [3], 30_000, 5);
    state = decided(state, "move", [4], 40_000, 4);
    state = decided(state, "reading", [5, 6], 50_000);
    state = decided(state, "trash", [7], 170_000);
    expect(summary(state!.steps)).toEqual({ count: 6, kept: 1, filed: 3, filedInto: [4, 5], reading: 1, trashed: 1 });
    expect(minutesSpent(state!)).toBe(3);
    expect(minutesSpent(loaded(1)!)).toBe(1);
  });
});
