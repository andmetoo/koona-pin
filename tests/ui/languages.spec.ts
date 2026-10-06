import { test, expect, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const locales = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "locales");

// Key screens in the longest language and in Serbian (NP-089): snapshots to look at,
// not baselines, and a check that no interface label is cut off.
type Catalog = { [key: string]: string | Catalog };
const catalog = (code: string): Catalog =>
  JSON.parse(readFileSync(path.join(locales, `${code}.json`), "utf8"));
const text = (c: Catalog, key: string) => key.split(".").reduce<string | Catalog>((node, k) => (node as Catalog)[k], c) as string;
/** A label as a whole-text pattern: «(», «+», «?» in it are letters. */
const exactly = (label: string, whole = true) =>
  new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${whole ? "$" : ""}`);

/** Interface text that is cut off: wider or taller than its box, with the overflow hidden. Bookmark data may be cut. */
async function cutLabels(page: Page) {
  return page.evaluate(() => {
    const cut: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      if (el.closest("[data-bookmark-id], [data-user-text]") || !el.offsetParent || !el.textContent!.trim()) continue;
      const style = getComputedStyle(el);
      const hides = style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none";
      // scrollWidth is rounded: a text 0.4 px too wide gets its ellipsis but not a wider scrollWidth.
      const range = document.createRange();
      range.selectNodeContents(el);
      const room =
        el.getBoundingClientRect().width -
        ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"].reduce((sum, side) => sum + parseFloat(style[side as "paddingLeft"]), 0);
      const wide = range.getBoundingClientRect().width > room + 0.05;
      const tall = style.webkitLineClamp !== "none" && el.scrollHeight > el.clientHeight + 1;
      if (hides && (wide || tall)) cut.push(el.textContent!.trim().slice(0, 80));
    }
    return cut;
  });
}

// The sidebar shows one browser status of several, and the demo has only one of them: every row's
// words in every language are measured against the row's room in the English layout.
test("sidebar rows fit in every language", { tag: "@languages" }, async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 800 });
  await page.addInitScript(() => localStorage.removeItem("netamipin.demo.v4"));
  await page.goto("/");
  await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const en = catalog("en");
  const rows: Record<string, string[]> = {
    "nav.inbox": ["nav.inbox"],
    "nav.all": ["nav.all"],
    "nav.favorites": ["nav.favorites"],
    "nav.trash": ["nav.trash"],
    "nav.settings": ["nav.settings"],
    "browser.notConnected": ["browser.ready", "browser.failing", "browser.checking", "browser.notConnected", "browser.lost", "browser.update", "browser.updateApp"],
  };
  const room: Record<string, { width: number; font: string }> = {};
  for (const key of Object.keys(rows)) {
    const label = page.locator("aside button span.truncate", { hasText: exactly(text(en, key)) }).first();
    room[key] = await label.evaluate((el) => ({ width: el.clientWidth, font: getComputedStyle(el).font }));
  }
  /** The text as the app shows it: the plural form the language picks for days the status can show. */
  const words = (code: string, key: string): string[] => {
    const [section, name] = key.split(".");
    const node = catalog(code)[section] as Catalog;
    if (typeof node[name] === "string") return [node[name] as string];
    const rules = new Intl.PluralRules(code);
    return [1, 2, 5, 21, 30].map((n) => (node[`${name}_${rules.select(n)}`] as string).replace("{{count}}", String(n)));
  };
  const all = codes.flatMap((code) =>
    Object.entries(rows).flatMap(([row, keys]) =>
      [...new Set(keys.flatMap((key) => words(code, key)))].map((word) => ({ code, row, word, ...room[row] })),
    ),
  );
  // One canvas, one round trip for every word.
  const widths = await page.evaluate((all) => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    return all.map(({ word, font }) => ((ctx.font = font), ctx.measureText(word).width));
  }, all);
  const wide = all
    .map((w, i) => ({ ...w, measured: widths[i] }))
    .filter((w) => w.measured > w.width)
    .map((w) => `${w.code} ${w.row}: «${w.word}» ${Math.ceil(w.measured)} > ${w.width}`);
  expect(wide).toEqual([]);
});

// Every language is checked for cut labels; German and Serbian also leave snapshots to look at.
const codes = readdirSync(locales).map((file) => file.replace(/\.json$/, ""));
const snapshots = ["de", "sr"];

for (const code of codes) {
  const t = (key: string) => text(catalog(code), key);
  for (const [width, height] of [
    [800, 550],
    [1600, 800],
  ]) {
    test(`${code} key screens ${width}×${height}`, { tag: "@languages" }, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript((language) => {
        localStorage.removeItem("netamipin.demo.v4");
        localStorage.setItem("netamipin.language", language);
      }, code);
      await page.clock.setFixedTime(new Date(2026, 9, 3, 12, 0));
      await page.goto("/");
      await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);

      const found: Record<string, string[]> = {};
      const shot = async (name: string) => {
        found[name] = await cutLabels(page);
        if (!snapshots.includes(code)) return;
        const file = info.outputPath(`${name}.png`);
        await page.screenshot({ path: file, animations: "disabled" });
        await info.attach(name, { path: file, contentType: "image/png" });
      };

      await shot("grid");
      await page.getByRole("button", { name: t("toolbar.list"), exact: true }).click();
      await shot("list");

      await page.locator("[data-bookmark-id]").first().click({ modifiers: ["Control"] });
      await page.locator("[data-bookmark-id]").nth(1).click({ modifiers: ["Control"] });
      await shot("selection");
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: t("toolbar.add") }).first().click();
      await shot("add-dialog");
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: exactly(t("nav.inbox"), false) }).first().click();
      await page.getByRole("button", { name: t("inbox.sort"), exact: true }).first().click();
      await shot("triage");
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: t("nav.settings") }).first().click();
      await shot("settings");

      expect(found).toEqual(Object.fromEntries(Object.keys(found).map((k) => [k, []])));
    });
  }
}
