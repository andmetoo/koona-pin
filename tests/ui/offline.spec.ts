import { test, expect, Page } from "@playwright/test";

// NP-126 (frames O1–O5): an offline copy saved from the list, its marker left of the heart,
// the «Offline» section, the copy opened in the reader with no request, and removed again.
// The preview keeps copies in memory: nothing here reloads the page after saving.

async function boot(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.removeItem("koonapin.demo.v4");
    localStorage.removeItem("koonapin.demo.readingSaveOffline");
    localStorage.setItem("koonapin.theme", "light");
    localStorage.setItem("koonapin.language", "en");
    localStorage.setItem("koonapin.view", "list");
  });
  await page.reload();
  await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
  // Every page the reader asks for is counted: a copy opens without one.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const w = window as unknown as { asked: string[] };
    w.asked = [];
    const original = api.fetchReaderPage;
    api.fetchReaderPage = async (url: string) => {
      w.asked.push(url);
      return original(url);
    };
  });
}
const asked = (page: Page) => page.evaluate(() => (window as unknown as { asked: string[] }).asked);
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Library" });
const offlineNav = (page: Page) => sidebar(page).getByRole("button", { name: /^Offline/ });

test("save for offline from a row, the marker, the Offline section, the copy in the reader, remove (NP-126)", async ({ page }) => {
  await boot(page);
  await expect(offlineNav(page)).toHaveCount(0);
  const row = page.locator("[data-bookmark-id]").first();
  const id = await row.getAttribute("data-bookmark-id");
  const title = (await row.locator("h2").textContent())!.trim();

  // O1: the outline «Save offline» shows on hover, left of the heart.
  await row.hover();
  await row.locator("[data-offline-save]").click();
  await expect(page.getByText("Saved for offline").first()).toBeVisible();
  await expect(row.locator("[data-offline-marker]")).toBeVisible();
  await expect(row.locator("[data-offline-save]")).toHaveCount(0);
  await expect(offlineNav(page)).toContainText("1");

  // O2: the menu says it the other way round now; O saves another one.
  const second = page.locator("[data-bookmark-id]").nth(1);
  await second.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Save for offline" })).toBeVisible();
  await page.keyboard.press("o");
  await expect(second.locator("[data-offline-marker]")).toBeVisible();
  await row.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Remove offline copy" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(offlineNav(page)).toContainText("2");

  // The section lists the bookmarks with a copy.
  await offlineNav(page).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(2);
  await expect(page.locator(`[data-bookmark-id="${id}"]`)).toBeVisible();

  // The reading sheet opens the copy without asking the site.
  const before = (await asked(page)).length;
  await page.locator(`[data-bookmark-id="${id}"] [data-collection]`).click();
  await page.keyboard.press(" ");
  const sheet = page.locator("dialog[data-reading-sheet]");
  await expect(sheet.locator(".reader-title")).toHaveText(title);
  await expect(sheet.locator(".reader-meta")).toContainText("offline copy");
  expect((await asked(page)).length).toBe(before);

  // O4: saved, the button opens «Update copy» / «Remove copy».
  const saved = sheet.locator("[data-offline-button=saved]");
  await saved.click();
  await page.getByRole("menuitem", { name: "Remove copy" }).click();
  await expect(page.getByText("Offline copy removed").first()).toBeVisible();
  // It left the section under the sheet, so the sheet goes with it, as for any bookmark that leaves.
  await expect(sheet).toHaveCount(0);
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);

  // The last one out: the section, still open, says what it is for; its row stays while it is open.
  await page.locator("[data-bookmark-id]").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove offline copy" }).click();
  await expect(page.getByText("No offline copies yet")).toBeVisible();
  await expect(offlineNav(page)).toContainText("0");
  await sidebar(page).getByRole("button", { name: /^All bookmarks/ }).click();
  await expect(offlineNav(page)).toHaveCount(0);
});

test("reading mode: «Save offline» keeps the article on screen; offline, the copy and its banner (NP-126)", async ({ page, context }) => {
  await boot(page);
  await page.locator("button[data-read-mode]").click();
  const mode = page.locator("[data-reading-mode]");
  await expect(mode.locator(".reader-title")).toBeVisible();
  const title = (await mode.locator(".reader-title").textContent())!.trim();
  const before = (await asked(page)).length;

  // O3: the article on screen is saved, no second request.
  await mode.locator("[data-offline-button=save]").click();
  await expect(mode.locator("[data-offline-button=saved]")).toBeVisible();
  expect((await asked(page)).length).toBe(before);

  // No connection: J and K come back to it, the copy shows with the banner under the bar.
  await context.setOffline(true);
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  await expect(mode.locator(".reader-title")).toHaveText(title);
  await expect(mode.locator(".reader-meta")).toContainText("offline copy");
  const banner = mode.locator("[data-offline-banner]");
  await expect(banner).toContainText("No connection — reading the offline copy saved");
  await expect(banner.getByRole("button", { name: "Try live page" })).toBeVisible();
  await context.setOffline(false);
  await expect(banner).toHaveCount(0);

  // Settings → Reading → Offline copies (O5): the count, then «Remove all copies» after a confirmation.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(mode).toHaveCount(0);
  await page.getByRole("button", { name: "Settings" }).first().click();
  const stats = page.locator("[data-settings-offline=stats]");
  await expect(stats).toContainText("Saved for offline — 1 article");
  await page.getByRole("button", { name: "Remove…" }).click();
  const dialog = page.getByRole("dialog", { name: "Remove all offline copies?" });
  await expect(dialog).toContainText("1 saved article will be deleted from this computer");
  await dialog.getByRole("button", { name: "Remove copies" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(stats).toContainText("Saved for offline — 0 articles");
});
