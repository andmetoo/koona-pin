export type Theme = "light" | "dark" | "system";

export function preference<T extends string>(
  name: string,
  allowed: T[],
  fallback: T,
): T {
  try {
    const v = localStorage.getItem(`netamipin.${name}`);
    if (allowed.includes(v as T)) return v as T;
  } catch {
    /* Storage unavailable: use the default. */
  }
  return fallback;
}

export const storedTheme = () =>
  preference<Theme>("theme", ["light", "dark", "system"], "system");

export const isDark = (theme: Theme, systemDark: boolean) =>
  theme === "dark" || (theme === "system" && systemDark);

export function applyTheme(dark: boolean) {
  document.documentElement.dataset.studyTheme = dark ? "dark" : "light";
}
