/** Date groups of the list (frame 02): «Сегодня», «Вчера», «На этой неделе», «Раньше». */
export type DateGroup = "today" | "yesterday" | "week" | "earlier";
export const DATE_GROUPS: DateGroup[] = ["today", "yesterday", "week", "earlier"];

/** The stored time format: UTC with milliseconds, compared as text (Р-10). */
const stored = (date: Date) => date.toISOString();

/**
 * Local midnights that start «today», «yesterday» and «this week» (the last
 * seven days, as in frame 02), in the stored format: the database counts
 * matches at or after each, the list sorts rows into groups by them.
 */
export function dayStarts(now = new Date()): string[] {
  const day = (offset: number) =>
    stored(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset));
  return [day(0), day(1), day(6)];
}

/** Milliseconds until the next local midnight, when the groups move. */
export function untilMidnight(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
}

export function groupOf(createdAt: string, starts: string[]): DateGroup {
  const index = starts.findIndex((start) => createdAt >= start);
  return index === -1 ? "earlier" : DATE_GROUPS[index];
}

/**
 * Bookmarks per group from the database's counts «at or after each start»,
 * so a group shows its full size, not only the rows loaded so far.
 */
export function groupSizes(total: number, since: number[]): Record<DateGroup, number> {
  const [today = 0, yesterday = today, week = yesterday] = since;
  return {
    today,
    yesterday: yesterday - today,
    week: week - yesterday,
    earlier: total - week,
  };
}
