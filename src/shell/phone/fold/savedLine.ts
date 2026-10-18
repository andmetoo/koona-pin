import type { TFunction } from "i18next";

const DAY = 24 * 60 * 60 * 1000;

/**
 * When a bookmark was saved, as FL1's source line says it: "Saved today, 9:12", "Saved yesterday,
 * 18:40", else "Saved 12 Mar" (with the year when it is not this one). Nothing for a bad date.
 */
export function savedLine(at: string, t: TFunction, language: string, now = Date.now()): string {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return "";
  const date = new Date(time);
  const today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const clock = date.toLocaleTimeString(language, { hour: "numeric", minute: "2-digit" });
  if (time >= midnight && time < midnight + DAY) return t("phone.detail.savedToday", { time: clock });
  if (time >= midnight - DAY && time < midnight) return t("phone.detail.savedYesterday", { time: clock });
  const day = date.toLocaleDateString(language, {
    day: "numeric",
    month: "short",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
  return t("phone.detail.savedOn", { date: day });
}
