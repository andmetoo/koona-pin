import { describe, expect, it } from "vitest";
// A copy of the site's pin/content/help/app-links.json (andmetoo/koona-site): update it when a link is added there.
import appLinks from "../../tests/fixtures/site/app-links.json";
import { HELP, helpUrl, HelpTopic } from "./help";

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
