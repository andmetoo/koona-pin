// Rules of inbox triage (NP-025, frames 03 and 19–24): the queue fixed at
// the start, what is skipped, the summary at the end, where a link came from.
import { Bookmark } from "../types";

/** A decision of triage, newest last. `advanced`: it moved on to the next card. */
export interface Step {
  id: number;
  title: string;
  kind: "keep" | "trash" | "move" | "favorite" | "tag" | "edit";
  /** Where `move` and `edit` left the bookmark. */
  collectionId: number | null;
  /** What `undo` takes back; none when nothing changed. */
  command: number | null;
  advanced: boolean;
}

/** Still waiting for a decision: not sorted elsewhere, not thrown away. */
export const waiting = (b: Bookmark | undefined) => !!b && b.triaged_at === null && b.deleted_at === null;

/**
 * The first card at or after `from` that still waits; the queue length when
 * none does. A bookmark sorted or deleted elsewhere is skipped silently.
 */
export function nextWaiting(queue: number[], items: Record<number, Bookmark>, from: number) {
  for (let i = from; i < queue.length; i++) if (waiting(items[queue[i]])) return i;
  return queue.length;
}

/** «12 решений: 7 оставлено, 3 разложено по коллекциям, 2 в корзине» (frame 23). */
export function summary(steps: Step[]) {
  const decided = steps.filter((s) => s.advanced);
  const filed = decided.filter((s) => (s.kind === "move" || s.kind === "edit") && s.collectionId !== null).length;
  const trashed = decided.filter((s) => s.kind === "trash").length;
  return { count: decided.length, kept: decided.length - filed - trashed, filed, trashed };
}

/** Whether the saved time is today, yesterday or earlier, in local time. */
export function savedDay(at: string, now = new Date()): "today" | "yesterday" | "earlier" {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const saved = new Date(at);
  const days = Math.round((day(now) - day(saved)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : "earlier";
}

/** The browser named in «сохранено … из Chrome»; other sources have their own words. */
export const browserName = (source: string | null) =>
  ({ chrome: "Chrome", edge: "Edge", firefox: "Firefox" })[source ?? ""] ?? null;
