import { expect, test, type Locator, type Page } from "@playwright/test";
import { catalog, text } from "../fixtures/app";
import { labelProblems } from "./labels";
import { navPill, openPhone, systemBack, topScreen } from "./fixtures";

// Long languages on a narrow phone (NP-072b), as the desktop's @languages: at 393 wide no label
// is cut or runs into another on L1, I1 with its decision pill, Q1, B1's bar and A1. Labels wrap
// (docs/translating.md, "Length"); the ones too long for their pill are shortened in their locale.

async function longPress(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 20);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
}

/** The open sheet of `kind`, not one on its way out. */
const sheet = (page: Page, kind: string) => page.locator(`[data-sheet-kind="${kind}"]:not([data-leaving])`);

for (const code of ["de", "pl", "fr", "ru"])
  test(`${code}: the phone's labels fit on L1, I1, Q1, B1 and A1`, { tag: "@languages" }, async ({ page }) => {
    const t = (key: string) => text(catalog(code), key);
    await openPhone(page, { settings: { language: code, "demo.supporter": "free" } });
    const problems: string[] = [];
    const check = async (frame: string) => {
      // Sheets and screens settle (their rise, the pill's measure) before they are measured.
      await page.waitForTimeout(400);
      for (const problem of await labelProblems(page)) problems.push(`${frame}: ${problem}`);
    };

    // L1
    await expect(topScreen(page).getByRole("heading", { level: 1 })).toHaveText(t("phone.library.title"));
    await check("L1");

    // Q1, with results from the library and the feeds
    await topScreen(page).locator(".lib-search").click();
    await page.keyboard.type("design");
    await expect(topScreen(page).locator("[data-bookmark-id]").first()).toBeVisible();
    await check("Q1");
    await systemBack(page);
    await expect(topScreen(page).locator(".lib-search")).toBeVisible();

    // B1: Edit link from a bookmark's menu
    await longPress(page, topScreen(page).locator("[data-bookmark-id]").first());
    await sheet(page, "bookmarkMenu").getByRole("button", { name: t("phone.bookmarkMenu.edit"), exact: true }).click();
    await expect(sheet(page, "edit")).toBeVisible();
    await check("B1");
    await systemBack(page);
    await expect(sheet(page, "edit")).toHaveCount(0);

    // A1
    await topScreen(page).locator("[data-account]").click();
    await expect(sheet(page, "you")).toBeVisible();
    await check("A1");
    await systemBack(page);
    await expect(sheet(page, "you")).toHaveCount(0);

    // I1 and the decision pill
    await navPill(page).getByRole("button", { name: t("phone.nav.inbox") }).click();
    await expect(page.locator("[data-decision-pill]")).toBeVisible();
    await check("I1");

    expect(problems).toEqual([]);
  });
