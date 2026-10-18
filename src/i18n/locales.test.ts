import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { matchLanguage } from ".";
import { latinCatalog, toLatin } from "./serbianLatin";

type Catalog = { [key: string]: string | Catalog };
const dir = path.join(__dirname, "..", "locales");
const read = (code: string): Catalog => JSON.parse(readFileSync(path.join(dir, `${code}.json`), "utf8"));
const codes = readdirSync(dir)
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.replace(/\.json$/, ""));
const en = read("en");

/** Every string with its dotted key. */
function flat(catalog: Catalog, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(catalog))
    if (typeof value === "string") out.set(prefix + key, value);
    else for (const [k, v] of flat(value, `${prefix}${key}.`)) out.set(k, v);
  return out;
}

const forms = ["zero", "one", "two", "few", "many", "other"];
const plural = /_(zero|one|two|few|many|other)$/;
/** Keys with a count, by their base key: `links.start_one` → `links.start`. */
function counted(strings: Map<string, string>) {
  const bases = new Map<string, Map<string, string>>();
  for (const [key, value] of strings) {
    const form = key.match(plural)?.[1];
    if (!form) continue;
    const base = key.replace(plural, "");
    bases.set(base, (bases.get(base) ?? new Map()).set(form, value));
  }
  return bases;
}
const vars = (text: string) => new Set([...text.matchAll(/\{\{\s*(\w+)/g)].map((m) => m[1]));

/** Keys repeated within one object: JSON.parse keeps the last one silently. */
function repeatedKeys(text: string): string[] {
  const repeated: string[] = [];
  const objects: Set<string>[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") objects.push(new Set());
    else if (c === "}") objects.pop();
    else if (c === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const isKey = /^\s*:/.test(text.slice(end + 1, end + 8));
      const key = text.slice(i + 1, end);
      const own = objects[objects.length - 1];
      if (isKey && own) {
        if (own.has(key)) repeated.push(key);
        own.add(key);
      }
      i = end;
    }
  }
  return repeated;
}

it.each(codes)("%s.json has no repeated keys", (code) => {
  expect(repeatedKeys(readFileSync(path.join(dir, `${code}.json`), "utf8"))).toEqual([]);
});

const english = flat(en);
const englishCounted = counted(english);
const englishPlain = [...english.keys()].filter((key) => !plural.test(key));
/**
 * The phone's screens (NP-072b) are written in English while they are built; the other languages
 * get them when the screens are done, and fall back to English until then.
 */
const notYetTranslated = (key: string) => key.startsWith("phone.");

describe.each(codes.filter((code) => code !== "en"))("locale %s", (code) => {
  const strings = flat(read(code));
  const own = counted(strings);
  const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;

  it("has every English key and nothing else", () => {
    const plain = [...strings.keys()].filter((key) => !plural.test(key));
    expect(englishPlain.filter((key) => !strings.has(key) && !notYetTranslated(key)), "missing").toEqual([]);
    expect(plain.filter((key) => !english.has(key)), "unknown").toEqual([]);
    expect([...englishCounted.keys()].filter((base) => !own.has(base) && !notYetTranslated(base)), "missing counted").toEqual([]);
    expect([...own.keys()].filter((base) => !englishCounted.has(base)), "unknown counted").toEqual([]);
  });

  it("has exactly the plural forms the language needs", () => {
    for (const [base, got] of own)
      expect([...got.keys()].sort((a, b) => forms.indexOf(a) - forms.indexOf(b)), base).toEqual(
        forms.filter((form) => categories.includes(form as Intl.LDMLPluralRule)),
      );
  });

  // «one» is 21 and 31 in Serbian, Ukrainian and Russian, 0 in French and Portuguese:
  // «the other one» or «your only bookmark» would be wrong there.
  const oneIsNotOne = [0, 21].some((n) => new Intl.PluralRules(code).select(n) === "one");
  it.runIf(oneIsNotOne)("says the count in every «one» form", () => {
    const shownNextToCount = ["selection.selected"];
    const silent = [...own]
      .filter(([base, got]) => !shownNextToCount.includes(base) && !/\{\{\s*count/.test(got.get("one") ?? ""))
      .map(([base]) => base);
    expect(silent).toEqual([]);
  });

  it("keeps the placeholders of the English text", () => {
    for (const key of englishPlain)
      if (strings.has(key)) expect(vars(strings.get(key)!), key).toEqual(vars(english.get(key)!));
    for (const [base, got] of own) {
      const source = [...(englishCounted.get(base)?.values() ?? [])].map(vars);
      const allowed = new Set(source.flatMap((set) => [...set]));
      // A form may say less than English («after the copy was made» for «after {{when}}»), never more.
      for (const [form, text] of got)
        expect([...vars(text)].filter((name) => !allowed.has(name)), `${base}_${form}`).toEqual([]);
    }
  });

  it("mixes no Latin and Cyrillic letters in one word", () => {
    const mixed = [...strings].flatMap(([key, text]) =>
      text
        .split(/[^\p{L}]+/u)
        .filter((word) => /\p{Script=Cyrillic}/u.test(word) && /\p{Script=Latin}/u.test(word))
        .map((word) => `${key}: ${word}`),
    );
    expect(mixed).toEqual([]);
  });

  it("has no empty strings", () => {
    expect([...strings].filter(([, text]) => !text.trim()).map(([key]) => key)).toEqual([]);
  });
});

describe("Serbian", () => {
  it("Latin is the Cyrillic file letter by letter (bun run locales:sr-latn)", () => {
    expect(read("sr-Latn")).toEqual(latinCatalog(read("sr")));
  });
  it("writes digraphs as a word or a word of capitals wants", () => {
    expect(toLatin("Љубав, њива, Џеп")).toBe("Ljubav, njiva, Džep");
    expect(toLatin("ЉУБАВ ПАЉ")).toBe("LJUBAV PALJ");
    expect(toLatin("Ђорђе Ћирић — {{count}} обележивача")).toBe("Đorđe Ćirić — {{count}} obeleživača");
  });
});

describe("Korean", () => {
  // 을/를, 이/가, 은/는, 와/과, (으)로 depend on the last sound of the word before them:
  // after a substitution only the double form is right (NP-090).
  it("puts the double particle after a substitution", () => {
    const fixed = /\}\}[’']?(을|를|이|가|은|는|와|과|으로|로)(?![(가-힣])/;
    expect([...flat(read("ko"))].filter(([, text]) => fixed.test(text)).map(([key]) => key)).toEqual([]);
  });
});

describe("system language", () => {
  const ours = ["en", "ru", "sr", "sr-Latn", "de", "pt-BR", "uk", "zh-CN", "ja", "ko"];
  it.each([
    ["zh-CN", "zh-CN"],
    ["zh-Hans-CN", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["zh", "zh-CN"],
    ["ja-JP", "ja"],
    ["ko-KR", "ko"],
    ["de_DE", "de"],
    ["pt_BR", "pt-BR"],
    ["de-x-!!", "de"],
    ["sr-Latn-RS", "sr-Latn"],
    ["sr-RS", "sr"],
    ["sr-Cyrl-BA", "sr"],
    ["sr-ME", "sr-Latn"],
    ["sr", "sr"],
    ["pt-PT", "pt-BR"],
    ["pt", "pt-BR"],
    ["de-AT", "de"],
    ["en-GB", "en"],
    ["uk-UA", "uk"],
  ])("%s → %s", (tag, code) => {
    expect(matchLanguage(tag, ours)).toBe(code);
  });
  it("has no file for a language it doesn't speak", () => {
    expect(matchLanguage("he-IL", ours)).toBeUndefined();
  });
  it.each(["zh-TW", "zh-HK", "zh-Hant", "zh-MO"])("%s, traditional Chinese, is not simplified (NP-090)", (tag) => {
    expect(matchLanguage(tag, ours)).toBeUndefined();
  });
});
