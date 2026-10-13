// The addresses of koona.app/pin that this repository relies on: the app (privacy, licenses and
// feedback pages, the changelog link, latest.json in tauri.conf.json), the updater (the packages'
// URLs in latest.json, build-latest.mjs) and the extension (its Firefox update_url). The site itself
// lives in andmetoo/koona-site; a change here is a change of that contract, made there too.
export const ORIGIN = "https://koona.app";
// Every app of koona.app is a path of it (Р-47): pages, assets and redirects of this site are under BASE.
export const BASE = "/pin";
export const SITE = `${ORIGIN}${BASE}`;

// The site's languages (NP-107), in the order of its menu, and the folder of each under /pin/
// (lower case: /pin/, /pin/de/, /pin/pt-br/). One Serbian, in Latin script, at /pin/sr/. The tests of
// the app's links and of the feedback function check their addresses against this list; a language
// added to the site is a line here.
export const languages = [
  { lang: "de", dir: "de/", name: "Deutsch" },
  { lang: "en", dir: "", name: "English" },
  { lang: "es", dir: "es/", name: "Español" },
  { lang: "fr", dir: "fr/", name: "Français" },
  { lang: "it", dir: "it/", name: "Italiano" },
  { lang: "pl", dir: "pl/", name: "Polski" },
  { lang: "pt-BR", dir: "pt-br/", name: "Português (Brasil)" },
  { lang: "sr-Latn", dir: "sr/", name: "Srpski" },
  { lang: "tr", dir: "tr/", name: "Türkçe" },
  { lang: "ru", dir: "ru/", name: "Русский" },
  { lang: "uk", dir: "uk/", name: "Українська" },
  { lang: "ko", dir: "ko/", name: "한국어" },
  { lang: "ja", dir: "ja/", name: "日本語" },
  { lang: "zh-CN", dir: "zh-cn/", name: "简体中文" },
];
