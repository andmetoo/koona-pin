import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { browsers, localBrowsers, manifest, safariMinVersion } from "../../scripts/build-extension.mjs";
import { textLanguage } from "./ext.js";
import { VERSION } from "./version.js";

describe("manifests", () => {
  it("ships Chrome, Edge and Firefox; Safari is a local build only (NP-119)", () => {
    expect(browsers).toEqual(["chrome", "edge", "firefox"]);
    expect(localBrowsers).toEqual(["safari"]);
  });

  it("gives Safari a non-persistent background page and nothing of the others' (NP-119)", () => {
    const safari = manifest("safari", { dev: true, key: "a key" });
    expect(safari.version).toBe(VERSION);
    expect(safari.manifest_version).toBe(3);
    expect(safari.background).toEqual({ scripts: ["worker.js"], type: "module", persistent: false });
    expect(safari.permissions).toEqual(["activeTab", "scripting", "storage", "alarms", "nativeMessaging", "menus", "unlimitedStorage"]);
    expect(safari.optional_permissions).toEqual(["tabs"]);
    expect(safari.commands["quick-search"].suggested_key).toEqual({ default: "Alt+Shift+D" });
    expect(safari.options_ui).toEqual({ page: "options.html", open_in_tab: true });
    expect(safari.default_locale).toBe("en");
    expect(safari.browser_specific_settings).toEqual({ safari: { strict_min_version: safariMinVersion } });
    for (const key of ["key", "minimum_chrome_version"]) expect(safari, key).not.toHaveProperty(key);
  });

  it("keeps the Chromium and Firefox manifests", () => {
    expect(manifest("chrome", { dev: true, key: "k" })).toMatchObject({ key: "k", minimum_chrome_version: "120" });
    expect(manifest("chrome")).not.toHaveProperty("key");
    expect(manifest("edge").background).toEqual({ service_worker: "worker.js", type: "module" });
    expect(manifest("firefox").background).toEqual({ scripts: ["worker.js"], type: "module" });
    expect(manifest("firefox").browser_specific_settings).toHaveProperty("gecko");
  });

  it("gives every browser the Save to Reading shortcut, apart from the search's (NP-125)", () => {
    for (const browser of [...browsers, ...localBrowsers]) {
      const { commands } = manifest(browser);
      expect(commands["save-to-reading"], browser).toEqual({
        suggested_key: { default: "Alt+Shift+R" },
        description: "__MSG_commandReading__",
      });
      const keys = Object.values(commands).map((command) => command.suggested_key.default);
      expect(new Set(keys).size, browser).toBe(keys.length);
      // Chrome takes at most four suggested shortcuts.
      expect(keys.length, browser).toBeLessThanOrEqual(4);
    }
  });
});

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
    const app = readdirSync(path.join(here, "../../src/locales"))
      .map((file) => file.replace(/\.json$/, ""))
      .filter((code) => code !== "sr-Latn")
      .map((code) => code.replace("-", "_"));
    expect(codes.sort()).toEqual(app.sort());
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
  it("names each catalog's language with a tag Intl accepts (NP-090)", () => {
    for (const code of codes) {
      const tag = catalog(code).languageCode.message;
      expect(tag, code).toBe(code.replace("_", "-"));
      expect(Intl.getCanonicalLocales(tag), code).toEqual([tag]);
    }
    // Outside a browser t() returns the key, which is no language: dates still format.
    expect(textLanguage()).toBe("en");
    expect(() => new Date().toLocaleDateString(textLanguage())).not.toThrow();
  });
  it("fits store limits: name 75 characters, description 132", () => {
    for (const messages of codes.map(catalog)) {
      expect(messages.extensionName.message.length).toBeLessThanOrEqual(75);
      expect(messages.extensionDescription.message.length).toBeLessThanOrEqual(132);
    }
  });
});
