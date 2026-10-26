import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { starterLinks } from "./starter";

describe("starter links (NP-117)", () => {
  it("are web pages in the order of the set: Koona Pin, then Firefox and Bun", () => {
    const links = starterLinks(i18n.getFixedT("en"));
    expect(links.map((l) => l.url)).toEqual([
      "https://koona.app/pin/help/getting-started/",
      "https://www.firefox.com/",
      "https://bun.com/",
    ]);
    expect(links.slice(-2).map((l) => l.title)).toEqual(["Firefox", "Bun"]);
  });

  // English is enough: locales.test.ts keeps every other language's keys in step with it.
  it("have a title and a description", () => {
    for (const link of starterLinks(i18n.getFixedT("en"))) {
      expect(link.title, link.url).not.toMatch(/^starter\./);
      expect(link.description, link.url).not.toMatch(/^starter\./);
      expect(link.description.length).toBeGreaterThan(0);
    }
  });
});
