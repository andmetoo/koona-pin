import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { languages } from "../../site/src/content.mjs";
import { privacyUrl } from "./feedback";

const appLanguages = readdirSync(new URL("../locales/", import.meta.url)).map((f) => f.replace(/\.json$/, ""));

describe("privacyUrl", () => {
  it("opens the policy in every language of the app that the site has (NP-107)", () => {
    for (const code of appLanguages) {
      // The site has one Serbian, in Latin script: both Serbian interfaces lead there.
      const site = languages.find((l) => l.lang === (code === "sr" ? "sr-Latn" : code));
      expect(site, `${code} has no page on the site`).toBeDefined();
      expect(privacyUrl(code), code).toBe(`https://koona.app/pin/${site!.dir}privacy`);
    }
  });
  it("falls back to English for a language the site lacks", () => {
    expect(privacyUrl("he")).toBe("https://koona.app/pin/privacy");
    expect(privacyUrl("constructor")).toBe("https://koona.app/pin/privacy");
  });
});
