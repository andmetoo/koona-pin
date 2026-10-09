import { describe, expect, it } from "vitest";
import i18n, { languages } from "../i18n";
import { starterLinks } from "./starter";

describe("starter links (NP-117)", () => {
  it("are web pages in the order of the set, Bun and Lunacy last", () => {
    const links = starterLinks(i18n.getFixedT("en"));
    expect(links.map((l) => new URL(l.url).hostname)).toEqual(["koona.app", "koona.app", "koona.app", "bun.com", "www.lunacyapp.com"]);
    expect(links.every((l) => l.url.startsWith("https://"))).toBe(true);
    expect(links.slice(-2).map((l) => l.title)).toEqual(["Bun", "Lunacy"]);
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
