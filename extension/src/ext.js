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
