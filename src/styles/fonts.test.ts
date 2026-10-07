import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The system fonts for Chinese, Japanese and Korean after Inter (NP-090) are written in four
// places that share no code: the app, the extension's pages, its message on a web page and the
// site. They must name the same fonts in the same order.
const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
/** The font names of a family list, without Inter and the generic families. */
const names = (list: string) =>
  list
    .split(",")
    .map((name) => name.trim().replace(/^"|"$/g, ""))
    .filter((name) => name && !["Inter", "Inter Variable", "system-ui", "sans-serif"].includes(name));
/** The font list of each `:lang(xx)` rule, from the property that holds it. */
function stacks(css: string, property: string) {
  const out: Record<string, string[]> = {};
  for (const [, lang, body] of css.matchAll(/:lang\((zh|ja|ko)\)\s*\{([^}]*)\}/g)) {
    const value = body.match(new RegExp(`${property}:\\s*([^;]+);`))?.[1];
    if (value) out[lang] = names(value);
  }
  return out;
}

describe("CJK font stacks", () => {
  const app = stacks(read("src/styles/app.css"), "--np-font");
  it("are defined for the three languages", () => {
    expect(Object.keys(app).sort()).toEqual(["ja", "ko", "zh"]);
    for (const list of Object.values(app)) expect(list.length).toBeGreaterThan(1);
  });
  it("are the same in the extension's pages", () => {
    expect(stacks(read("extension/src/languages.css"), "font-family")).toEqual(app);
  });
  it("are the same on the site", () => {
    expect(stacks(read("site/src/site.css"), "--font")).toEqual(app);
  });
  it("are the same in the extension's message on a page", () => {
    const source = read("extension/src/feedback.js");
    const toast = Object.fromEntries(
      [...source.matchAll(/^\s*(zh|ja|ko): '([^']+)',$/gm)].map(([, lang, list]) => [lang, names(list)]),
    );
    expect(toast).toEqual(app);
  });
});
