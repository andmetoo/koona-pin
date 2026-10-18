import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dropPoint } from "../fixtures/app";

// Baselines of iteration 1 (NP-010, grid and list of NP-012); compare with frames 01, 02, 06, 07, 16.
for (const width of [800, 1200, 1600]) {
  for (const theme of ["light", "dark"]) {
    for (const view of ["grid", "list"]) {
      test(`library ${theme} ${view} ${width}`, { tag: "@visual" }, async ({ page }) => {
        await page.setViewportSize({
          width,
          height: width === 800 ? 550 : 800,
        });
        await page.addInitScript(
          ({ theme, view }) => {
            localStorage.removeItem("koonapin.demo.v4");
            localStorage.setItem("koonapin.theme", theme);
            localStorage.setItem("koonapin.view", view);
          },
          { theme, view },
        );
        // Date groups and short dates depend on today: a fixed day keeps the baselines.
        await page.clock.setFixedTime(new Date(2026, 9, 3, 12, 0));
        await page.goto("/");
        await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
        await page.evaluate(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(`${theme}-${view}-${width}.png`, {
          animations: "disabled",
          maxDiffPixelRatio: 0.002,
        });
      });
    }
  }
}

// The bundle, the drop zone and the list preview (share-bundle.md, K5–K10) at 1200×800; compare
// with frames K5, K6a, K6b, K7a, K7b, K9a and K10a.
const here = path.dirname(fileURLToPath(import.meta.url));
const validList = readFileSync(path.join(here, "..", "..", "src-tauri", "tests", "fixtures", "kpin", "valid.kpin"), "utf8");
const selectionBar = (page: Page) => page.getByRole("toolbar", { name: "Selected bookmarks" });

async function openLibrary(page: Page, theme: string) {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.addInitScript((theme) => {
    localStorage.removeItem("koonapin.demo.v4");
    localStorage.setItem("koonapin.theme", theme);
    localStorage.setItem("koonapin.view", "grid");
  }, theme);
  await page.clock.setFixedTime(new Date(2026, 9, 3, 12, 0));
  await page.goto("/");
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
  await page.evaluate(() => document.fonts.ready);
}
/** The first three bookmarks into the bundle by Export → Add to bundle; the selection is let go. */
async function addThree(page: Page) {
  const cards = page.locator("[data-bookmark-id]");
  for (let i = 0; i < 3; i++) await cards.nth(i).locator("h2").first().click({ modifiers: ["ControlOrMeta"] });
  await selectionBar(page).getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: /^Add to bundle/ }).click();
  await page.keyboard.press("Escape");
  await expect(selectionBar(page)).toHaveCount(0);
  // The count has rolled to 3.
  await expect(page.locator("[data-bundle-count] > span")).toHaveCount(1);
  await page.mouse.move(0, 0);
}
const same = (page: Page, name: string) => expect(page).toHaveScreenshot(name, { animations: "disabled", maxDiffPixelRatio: 0.002 });

for (const theme of ["light", "dark"]) {
  test(`more menu ${theme}`, { tag: "@visual" }, async ({ page }) => {
    await openLibrary(page, theme);
    await page.getByRole("button", { name: "More", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: /^Import a file…/ })).toBeVisible();
    await same(page, `more-menu-${theme}-1200.png`);
  });

  test(`bundle capsule ${theme}`, { tag: "@visual" }, async ({ page }) => {
    await openLibrary(page, theme);
    await addThree(page);
    await same(page, `bundle-capsule-${theme}-1200.png`);
    // A bookmark dragged over it: the capsule widens to say what the drop does.
    const card = page.locator("[data-bookmark-id]").nth(4);
    await card.locator("h2").first().click({ modifiers: ["ControlOrMeta"] });
    const from = (await card.locator("[data-preview]").boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 8, { steps: 3 });
    const capsule = page.locator("[data-bundle-capsule]");
    const to = (await capsule.boundingBox())!;
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
    await expect(capsule).toContainText("Add 1 bookmark to bundle");
    await same(page, `bundle-capsule-over-${theme}-1200.png`);
    await page.mouse.up();
  });

  test(`bundle panel ${theme}`, { tag: "@visual" }, async ({ page }) => {
    await openLibrary(page, theme);
    await addThree(page);
    await page.locator("[data-bundle-capsule] > button").first().click();
    await expect(page.locator("[data-bundle-panel] [data-bundle-row]")).toHaveCount(3);
    await same(page, `bundle-panel-${theme}-1200.png`);
  });

  test(`bundle panel empty ${theme}`, { tag: "@visual" }, async ({ page }) => {
    await openLibrary(page, theme);
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Share as list…/ }).click();
    await expect(page.locator("[data-bundle-panel] [data-bundle-empty] button")).toBeFocused();
    await same(page, `bundle-empty-${theme}-1200.png`);
  });

  test(`drop zone ${theme}`, { tag: "@visual" }, async ({ page }) => {
    await openLibrary(page, theme);
    const at = await dropPoint(page);
    // A file from outside, as a webview shows it before the drop: no name, so the hero (K9a).
    await page.evaluate((at) => {
      const event = new DragEvent("dragenter", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y });
      Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [], items: [{ kind: "file", type: "" }], dropEffect: "unset" } });
      document.elementFromPoint(at.x, at.y)!.dispatchEvent(event);
    }, at);
    await expect(page.locator("[data-drop-zone]")).toHaveAttribute("data-drop-zone", "hero");
    await same(page, `drop-zone-${theme}-1200.png`);
  });

  test(`list import preview ${theme}`, { tag: "@visual" }, async ({ page }) => {
    await openLibrary(page, theme);
    await page.evaluate(async (text) => {
      const { openRequests } = await import("/src/services/openRequests.ts");
      openRequests.push({ kind: "kpin", name: "rust-blogs.kpin", text });
    }, validList);
    const dialog = page.getByRole("dialog", { name: "Import list" });
    await expect(dialog.locator("[data-list-counts]")).toHaveText("3 links · 2 feeds · 2 sections — 3 new");
    await same(page, `list-preview-${theme}-1200.png`);
  });
}
