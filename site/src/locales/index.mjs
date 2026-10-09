// The site's languages (NP-107): its texts here, each language's own name from the app's catalog
// (src/locales/<code>.json, as the app's language menu shows it). Imports, not a folder listing:
// Astro bundles content.mjs, where a path relative to the file no longer points here (NP-115).
// A new language is a line in both lists.
import de from "./de.mjs";
import en from "./en.mjs";
import es from "./es.mjs";
import fr from "./fr.mjs";
import it from "./it.mjs";
import ja from "./ja.mjs";
import ko from "./ko.mjs";
import pl from "./pl.mjs";
import ptBR from "./pt-BR.mjs";
import ru from "./ru.mjs";
import srLatn from "./sr-Latn.mjs";
import tr from "./tr.mjs";
import uk from "./uk.mjs";
import zhCN from "./zh-CN.mjs";
import appDe from "../../../src/locales/de.json";
import appEn from "../../../src/locales/en.json";
import appEs from "../../../src/locales/es.json";
import appFr from "../../../src/locales/fr.json";
import appIt from "../../../src/locales/it.json";
import appJa from "../../../src/locales/ja.json";
import appKo from "../../../src/locales/ko.json";
import appPl from "../../../src/locales/pl.json";
import appPtBR from "../../../src/locales/pt-BR.json";
import appRu from "../../../src/locales/ru.json";
import appSrLatn from "../../../src/locales/sr-Latn.json";
import appTr from "../../../src/locales/tr.json";
import appUk from "../../../src/locales/uk.json";
import appZhCN from "../../../src/locales/zh-CN.json";

export const sources = { de, en, es, fr, it, ja, ko, pl, "pt-BR": ptBR, ru, "sr-Latn": srLatn, tr, uk, "zh-CN": zhCN };

export const nativeNames = Object.fromEntries(
  Object.entries({ de: appDe, en: appEn, es: appEs, fr: appFr, it: appIt, ja: appJa, ko: appKo, pl: appPl, "pt-BR": appPtBR, ru: appRu, "sr-Latn": appSrLatn, tr: appTr, uk: appUk, "zh-CN": appZhCN }).map(([code, catalog]) => [code, catalog.language.name]),
);
