import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { languages } from "../../scripts/lib/site.mjs";
// A copy of the site's pin/content/help/app-links.json (andmetoo/koona-site): update it when a link is added there.
import appLinks from "../../tests/fixtures/site/app-links.json";
import { licensesUrl, privacyUrl } from "./feedback";
import { HELP, helpUrl, HelpTopic } from "./help";
import { megabytes, notesUrl, offer, percent } from "./update";

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

describe("licensesUrl", () => {
  it("opens the licenses page of the site in the interface's language (NP-040)", () => {
    expect(licensesUrl("en")).toBe("https://koona.app/pin/licenses");
    expect(licensesUrl("sr")).toBe("https://koona.app/pin/sr/licenses");
    expect(licensesUrl("pt-BR")).toBe("https://koona.app/pin/pt-br/licenses");
    expect(licensesUrl("he")).toBe("https://koona.app/pin/licenses");
  });
});

describe("help links", () => {
  it("are all on the site's list, whose pages and anchors its build keeps (NP-092)", () => {
    for (const path of Object.values(HELP)) expect(appLinks.links, path).toContain(path);
  });

  it("lead to koona.app/pin/help/", () => {
    expect(helpUrl("home")).toBe("https://koona.app/pin/help/");
    expect(helpUrl("libraryWontOpen")).toBe("https://koona.app/pin/help/troubleshooting/#the-library-wont-open");
    for (const topic of Object.keys(HELP) as HelpTopic[]) expect(helpUrl(topic)).toMatch(/^https:\/\/koona\.app\/pin\/help\/([a-z-]+\/)?(#[a-z-]+)?$/);
  });
});

describe("the app update (sheet 42)", () => {
  it("shows the row only while a new version is in play", () => {
    expect(offer(null)).toBeNull();
    expect(offer({ state: "unknown" })).toBeNull();
    expect(offer({ state: "checking" })).toBeNull();
    expect(offer({ state: "up_to_date", checked_at: "2026-10-08T12:00:00Z" })).toBeNull();
    expect(offer({ state: "check_failed", checked_at: "2026-10-08T12:00:00Z" })).toBeNull();
    expect(offer({ state: "pacman" })).toBeNull();
    for (const status of [
      { state: "available", version: "0.3.0", notes: [] as string[], notes_url: "https://example.com" },
      { state: "downloading", version: "0.3.0", received: 1, total: 2 },
      { state: "installing", version: "0.3.0" },
      { state: "failed", version: "0.3.0", problem: "no_connection" },
    ] as const) {
      expect(offer(status)?.version).toBe("0.3.0");
    }
  });

  it("counts whole percent and none without a size", () => {
    expect(percent({ state: "downloading", version: "0.3.0", received: 4_100_000, total: 9_800_000 })).toBe(41);
    expect(percent({ state: "downloading", version: "0.3.0", received: 5, total: null })).toBeNull();
    expect(percent({ state: "downloading", version: "0.3.0", received: 12, total: 10 })).toBe(100);
    expect(percent({ state: "installing", version: "0.3.0" })).toBeNull();
  });

  it("writes sizes in megabytes of the language", () => {
    expect(megabytes(4_100_000, "en")).toBe("4.1 MB");
    expect(megabytes(9_800_000, "ru")).toMatch(/^9,8\sМБ$/);
  });

  it("opens the offered version in the site's changelog", () => {
    expect(notesUrl({ state: "available", version: "0.3.0", notes: ["Faster search."], notes_url: "https://koona.app/pin/changelog/#0.3.0" })).toBe(
      "https://koona.app/pin/changelog/#0.3.0",
    );
    expect(notesUrl({ state: "failed", version: "0.3.1", problem: "bad_signature" })).toBe("https://koona.app/pin/changelog/#0.3.1");
  });
});
