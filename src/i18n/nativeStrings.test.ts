import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { androidStrings, resFolder, valuesFolder } from "./androidStrings";
import { iosStrings, lproj, stringsFolder } from "./iosStrings";

const root = path.join(__dirname, "..", "..");
const locales = path.join(root, "src", "locales");
const catalogs = Object.fromEntries(
  readdirSync(locales)
    .filter((file) => file.endsWith(".json"))
    .map((file) => [file.replace(/\.json$/, ""), JSON.parse(readFileSync(path.join(locales, file), "utf8"))]),
);

describe("androidStrings", () => {
  const expected = androidStrings(catalogs);
  const res = path.join(root, resFolder);

  it.each([...expected.keys()])("%s is what bun run locales:android writes", (file) => {
    const target = path.join(res, file);
    expect(existsSync(target), `${file} is missing: run bun run locales:android`).toBe(true);
    expect(readFileSync(target, "utf8").replace(/\r\n/g, "\n"), "run bun run locales:android").toBe(expected.get(file));
  });

  it("leaves no strings of a language that is gone", () => {
    const written = readdirSync(res).filter((folder) => existsSync(path.join(res, folder, "strings.xml")));
    expect(written.sort()).toEqual([...expected.keys()].map((file) => path.dirname(file)).sort());
  });

  it("names the languages as Android does", () => {
    expect(["en", "de", "pt-BR", "zh-CN", "sr", "sr-Latn"].map(valuesFolder)).toEqual([
      "values",
      "values-de",
      "values-pt-rBR",
      "values-zh-rCN",
      "values-sr",
      "values-b+sr+Latn",
    ]);
  });

  it("escapes what Android reads specially and numbers the placeholders", () => {
    const catalog = (share: Record<string, string>) => ({ phone: { share } });
    const files = androidStrings({
      en: catalog({ saved: "Couldn't save \"it\" & more", inInbox: "In Inbox · {{host}} {{other}}", done: "@done" }),
      de: catalog({ saved: "<b>", inInbox: "{{other}} vor {{host}}", done: "?" }),
    });
    expect(files.get("values/strings.xml")).toContain(`<string name="koona_share_saved">Couldn\\'t save \\"it\\" &amp; more</string>`);
    expect(files.get("values/strings.xml")).toContain(`<string name="koona_share_in_inbox">In Inbox · %1$s %2$s</string>`);
    expect(files.get("values/strings.xml")).toContain(`<string name="koona_share_done">\\@done</string>`);
    expect(files.get("values-de/strings.xml")).toContain(`<string name="koona_share_saved">&lt;b&gt;</string>`);
    expect(files.get("values-de/strings.xml")).toContain(`<string name="koona_share_in_inbox">%2$s vor %1$s</string>`);
    expect(files.get("values-de/strings.xml")).toContain(`<string name="koona_share_done">\\?</string>`);
  });
});

describe("iosStrings", () => {
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
});
