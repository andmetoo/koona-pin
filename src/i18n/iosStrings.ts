// The share extension on iOS (koona-share) is native, without the page: its words are the
// extension's Localizable.strings, made from `phone.share` of every catalog in src/locales, as
// Android's are (androidStrings.ts). `bun run locales:ios` writes them; a test keeps them in step
// (iosStrings.test.ts).

type Catalog = { [key: string]: string | Catalog };

/** Where the `.lproj` folders go, from the repository's root. */
export const stringsFolder = "src-tauri/plugins/koona-share/ios-extension/Strings";

/** The `.lproj` of a catalog's language: `en.lproj`, `pt-BR.lproj`, `zh-Hans.lproj`, `sr-Latn.lproj`. */
export function lproj(code: string): string {
  if (code === "zh-CN") return "zh-Hans.lproj";
  return `${code}.lproj`;
}

/** A string as Foundation reads it: quotes, backslashes and line ends escaped, `{{name}}` as `%n$@`. */
function stringsText(text: string, order: string[]): string {
  const placeholders = /\{\{\s*(\w+)\s*\}\}/g;
  const formatted = placeholders.test(text);
  let out = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  if (formatted) out = out.replace(/%/g, "%%");
  return out.replace(placeholders, (_, name: string) => {
    const at = order.indexOf(name);
    if (at < 0) throw new Error(`{{${name}}} is not in the English string`);
    return `%${at + 1}$@`;
  });
}

/** The English string's placeholders in the order they come: their numbers in every language. */
const placeholderOrder = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);

/** The Localizable.strings of every catalog, by their path under {@link stringsFolder}. */
export function iosStrings(catalogs: Record<string, Catalog>): Map<string, string> {
  const section = (code: string) => {
    const share = (catalogs[code].phone as Catalog | undefined)?.share;
    if (!share || typeof share === "string") throw new Error(`${code}.json has no phone.share`);
    return share as Record<string, string>;
  };
  const english = section("en");
  const files = new Map<string, string>();
  for (const code of Object.keys(catalogs).sort()) {
    const strings = section(code);
    const lines = Object.keys(english).map(
      (key) => `"${key}" = "${stringsText(strings[key] ?? english[key], placeholderOrder(english[key]))}";`,
    );
    files.set(
      `${lproj(code)}/Localizable.strings`,
      [`/* Written from src/locales/${code}.json (phone.share) by \`bun run locales:ios\`; do not edit. */`, ...lines, ""].join(
        "\n",
      ),
    );
  }
  return files;
}
