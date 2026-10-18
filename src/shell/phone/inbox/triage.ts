// The phone's inbox triage as a pure model (NP-072b, frames I1–I3): the queue fixed when the
// Inbox opens, the card on screen, the decisions with what undoes them, and the summary of the
// done state. The commands themselves are the desktop triage's (components/library/Triage.tsx):
// ./useTriage.ts runs them and reports here.
import { nextWaiting, waiting } from "../../../services/triage";
import type { Bookmark, BookmarkChange } from "../../../types";

/** What a decision does: keep it, throw it away, file it into a collection, keep it for Reading. */
export type Decision = "keep" | "trash" | "move" | "reading";

/** A decision about one card, newest last. Every one moves on to the next card. */
export interface Step {
  id: number;
  title: string;
  kind: Decision;
  /** Where `move` filed it. */
  collectionId: number | null;
  /** What `undo` takes back, in the order they ran (Reading is two: keep, then add to Reading). */
  commands: number[];
  /** Shown at once, saved a moment later: its commands are not known yet. */
  pending: boolean;
}

export interface TriageState {
  /** Fixed when the Inbox opens, newest first; links saved meanwhile join the end. */
  ids: number[];
  items: Record<number, Bookmark>;
  /** The card on screen; the queue length once everything is decided. */
  position: number;
  /** Links saved while sorting. */
  fresh: number;
  steps: Step[];
  /** When the queue was read and when the last decision was made (ms): "in about 3 minutes". */
  startedAt: number;
  lastAt: number | null;
}

export type TriageAction =
  | { type: "loaded"; bookmarks: Bookmark[]; at: number }
  /** A change from anywhere: a card updated, a link saved, a bookmark gone. */
  | { type: "changed"; change: BookmarkChange }
  /** A decision about the card on screen: it leaves at once. */
  | { type: "decide"; id: number; kind: Decision; collectionId?: number | null; at: number }
  /** The decision was saved: the bookmark as it is now and what undoes it. */
  | { type: "settled"; id: number; bookmark: Bookmark; commands: number[] }
  /** It failed: the card comes back, and the decisions queued after it are dropped. */
  | { type: "failed"; id: number }
  /** A card changed without a decision (the heart). */
  | { type: "patched"; bookmark: Bookmark }
  /** The last decision was taken back: its card returns to the screen. */
  | { type: "undone"; bookmark: Bookmark | null }
  /** The last decision cannot come back (changed since, gone): it is forgotten. */
  | { type: "forgotten" };

export function triageReducer(state: TriageState | null, action: TriageAction): TriageState | null {
  if (action.type === "loaded")
    return {
      ids: action.bookmarks.map((b) => b.id),
      items: Object.fromEntries(action.bookmarks.map((b) => [b.id, b])),
      position: 0,
      fresh: 0,
      steps: [],
      startedAt: action.at,
      lastAt: null,
    };
  if (!state) return state;
  switch (action.type) {
    case "changed":
      return changed(state, action.change);
    case "decide": {
      if (current(state)?.id !== action.id) return state;
      const b = state.items[action.id];
      const step: Step = {
        id: b.id,
        title: b.title || b.url,
        kind: action.kind,
        collectionId: action.kind === "move" ? (action.collectionId ?? null) : null,
        commands: [],
        pending: true,
      };
      return { ...state, steps: [...state.steps, step], position: nextWaiting(state.ids, state.items, state.position + 1), lastAt: action.at };
    }
    case "settled": {
      const index = state.steps.findIndex((s) => s.id === action.id && s.pending);
      if (index < 0) return { ...state, items: { ...state.items, [action.id]: action.bookmark } };
      const steps = state.steps.slice();
      steps[index] = { ...steps[index], commands: action.commands, pending: false };
      return { ...state, steps, items: { ...state.items, [action.id]: action.bookmark } };
    }
    case "failed": {
      const index = state.steps.findIndex((s) => s.id === action.id && s.pending);
      if (index < 0) return state;
      const at = state.ids.indexOf(action.id);
      return { ...state, steps: state.steps.slice(0, index), position: at >= 0 ? at : state.position };
    }
    case "patched":
      return action.bookmark.id in state.items ? { ...state, items: { ...state.items, [action.bookmark.id]: action.bookmark } } : state;
    case "undone": {
      const step = state.steps.at(-1);
      if (!step) return state;
      const at = state.ids.indexOf(step.id);
      const back = action.bookmark;
      return {
        ...state,
        items: back ? { ...state.items, [back.id]: back } : state.items,
        steps: state.steps.slice(0, -1),
        position: at >= 0 ? at : state.position,
      };
    }
    case "forgotten":
      return { ...state, steps: state.steps.slice(0, -1) };
  }
}

/**
 * A change from anywhere (the desktop triage's rules): a card in the queue takes the newer
 * version, a link saved meanwhile joins the end, a bookmark deleted for good leaves. A card on
 * screen moved to the trash elsewhere (its menu) leaves too, unless a decision about it waits.
 */
function changed(state: TriageState, change: BookmarkChange): TriageState {
  const b = change.bookmark;
  const shown = current(state);
  if (!b) {
    if (!(change.id in state.items)) return state;
    const items = { ...state.items };
    delete items[change.id];
    return { ...state, items, position: shown?.id === change.id ? nextWaiting(state.ids, items, state.position + 1) : state.position };
  }
  if (state.ids.includes(b.id)) {
    const known = state.items[b.id];
    if (known && known.revision > b.revision) return state;
    const items = { ...state.items, [b.id]: b };
    const trashedHere = shown?.id === b.id && !!b.deleted_at && !state.steps.some((s) => s.id === b.id && s.pending);
    return { ...state, items, position: trashedHere ? nextWaiting(state.ids, items, state.position + 1) : state.position };
  }
  if (change.kind === "created" && waiting(b)) return { ...state, ids: [...state.ids, b.id], items: { ...state.items, [b.id]: b }, fresh: state.fresh + 1 };
  return state;
}

/** The card on screen; none once everything is decided. */
export const current = (state: TriageState | null): Bookmark | undefined =>
  state && state.position < state.ids.length ? state.items[state.ids[state.position]] : undefined;

/** The cards after the one on screen that still wait, at most `count`: the peeking ones. */
export function upcoming(state: TriageState | null, count: number): Bookmark[] {
  if (!state) return [];
  const next: Bookmark[] = [];
  for (let i = state.position + 1; i < state.ids.length && next.length < count; i++) {
    const b = state.items[state.ids[i]];
    if (waiting(b)) next.push(b);
  }
  return next;
}

export const isDone = (state: TriageState | null) => !!state && state.position >= state.ids.length;

/** "5 of 12": the card on screen counts, as the frames have it; all of them once done. */
export function progress(state: TriageState | null): { done: number; total: number } {
  if (!state) return { done: 0, total: 0 };
  const total = state.ids.length;
  return { done: Math.min(state.position + 1, total), total };
}

/** The done state's shelf: what the decisions did, and the colours of the collections filed into. */
export function summary(steps: Step[]) {
  const count = (kind: Decision) => steps.filter((s) => s.kind === kind).length;
  const filedInto = [...new Set(steps.filter((s) => s.kind === "move" && s.collectionId !== null).map((s) => s.collectionId as number))];
  return { count: steps.length, kept: count("keep"), filed: count("move"), filedInto, reading: count("reading"), trashed: count("trash") };
}

/** "in about 3 minutes": from opening the Inbox to the last decision, at least one. */
export function minutesSpent(state: TriageState): number {
  return Math.max(1, Math.round(((state.lastAt ?? state.startedAt) - state.startedAt) / 60_000));
}
