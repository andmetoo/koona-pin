/** The season the Supporter heart is coloured by (NP-066): the northern calendar, by months. */
export type Season = "winter" | "spring" | "summer" | "autumn";

export function seasonOf(date: Date): Season {
  const month = date.getMonth();
  if (month < 2 || month === 11) return "winter";
  if (month < 5) return "spring";
  if (month < 8) return "summer";
  return "autumn";
}

/** Sets `data-season` on <html>, where app.css picks the colours; again at the next month. */
export function applySeason(now = new Date()) {
  document.documentElement.dataset.season = seasonOf(now);
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  window.setTimeout(() => applySeason(), Math.min(next.getTime() - now.getTime() + 1000, 2 ** 31 - 1));
}
