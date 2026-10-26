import { expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { iosStrings, lproj, stringsFolder } from "./iosStrings";

const root = path.join(__dirname, "..", "..");
const locales = path.join(root, "src", "locales");
const catalogs = Object.fromEntries(
  readdirSync(locales)
    .filter((file) => file.endsWith(".json"))
    .map((file) => [file.replace(/\.json$/, ""), JSON.parse(readFileSync(path.join(locales, file), "utf8"))]),
);
const expected = iosStrings(catalogs);
const folder = path.join(root, stringsFolder);

it.each([...expected.keys()])("%s is what bun run locales:ios writes", (file) => {
  const target = path.join(folder, file);
  expect(existsSync(target), `${file} is missing: run bun run locales:ios`).toBe(true);
  expect(readFileSync(target, "utf8").replace(/\r\n/g, "\n"), "run bun run locales:ios").toBe(expected.get(file));
});

it("leaves no strings of a language that is gone", () => {
  const written = readdirSync(folder).filter((name) => existsSync(path.join(folder, name, "Localizable.strings")));
  expect(written.sort()).toEqual([...expected.keys()].map((file) => path.dirname(file)).sort());
});

it("names the languages as iOS does", () => {
  expect(["en", "de", "pt-BR", "zh-CN", "sr", "sr-Latn"].map(lproj)).toEqual([
    "en.lproj",
    "de.lproj",
    "pt-BR.lproj",
    "zh-Hans.lproj",
    "sr.lproj",
    "sr-Latn.lproj",
  ]);
});

it("escapes what Foundation reads specially and numbers the placeholders", () => {
  const catalog = (share: Record<string, string>) => ({ phone: { share } });
  const files = iosStrings({
    en: catalog({ saved: 'Couldn\'t save "it" \\ 100%', inInbox: "In Inbox · {{host}} {{other}} 5%" }),
    de: catalog({ saved: "a\nb", inInbox: "{{other}} vor {{host}}" }),
  });
  expect(files.get("en.lproj/Localizable.strings")).toContain(`"saved" = "Couldn't save \\"it\\" \\\\ 100%";`);
  expect(files.get("en.lproj/Localizable.strings")).toContain(`"inInbox" = "In Inbox · %1$@ %2$@ 5%%";`);
  expect(files.get("de.lproj/Localizable.strings")).toContain(`"saved" = "a\\nb";`);
  expect(files.get("de.lproj/Localizable.strings")).toContain(`"inInbox" = "%2$@ vor %1$@";`);
});
