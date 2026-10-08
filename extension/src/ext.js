// Chrome and Edge expose the extension API as `chrome`, Firefox as `browser`
// (and a `chrome` alias). Both return promises in Manifest V3.
export const ext = globalThis.browser ?? globalThis.chrome;

/**
 * A message from _locales in the browser's language (English by default).
 * Outside a browser, in unit tests, it returns the key.
 */
export function t(key, ...substitutions) {
  return ext?.i18n?.getMessage(key, substitutions.map(String)) || key;
}

let platform;
/**
 * The system the browser runs on: «linux», «win», «mac»… (NP-054). On Linux an
 * unreachable app may as well be a sandboxed browser (Flatpak, Chromium from
 * Snap), so the pages say both, calmly. Asked once per page; "" when unknown.
 */
export function systemName() {
  platform ??= Promise.resolve(ext?.runtime?.getPlatformInfo?.()).then(
    (info) => info?.os ?? "",
    () => "",
  );
  return platform;
}

/**
 * The language of the catalog the text comes from (NP-090): a zh-TW browser
 * reads English. Without the message — outside a browser — the browser's
 * language, else English: never a tag `Intl` rejects.
 */
export function textLanguage() {
  for (const code of [t("languageCode"), ext?.i18n?.getUILanguage?.(), "en"]) {
    try {
      if (code && Intl.getCanonicalLocales(code).length) return code;
    } catch {
      /* not a language tag: the next one */
    }
  }
  return "en";
}
