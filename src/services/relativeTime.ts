/** «now», «5 min. ago», «yesterday» in the interface's language; nothing for a bad date. */
export function relativeTime(at: string, language: string, now = Date.now()): string | null {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return null;
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
  if (seconds < 60) return format.format(0, "second");
  if (seconds < 3600) return format.format(-Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return format.format(-Math.floor(seconds / 3600), "hour");
  return format.format(-Math.floor(seconds / 86400), "day");
}

/** A week: older than that, a time says nothing a notification needs. */
export const RECENT_DAYS = 7;

/**
 * The time a notification shows: only within the last week. The inbox's newest bookmark may be
 * an imported one that carries the browser's save date, years old: «2,559 days ago» is no news.
 */
export function recentTime(at: string, language: string, now = Date.now()): string | null {
  const time = Date.parse(at);
  if (Number.isNaN(time) || now - time > RECENT_DAYS * 86_400_000) return null;
  return relativeTime(at, language, now);
}
