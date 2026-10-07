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
const key = "koonapin.language";
/** A new install speaks English until the person picks a language or «System» (NP-085). */
export const defaultLanguage: LanguageSetting = "en";

export function storedLanguage(): LanguageSetting {
  try {
    const value = localStorage.getItem(key);
    if (value && (value === "system" || languages.some((l) => l.code === value)))
      return value;
  } catch {
    /* Storage unavailable: the default. */
  }
  return defaultLanguage;
}

/** Language, script and region of a tag, with the likely ones filled in: `sr-RS` → sr, Cyrl, RS.
 * `de_DE`, as some systems write it, is `de-DE`. */
function subtags(tag: string) {
  const bcp47 = tag.replace(/_/g, "-");
  try {
    const locale = new Intl.Locale(bcp47).maximize();
    return { language: locale.language, script: locale.script, region: locale.region };
  } catch {
    return { language: bcp47.toLowerCase().split("-")[0], script: undefined, region: undefined };
  }
}

/** Our file for one system language: same language and script, the same region if we have it (NP-089).
 * `sr-Latn-RS` → sr-Latn, `sr-RS` → sr, `pt-PT` → pt-BR, `de-AT` → de. Another script is
 * another language to its reader: `zh-TW` (traditional) gets no file from zh-CN (NP-090). */
export function matchLanguage(tag: string, codes = languages.map((l) => l.code)): string | undefined {
  const wanted = subtags(tag);
  // A tag that can't be parsed says nothing of its script: its language alone decides.
  const sameScript = codes.filter((code) => {
    const own = subtags(code);
    return own.language === wanted.language && (wanted.script === undefined || own.script === wanted.script);
  });
  return (
    sameScript.find((code) => subtags(code).region === wanted.region) ??
    sameScript.find((code) => !code.includes("-")) ??
    sameScript[0]
  );
}

/** The first system language we have a file for. */
export function systemLanguage(): string {
  const preferred =
    typeof navigator === "undefined" ? [] : [...(navigator.languages ?? []), navigator.language];
  for (const tag of preferred) {
    const code = tag ? matchLanguage(tag) : undefined;
    if (code) return code;
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

/** The tray menu is drawn by Rust: it gets its words in the interface's language (NP-085). */
let tellTray: (labels: { open: string; quit: string; tooltip: string }) => void = () => {};
export function onTrayLabels(send: typeof tellTray) {
  tellTray = send;
  send(trayLabels());
}
const trayLabels = () => ({ open: i18n.t("tray.open"), quit: i18n.t("tray.quit"), tooltip: i18n.t("tray.tooltip") });

i18n.on("languageChanged", (code) => {
  if (typeof document !== "undefined") document.documentElement.lang = code;
  tellTray(trayLabels());
});
if (typeof document !== "undefined") document.documentElement.lang = i18n.language;

export default i18n;
