// Writes the share sheet's Android strings (koona-share) from phone.share of src/locales.
// Run after any change to those keys: bun run locales:android
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { androidStrings, resFolder } from "../src/i18n/androidStrings.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const locales = path.join(root, "src", "locales");
const catalogs = {};
for (const file of (await readdir(locales)).filter((name) => name.endsWith(".json"))) {
  catalogs[file.replace(/\.json$/, "")] = JSON.parse(await readFile(path.join(locales, file), "utf8"));
}
for (const [file, text] of androidStrings(catalogs)) {
  const target = path.join(root, resFolder, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
}
console.log(`${resFolder}/values*/strings.xml written from src/locales`);
