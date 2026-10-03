import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../locales/en.json";

// Every src/locales/<code>.json is a language: adding a translation needs no
// code change (NP-010). English is the source and the fallback (Р-8).
const files = import.meta.glob<{ default: typeof en }>("../locales/*.json", {
  eager: true,
});

export interface Language {
  code: string;
  /** The name in the language itself, from its own file. */
  name: string;
}

export const languages: Language[] = Object.entries(files)
  .map(([path, file]) => ({
    code: path.replace(/^.*\/([\w-]+)\.json$/, "$1"),
    name: file.default.language.name,
  }))
  .sort((a, b) => (a.code === "en" ? -1 : b.code === "en" ? 1 : a.code.localeCompare(b.code)));

export type LanguageSetting = "system" | string;
const key = "netamipin.language";

export function storedLanguage(): LanguageSetting {
  try {
    const value = localStorage.getItem(key);
    if (value && (value === "system" || languages.some((l) => l.code === value)))
      return value;
  } catch {
    /* Storage unavailable: follow the system. */
  }
  return "system";
}

/** The first system language we have a file for, by its base code. */
export function systemLanguage(): string {
  const preferred =
    typeof navigator === "undefined" ? [] : [...(navigator.languages ?? []), navigator.language];
  for (const tag of preferred) {
    const base = tag?.toLowerCase().split("-")[0];
    if (languages.some((l) => l.code === base)) return base;
  }
  return "en";
}

export const resolveLanguage = (setting: LanguageSetting) =>
  setting === "system" ? systemLanguage() : setting;

export function setLanguage(setting: LanguageSetting) {
  try {
    localStorage.setItem(key, setting);
  } catch {
    /* Kept for this session only. */
  }
  void i18n.changeLanguage(resolveLanguage(setting));
}

void i18n.use(initReactI18next).init({
  resources: Object.fromEntries(
    Object.entries(files).map(([path, file]) => [
      path.replace(/^.*\/([\w-]+)\.json$/, "$1"),
      { translation: file.default },
    ]),
  ),
  lng: resolveLanguage(storedLanguage()),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
});

i18n.on("languageChanged", (code) => {
  document.documentElement.lang = code;
});
if (typeof document !== "undefined") document.documentElement.lang = i18n.language;

export default i18n;
