// Writes src/locales/sr-Latn.json from sr.json, letter by letter (NP-089).
// Run after any change to sr.json: npm run locales:sr-latn
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { latinCatalog } from "../src/i18n/serbianLatin.ts";

const locales = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "locales");
const cyrillic = JSON.parse(await readFile(path.join(locales, "sr.json"), "utf8"));
await writeFile(path.join(locales, "sr-Latn.json"), JSON.stringify(latinCatalog(cyrillic), null, 2) + "\n");
console.log("src/locales/sr-Latn.json written from sr.json");
