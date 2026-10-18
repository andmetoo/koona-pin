const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago, as short as the phone's meta line has room for (the NP-070 frames: "2 h", "5 h",
 * "yesterday", "3 d", "2 w"), in the interface's language: "now", minutes, hours, "yesterday" for
 * the calendar day before, days, weeks up to four, then the date ("12 Mar", with the year when it
 * is not this one). Nothing for a bad date.
 */
export function shortAge(at: string, language: string, now = Date.now()): string {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return "";
  const ago = Math.max(0, now - time);
  const unit = (value: number, name: "minute" | "hour" | "day" | "week") =>
    new Intl.NumberFormat(language, { style: "unit", unit: name, unitDisplay: "narrow" }).format(value);
  if (ago < MINUTE) return new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(0, "second");
  if (ago < HOUR) return unit(Math.floor(ago / MINUTE), "minute");
  const today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (time >= midnight) return unit(Math.floor(ago / HOUR), "hour");
  if (time >= midnight - DAY) return new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(-1, "day");
  const days = Math.ceil((midnight - time) / DAY);
  if (days < 7) return unit(days, "day");
  if (days < 28) return unit(Math.floor(days / 7), "week");
  const date = new Date(time);
  return date.toLocaleDateString(language, {
    day: "numeric",
    month: "short",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}
