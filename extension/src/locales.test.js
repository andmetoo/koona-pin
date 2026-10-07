import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = (code) =>
  JSON.parse(readFileSync(path.join(here, "_locales", code, "messages.json"), "utf8"));
const en = catalog("en");
const codes = readdirSync(path.join(here, "_locales"));
const source = (file) => readFileSync(path.join(here, file), "utf8");

/** Keys the extension asks for: t("…") in scripts, data-i18n* in the page, __MSG_…__ in manifests. */
function usedKeys() {
  const keys = new Set();
  for (const file of readdirSync(here).filter((f) => f.endsWith(".js") && !f.includes(".test.")))
    for (const [, key] of source(file).matchAll(/\bt\("(\w+)"/g)) keys.add(key);
  for (const page of ["options.html", "search.html"])
    for (const [, key] of source(page).matchAll(/data-i18n(?:-\w+)?="(\w+)"/g)) keys.add(key);
  const build = readFileSync(path.join(here, "../../scripts/build-extension.mjs"), "utf8");
  for (const [, key] of build.matchAll(/__MSG_(\w+)__/g)) keys.add(key);
  return keys;
}

describe("extension messages", () => {
  it("speaks the languages of the app (NP-089)", () => {
    // Chrome's codes: pt_BR for pt-BR, zh_CN for zh-CN (NP-090); Serbian Latin has no code of its own.
    expect(codes.sort()).toEqual(["de", "en", "es", "fr", "it", "ja", "ko", "pl", "pt_BR", "ru", "sr", "tr", "uk", "zh_CN"]);
  });
  it.each(codes)("%s has the keys and placeholders of English", (code) => {
    const messages = catalog(code);
    expect(Object.keys(messages).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect(Object.keys(messages[key].placeholders ?? {}), key).toEqual(
        Object.keys(en[key].placeholders ?? {}),
      );
      for (const name of Object.keys(en[key].placeholders ?? {}))
        expect(messages[key].message, `${code} ${key}`).toContain(`$${name.toUpperCase()}$`);
      expect(messages[key].message.trim(), `${code} ${key}`).not.toBe("");
    }
  });
  it("defines every key the extension uses, and nothing else", () => {
    const used = usedKeys();
    expect([...used].filter((key) => !(key in en))).toEqual([]);
    expect(Object.keys(en).filter((key) => !used.has(key))).toEqual([]);
  });
  it("fits store limits: name 75 characters, description 132", () => {
    for (const messages of codes.map(catalog)) {
      expect(messages.extensionName.message.length).toBeLessThanOrEqual(75);
      expect(messages.extensionDescription.message.length).toBeLessThanOrEqual(132);
    }
  });
});
