// Texts of koona.app/pin (doc/site.md): one file per language in ./locales, English the source.
// The languages are the app's (NP-089, NP-107), with one Serbian: Latin, the owner's choice.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// KOONAPIN_FEEDBACK_URL below: from the environment or from .env in the repository root
// (.env.example), for site:build, site:check and deploy-site.ps1 alike. The environment wins.
// A path, not a URL: Bun's process.loadEnvFile takes only a string.
const dotenv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

const locales = new URL("./locales/", import.meta.url);
const sources = {};
for (const file of readdirSync(locales).filter((f) => f.endsWith(".mjs")))
  sources[file.slice(0, -4)] = (await import(new URL(file, locales).href)).default;

/** Same keys and list lengths as English; a string English has is never left empty. */
function sameShape(code, en, other, at = "") {
  if (typeof en === "string") {
    if (typeof other !== "string") throw new Error(`site/src/locales/${code}: ${at} is not a text`);
    if (en && !other.trim()) throw new Error(`site/src/locales/${code}: ${at} is empty`);
    // A Latin letter in a Cyrillic word (or back) looks right and breaks search and spelling.
    const mixed = other.split(/[^\p{L}]+/u).find((w) => /\p{Script=Latin}/u.test(w) && /\p{Script=Cyrillic}/u.test(w));
    if (mixed) throw new Error(`site/src/locales/${code}: ${at} mixes scripts in «${mixed}»`);
    return;
  }
  if (Array.isArray(en) !== Array.isArray(other) || typeof other !== "object" || other === null)
    throw new Error(`site/src/locales/${code}: ${at} has another shape than English`);
  const keys = Object.keys(en);
  const extra = Object.keys(other).filter((k) => !(k in en));
  if (extra.length || keys.length !== Object.keys(other).length)
    throw new Error(`site/src/locales/${code}: ${at || "the file"} has keys ${Object.keys(other).join(", ")}, English ${keys.join(", ")}`);
  for (const k of keys) sameShape(code, en[k], other[k], at ? `${at}.${k}` : k);
}
for (const [code, t] of Object.entries(sources)) sameShape(code, sources.en, t);

/** The language's own name, as the app's language menu shows it (src/locales/<code>.json). */
const nativeName = (code) => JSON.parse(readFileSync(new URL(`../../src/locales/${code}.json`, import.meta.url), "utf8")).language.name;
const OG = { en: "en_US", ru: "ru_RU", de: "de_DE", es: "es_ES", fr: "fr_FR", it: "it_IT", pl: "pl_PL", "pt-BR": "pt_BR", "sr-Latn": "sr_RS", tr: "tr_TR", uk: "uk_UA", "zh-CN": "zh_CN", ja: "ja_JP", ko: "ko_KR" };
// The only Serbian of the site is plain «sr» to people: /pin/sr/, «Srpski», «Serbian». The
// Chinese is simplified, not Chinese of China (NP-090): «Simplified Chinese» in the menu.
const ONLY = { "sr-Latn": { dir: "sr/", name: "Srpski", display: "sr" }, "zh-CN": { display: "zh-Hans" } };

/** The site's languages in the order of the menu: by their own names, Latin before Cyrillic. */
export const languages = Object.keys(sources)
  .map((code) => ({
    lang: code,
    // Addresses are lower case: /pin/, /pin/de/, /pin/pt-br/.
    dir: ONLY[code]?.dir ?? (code === "en" ? "" : `${code.toLowerCase()}/`),
    name: ONLY[code]?.name ?? nativeName(code),
    display: ONLY[code]?.display ?? code,
    short: code.split("-")[0].toUpperCase(),
    og: OG[code] ?? code.replace("-", "_"),
  }))
  .sort((a, b) => new Intl.Collator("en").compare(a.name, b.name));

export const content = Object.fromEntries(languages.map((l) => [l.lang, { ...sources[l.lang], ...l }]));

/** A language's name in the language of a page, for the second line of the menu: «German» on /pin/. */
export function nameIn(page, code) {
  const shown = languages.find((l) => l.lang === code)?.display ?? code;
  const name = new Intl.DisplayNames([page], { type: "language" }).of(shown) ?? code;
  return name.charAt(0).toLocaleUpperCase(page) + name.slice(1);
}

export const SUPPORT = "https://github.com/andmetoo/koona-pin/issues/new/choose";
// The Edge Function `feedback` (NP-088): the site form posts here. Without it the
// build leaves the form out and «Support» keeps pointing at GitHub.
export const FEEDBACK_ENDPOINT = process.env.KOONAPIN_FEEDBACK_URL || "";
export const ORIGIN = "https://koona.app";
// Every app of koona.app is a path of it (Р-47): pages, assets and redirects of this site are under BASE.
export const BASE = "/pin";
export const SITE = `${ORIGIN}${BASE}`;
