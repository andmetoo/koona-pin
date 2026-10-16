export type Theme = "light" | "dark" | "system";

export function preference<T extends string>(name: string, allowed: T[], fallback: T): T {
  try {
    const v = localStorage.getItem(`koonapin.${name}`);
    if (allowed.includes(v as T)) return v as T;
  } catch {
    /* Storage unavailable: use the default. */
  }
  return fallback;
}

/** A free-form value, such as a time; `null` when none is stored. */
export function storedValue(name: string): string | null {
  try {
    return localStorage.getItem(`koonapin.${name}`);
  } catch {
    return null;
  }
}

export function savePreference(name: string, value: string) {
  try {
    localStorage.setItem(`koonapin.${name}`, value);
  } catch {
    /* Kept for this session only. */
  }
}

export const storedTheme = () => preference<Theme>("theme", ["light", "dark", "system"], "system");

/**
 * «Open links» (Р-69, point 5): where a double-click, `Enter` and a link of a list
 * row take a bookmark — the browser, or reading in the app. Its control is in
 * Settings (NP-124); reading by default (2026-10-16).
 */
export type OpenLinks = "browser" | "reader";
export const storedOpenLinks = () => preference<OpenLinks>("openLinks", ["browser", "reader"], "reader");

export const isDark =(theme: Theme, systemDark: boolean) => theme === "dark" || (theme === "system" && systemDark);

/** Tokens switch with this attribute (src/styles/app.css). */
export function applyTheme(dark: boolean) {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
