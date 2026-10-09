import { describe, expect, it } from "vitest";
import i18n, { languages } from "../i18n";
import { starterLinks } from "./starter";

describe("starter links (NP-117)", () => {
  it("are web pages in the order of the set: Koona, Koona Pin, then Firefox, Bun and Lunacy", () => {
    const links = starterLinks(i18n.getFixedT("en"));
    expect(links.map((l) => l.url)).toEqual([
      "https://koona.app/",
      "https://koona.app/pin/#how",
      "https://www.firefox.com/",
      "https://bun.com/",
      "https://www.lunacyapp.com/",
    ]);
    expect(links.slice(-3).map((l) => l.title)).toEqual(["Firefox", "Bun", "Lunacy"]);
  });

  it("have a title and a description in every language of the app", () => {
    for (const { code } of languages) {
      const t = i18n.getFixedT(code);
      for (const link of starterLinks(t)) {
        expect(link.title, `${code} ${link.url}`).not.toMatch(/^starter\./);
        expect(link.description, `${code} ${link.url}`).not.toMatch(/^starter\./);
        expect(link.description.length).toBeGreaterThan(0);
      }
    }
  });
});
