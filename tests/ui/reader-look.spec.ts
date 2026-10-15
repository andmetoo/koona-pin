import { test, expect, Page, Locator } from "@playwright/test";

// NP-124 (Р-69, points 5, 7 and 9, frames B8 and B10): the Aa panel of the reading mode — size,
// column, theme, font — with Supporter's Paper, Sepia and fonts locked on a free plan, and
// Settings → Reading: how links open, «read» at the end, the R key.

const TITLES = ["Ten principles for good design", "The architecture of silence", "Typography is a voice", "Interfaces that stay out of the way"];

async function boot(page: Page, { plan = "free", theme = "light", width = 1440, height = 900 }: { plan?: "free" | "supporter"; theme?: string; width?: number; height?: number } = {}) {
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await page.evaluate(
    ({ plan, theme }) => {
      for (const key of Object.keys(localStorage)) if (key.startsWith("koonapin.")) localStorage.removeItem(key);
      localStorage.setItem("koonapin.demo.supporter", plan);
      localStorage.setItem("koonapin.theme", theme);
      localStorage.setItem("koonapin.language", "en");
      localStorage.setItem("koonapin.view", "grid");
    },
    { plan, theme },
  );
  await page.reload();
  await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
  await stubBrowser(page);
}

/** The browser is a list of addresses: nothing leaves the test. */
const stubBrowser = (page: Page) =>
  page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    (window as unknown as { opened: string[] }).opened = [];
    api.openUrl = async (url: string) => void (window as unknown as { opened: string[] }).opened.push(url);
  });
const opened = (page: Page) => page.evaluate(() => (window as unknown as { opened: string[] }).opened);

const mode = (page: Page) => page.locator("[data-reading-mode]");
const aa = (page: Page) => mode(page).locator("button[data-reader-aa]");
const panel = (page: Page) => page.getByRole("dialog", { name: "Text and theme" });
const swatch = (page: Page, theme: string) => panel(page).locator(`[data-reader-theme=${theme}]`);
const font = (page: Page, name: string) => panel(page).getByRole("radiogroup", { name: "Font" }).getByRole("radio", { name: new RegExp(`^${name}`) });

async function openMode(page: Page) {
  await page.locator("button[data-read-mode]").click();
  await expect(mode(page)).toBeVisible();
  await expect(mode(page).locator(".reader-title")).toBeVisible();
}
async function openPanel(page: Page) {
  await aa(page).click();
  await expect(panel(page)).toBeVisible();
}
const background = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor);

test("free: Paper and Sepia locked, a lock opens Supporter and the plan applies it at once; the choice survives a restart (NP-124, acceptance 1)", async ({ page }) => {
  await boot(page);
  await openMode(page);
  // B8: «Aa» before «Open in browser», 34 px, in the reading theme.
  await expect(aa(page)).toHaveCSS("width", "34px");
  await openPanel(page);
  // The default follows the app's theme: light → White.
  await expect(mode(page)).toHaveAttribute("data-reader-look", "white");
  await expect(swatch(page, "white")).toHaveAttribute("aria-checked", "true");
  for (const theme of ["white", "dark"]) await expect(swatch(page, theme)).not.toHaveAttribute("data-locked");
  for (const theme of ["paper", "sepia"]) {
    await expect(swatch(page, theme)).toHaveAttribute("data-locked", "true");
    await expect(swatch(page, theme).locator("[data-lock]")).toBeVisible();
  }
  await expect(swatch(page, "paper")).toHaveAccessibleName("Paper, with Supporter");
  await expect(font(page, "Book")).toHaveAttribute("data-locked", "true");
  await expect(font(page, "Legible")).toHaveAttribute("data-locked", "true");
  await expect(font(page, "Serif")).not.toHaveAttribute("data-locked");
  await expect(panel(page).locator("[data-reader-supporter]")).toHaveText("Paper, Sepia and more fonts — Supporter");
  await page.screenshot({ path: "test-results/np124-aa-free-white.png" });

  // A free theme applies at once, the drop and the page take its colour.
  await swatch(page, "dark").click();
  await expect(mode(page)).toHaveAttribute("data-reader-look", "dark");
  expect(await background(mode(page))).toBe("rgb(30, 29, 26)");
  await expect(mode(page).locator(".reader-body")).toHaveCSS("color", "rgb(232, 226, 214)");

  // A lock opens the Supporter dialog over the mode and changes nothing yet.
  await swatch(page, "paper").click();
  const plans = page.getByRole("dialog", { name: "Support Koona Pin" });
  await expect(plans).toBeVisible();
  await expect(plans.getByRole("listitem").filter({ hasText: "Paper and Sepia themes and more fonts for reading" })).toBeVisible();
  await expect(mode(page)).toHaveAttribute("data-reader-look", "dark");
  // Bought: Paper applies as soon as the plan arrives, the locks go.
  await plans.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("dialog", { name: "Thank you for supporting Koona Pin" })).toBeVisible({ timeout: 15_000 });
  await expect(mode(page)).toHaveAttribute("data-reader-look", "paper");
  expect(await background(mode(page))).toBe("rgb(244, 238, 226)");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(panel(page).locator("[data-locked]")).toHaveCount(0);
  await expect(panel(page).locator("[data-reader-supporter]")).toHaveCount(0);
  await expect(swatch(page, "paper")).toHaveAttribute("aria-checked", "true");
});

test("free: a free theme, size, column and font survive a restart; Esc closes the panel, not the mode (NP-124)", async ({ page }) => {
  await boot(page, { theme: "light" });
  await openMode(page);
  await openPanel(page);
  await swatch(page, "dark").click();
  const size = panel(page).getByRole("slider", { name: "Text size" });
  await size.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(size).toHaveAttribute("aria-valuetext", "20 px");
  await panel(page).getByRole("radio", { name: "Wide" }).click();
  await font(page, "Sans").click();
  const body = mode(page).locator(".reader-body");
  await expect(body).toHaveCSS("font-size", "20px");
  await expect(body).toHaveCSS("line-height", "33px");
  await expect(body).toHaveCSS("font-family", /Inter/);
  await expect(mode(page).locator(".reader-article")).toHaveCSS("max-width", "760px");
  // A locked font opens the dialog and keeps Sans on a free plan.
  await font(page, "Legible").click();
  await expect(page.getByRole("dialog", { name: "Support Koona Pin" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Support Koona Pin" })).toHaveCount(0);
  await expect(body).toHaveCSS("font-family", /Inter/);
  // Esc closes the panel and gives focus back to «Aa»; the mode stays.
  await panel(page).getByRole("radio", { name: "Wide" }).focus();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(aa(page)).toBeFocused();
  await expect(mode(page)).toBeVisible();

  // A restart: the same look, still Dark over a light app.
  await page.reload();
  await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
  await openMode(page);
  await expect(mode(page)).toHaveAttribute("data-reader-look", "dark");
  await expect(body).toHaveCSS("font-size", "20px");
  await expect(body).toHaveCSS("font-family", /Inter/);
  await expect(mode(page).locator(".reader-article")).toHaveCSS("max-width", "760px");
  await openPanel(page);
  await expect(swatch(page, "dark")).toHaveAttribute("aria-checked", "true");
  await expect(panel(page).getByRole("radio", { name: "Wide" })).toHaveAttribute("aria-checked", "true");
  // The sheet over the list (Space) reads in the same look.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(mode(page)).toHaveCount(0);
  await page.locator("article[data-bookmark-id] h2").first().click();
  await page.keyboard.press("Space");
  const sheet = page.locator("dialog[data-reading-sheet]");
  await expect(sheet).toHaveAttribute("data-reader-look", "dark");
  await expect(sheet.locator(".reader-body")).toHaveCSS("font-size", "20px");
});

test("Supporter: no locks; Sepia and a Supporter font survive a restart; the dark app keeps them (NP-124, acceptance 1)", async ({ page }) => {
  await boot(page, { plan: "supporter", theme: "dark" });
  await openMode(page);
  await openPanel(page);
  await expect(mode(page)).toHaveAttribute("data-reader-look", "dark");
  await expect(panel(page).locator("[data-locked]")).toHaveCount(0);
  await expect(panel(page).locator("[data-reader-supporter]")).toHaveCount(0);
  await swatch(page, "sepia").click();
  await font(page, "Book").click();
  await expect(mode(page)).toHaveAttribute("data-reader-look", "sepia");
  expect(await background(mode(page))).toBe("rgb(239, 225, 198)");
  await expect(mode(page).locator(".reader-body")).toHaveCSS("font-family", /Source Serif 4/);
  await page.reload();
  await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
  await openMode(page);
  await expect(mode(page)).toHaveAttribute("data-reader-look", "sepia");
  await expect(mode(page).locator(".reader-body")).toHaveCSS("font-family", /Source Serif 4/);
  // The plan ends: the free look of the app's theme, the choice kept for a new plan.
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "free"));
  await page.reload();
  await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
  await openMode(page);
  await expect(mode(page)).toHaveAttribute("data-reader-look", "dark");
  await openPanel(page);
  await expect(swatch(page, "sepia")).toHaveAttribute("data-locked", "true");
});

test("Settings → Reading: «Open links» changes what the title, double-click and Enter do, and nothing else (NP-124, acceptance 2)", async ({ page }) => {
  await boot(page);
  const card = (title: string) => page.locator("article[data-bookmark-id]").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  const spot = (c: Locator) => c.locator("[data-collection], h2:not(:has(a))").first();
  const urlOf = (c: Locator) =>
    c.evaluate(async (el) => {
      const { api } = await import("/src/services/api.ts");
      return (await api.getBookmarks()).items.find((b) => b.id === Number((el as HTMLElement).dataset.bookmarkId))!.url;
    });
  const article = mode(page).locator(".reader-title");
  const leave = async () => {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(mode(page)).toHaveCount(0);
  };
  const setting = async (label: string) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const links = page.getByRole("radiogroup", { name: "Open links" });
    await links.getByRole("radio", { name: label }).click();
    await expect(links.getByRole("radio", { name: label })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: /^All bookmarks/ }).click();
    await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
  };
  // Everything the setting must not change, checked in both of its states.
  const unchanged = async () => {
    const before = (await opened(page)).length;
    // A click selects and opens nothing; Space reads the selection in the sheet.
    await spot(card(TITLES[2])).click();
    await expect(card(TITLES[2])).toHaveAttribute("data-selected", "true");
    await page.keyboard.press("Space");
    await expect(page.locator("dialog[data-reading-sheet]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[data-reading-sheet]")).toHaveCount(0);
    expect(await opened(page)).toHaveLength(before);
    // The shutter: «↗ Open» is always the browser, «Read» always the sheet.
    await card(TITLES[3]).locator("[data-preview]").hover();
    await card(TITLES[3]).getByRole("button", { name: `Open in browser: ${TITLES[3]}` }).click();
    expect((await opened(page)).at(-1)).toBe(await urlOf(card(TITLES[3])));
    await expect(mode(page)).toHaveCount(0);
  };

  // The default and «In browser»: the gestures open the browser.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const section = page.locator("[data-settings-reading=links]");
  await expect(page.getByRole("radiogroup", { name: "Open links" }).getByRole("radio", { name: "In browser" })).toHaveAttribute("aria-checked", "true");
  await expect(section).toContainText("What a click on a title, a double-click and Enter do.");
  await page.getByRole("button", { name: /^All bookmarks/ }).click();
  await spot(card(TITLES[3])).dblclick();
  expect((await opened(page)).at(-1)).toBe(await urlOf(card(TITLES[3])));
  await card(TITLES[3]).focus();
  await page.keyboard.press("Enter");
  expect(await opened(page)).toHaveLength(2);
  await unchanged();

  // «In reading mode», set in Settings without a restart: the same gestures read in the app.
  await setting("In reading mode");
  const count = (await opened(page)).length;
  await spot(card(TITLES[3])).dblclick();
  await expect(article).toHaveText(TITLES[3]);
  await leave();
  await card(TITLES[3]).focus();
  await page.keyboard.press("Enter");
  await expect(article).toHaveText(TITLES[3]);
  await leave();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await card(TITLES[1]).getByRole("link", { name: TITLES[1], exact: true }).click();
  await expect(article).toHaveText(TITLES[1]);
  await leave();
  expect(await opened(page)).toHaveLength(count);
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await unchanged();
  // Kept per computer.
  expect(await page.evaluate(() => localStorage.getItem("koonapin.openLinks"))).toBe("reader");

  // Back to «In browser».
  await setting("In browser");
  await spot(card(TITLES[0])).dblclick();
  expect((await opened(page)).at(-1)).toBe(await urlOf(card(TITLES[0])));
  await expect(mode(page)).toHaveCount(0);
});

test("Settings → Reading: «Mark as read at the end» off keeps an article read to the end unread; the R row (NP-124, B10)", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const mark = page.getByRole("switch", { name: "Mark as read at the end" });
  await expect(mark).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Read links move to the bottom of Reading and leave it after a week.")).toBeVisible();
  await expect(page.getByText("R on a selected bookmark; the extension’s menu has «Save to Reading».")).toBeVisible();
  await mark.click();
  await expect(mark).toHaveAttribute("aria-checked", "false");
  const read = await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const b = (await api.getBookmarks()).items[0];
    return (await api.setReadingProgress(b.id, 1)).read_at;
  });
  expect(read).toBeNull();
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Mark as read at the end" })).toHaveAttribute("aria-checked", "false");
  await page.getByRole("switch", { name: "Mark as read at the end" }).click();
  const readNow = await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const b = (await api.getBookmarks()).items[1];
    return (await api.setReadingProgress(b.id, 1)).read_at;
  });
  expect(readNow).not.toBeNull();
});
