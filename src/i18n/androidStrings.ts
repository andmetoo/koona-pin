// The share sheet on Android (koona-share) is native, without the page: its words are Android
// string resources, made from `phone.share` of every catalog in src/locales. `bun run
// locales:android` writes them; a test keeps them in step (androidStrings.test.ts).

type Catalog = { [key: string]: string | Catalog };

/** Where the resources go, from the repository's root. */
export const resFolder = "src-tauri/plugins/koona-share/android/src/main/res";

/** Android's resource folder of a catalog's language: `values-de`, `values-pt-rBR`, `values-b+sr+Latn`. */
export function valuesFolder(code: string): string {
  if (code === "en") return "values";
  const [language, ...rest] = code.split("-");
  if (rest.length === 0) return `values-${language}`;
  if (rest.length === 1 && /^[A-Z]{2}$/.test(rest[0])) return `values-${language}-r${rest[0]}`;
  return `values-b+${[language, ...rest].join("+")}`;
}

/** `inInbox` → `koona_share_in_inbox`. */
const resourceName = (key: string) => `koona_share_${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`;

/** A string as Android reads it: XML escaped, quotes and a leading `@` or `?` backslashed, `{{name}}` as `%n$s`. */
function resourceText(text: string, order: string[]): string {
  const placeholders = /\{\{\s*(\w+)\s*\}\}/g;
  const formatted = placeholders.test(text);
  let out = text
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
  if (formatted) out = out.replace(/%/g, "%%");
  out = out.replace(placeholders, (_, name: string) => {
    const at = order.indexOf(name);
    if (at < 0) throw new Error(`{{${name}}} is not in the English string`);
    return `%${at + 1}$s`;
  });
  return /^[@?]/.test(out) ? `\\${out}` : out;
}

/** The English string's placeholders in the order they come: their numbers in every language. */
const placeholderOrder = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);

/** The resource files of every catalog, by their path under {@link resFolder}. */
export function androidStrings(catalogs: Record<string, Catalog>): Map<string, string> {
  const section = (code: string) => {
    const share = (catalogs[code].phone as Catalog | undefined)?.share;
    if (!share || typeof share === "string") throw new Error(`${code}.json has no phone.share`);
    return share as Record<string, string>;
  };
  const english = section("en");
  const files = new Map<string, string>();
  for (const code of Object.keys(catalogs).sort()) {
    const strings = section(code);
    const lines = Object.keys(english).map((key) => {
      const text = strings[key] ?? english[key];
      return `    <string name="${resourceName(key)}">${resourceText(text, placeholderOrder(english[key]))}</string>`;
    });
    files.set(
      `${valuesFolder(code)}/strings.xml`,
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        `<!-- Written from src/locales/${code}.json (phone.share) by \`bun run locales:android\`; do not edit. -->`,
        "<resources>",
        ...lines,
        "</resources>",
        "",
      ].join("\n"),
    );
  }
  return files;
}
