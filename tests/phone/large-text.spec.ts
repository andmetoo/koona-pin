import { expect, test, type Locator, type Page } from "@playwright/test";
import { labelProblems } from "./labels";
import { FOLD, navPill, openPhone, systemBack, topScreen } from "./fixtures";

// Android's font size up to its largest, 2.0 (NP-072b), played by the fixture's text zoom: at 1.3
// and 2.0 no label on a phone's screens and sheets is cut or runs into another. At 1.0 the frames
// hold (the other specs and the screenshots).

async function longPress(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 20);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
}

const sheet = (page: Page, kind: string) => page.locator(`[data-sheet-kind="${kind}"]:not([data-leaving])`);
const at = (textScale: number) => ({ powerSave: false, lowRam: false, textScale });

for (const scale of [1.3, 2]) {
  test.describe(`text at ${scale}`, () => {
    let problems: string[];
    const check = async (page: Page, frame: string) => {
      // Sheets and screens settle (their rise, the pill's measure) before they are measured.
      await page.waitForTimeout(400);
      for (const problem of await labelProblems(page)) problems.push(`${frame}: ${problem}`);
    };
    test.beforeEach(() => {
      problems = [];
    });
    test.afterEach(() => {
      expect(problems).toEqual([]);
    });

    test("I1: the header, the whole card, the decision pill", async ({ page }) => {
      await openPhone(page, { system: at(scale) });
      await navPill(page).getByRole("button", { name: "Inbox" }).click();
      const pill = page.locator("[data-decision-pill]");
      await expect(pill).toBeVisible();
      await check(page, "I1");
      // The card makes room for its lines: the description ends inside it.
      const card = page.locator('[data-triage-card][data-slot="0"]');
      const cardBox = (await card.boundingBox())!;
      const desc = (await card.locator(".inb-desc").boundingBox())!;
      expect(desc.y + desc.height).toBeLessThanOrEqual(cardBox.y + cardBox.height - 8);
      // From the first accessibility size the labels are under their icons.
      const under = await pill.locator(".inb-seg").evaluateAll((segs) =>
        segs.map((seg) => seg.querySelector(".inb-seg-label")!.getBoundingClientRect().top >= seg.querySelector("svg")!.getBoundingClientRect().bottom - 1),
      );
      expect(under).toEqual(scale >= 1.6 ? [true, true, true] : under.map(() => under[0]));
      for (let i = 0; i < 2; i++) await pill.getByRole("button", { name: "Keep" }).click();
      await expect(topScreen(page).locator("[data-inbox-sorted]")).toBeVisible();
      await check(page, "I3");
    });

    test("L1, L2, Q1, the bookmark menu, B1 and C1", async ({ page }) => {
      await openPhone(page, { system: at(scale) });
      await check(page, "L1");
      await topScreen(page).getByRole("radio", { name: "Grid" }).click();
      await check(page, "L2");
      await topScreen(page).getByRole("radio", { name: "List" }).click();
      await topScreen(page).locator(".lib-search").click();
      await page.keyboard.type("design");
      await expect(topScreen(page).locator("[data-bookmark-id]").first()).toBeVisible();
      await check(page, "Q1");
      await systemBack(page);
      await longPress(page, topScreen(page).locator("[data-bookmark-id]").first());
      await expect(sheet(page, "bookmarkMenu")).toBeVisible();
      await check(page, "menu");
      await sheet(page, "bookmarkMenu").getByRole("button", { name: "Edit", exact: true }).click();
      await expect(sheet(page, "edit")).toBeVisible();
      await check(page, "B1");
      await sheet(page, "edit").getByRole("button", { name: /^Collection/ }).click();
      await expect(sheet(page, "collectionPicker")).toBeVisible();
      await check(page, "C1");
    });

    test("R1 with its Aa sheet, F1 and a post, N1", async ({ page }) => {
      await openPhone(page, { system: at(scale) });
      await topScreen(page).locator("[data-bookmark-id]").first().click();
      await check(page, "R1");
      await topScreen(page).getByRole("button", { name: "Text and theme" }).click();
      await expect(sheet(page, "readerLook")).toBeVisible();
      await check(page, "Aa");
      await systemBack(page);
      await systemBack(page);
      await navPill(page).getByRole("button", { name: "Feeds" }).click();
      await expect(topScreen(page).locator("[data-feed-item-id]").first()).toBeVisible();
      await check(page, "F1");
      await topScreen(page).locator("[data-feed-item-id]").first().click();
      await check(page, "post");
      await systemBack(page);
      await navPill(page).getByRole("button", { name: "New link" }).click();
      await expect(sheet(page, "newLink")).toBeVisible();
      await check(page, "N1");
    });

    test("A1, Supporter and the sign-in; the plan; Settings and its pages", async ({ page }) => {
      await openPhone(page, { system: at(scale), settings: { "demo.supporter": "free" } });
      await topScreen(page).locator("[data-account]").click();
      await expect(sheet(page, "you")).toBeVisible();
      await check(page, "A1");
      await sheet(page, "you").locator('[data-supporter="free"]').click();
      await expect(sheet(page, "supporter")).toBeVisible();
      await check(page, "Supporter");
      await sheet(page, "supporter").getByRole("button", { name: "I'm already a Supporter" }).click();
      await expect(sheet(page, "signIn")).toBeVisible();
      await check(page, "sign-in");
      while (await systemBack(page));
      await topScreen(page).locator("[data-account]").click();
      await sheet(page, "you").getByRole("button", { name: "Settings", exact: true }).click();
      await check(page, "S1");
      for (const row of ["Appearance", "Text size", "Language", "Backups", "About & licences"]) {
        await topScreen(page).getByRole("button", { name: new RegExp(row) }).first().click();
        await check(page, row);
        await topScreen(page).getByRole("button", { name: "Back", exact: true }).click();
      }
    });

    test("a Supporter's A1 and the plan sheet", async ({ page }) => {
      await openPhone(page, { system: at(scale), settings: { "demo.supporter": "supporter", "demo.sync": "on" } });
      await topScreen(page).locator("[data-account]").click();
      await expect(sheet(page, "you")).toBeVisible();
      await check(page, "A1");
      await sheet(page, "you").locator('[data-supporter="plan"]').click();
      await expect(sheet(page, "plan")).toBeVisible();
      await check(page, "plan");
    });

    test("the Fold: the list, a bookmark's detail, the rail's popover", async ({ page }) => {
      await openPhone(page, { system: at(scale), viewport: FOLD });
      await check(page, "FL0");
      await page.locator("[data-bookmark-id]").first().click();
      await check(page, "FL1");
      await longPress(page, page.locator("[data-rail]"));
      await expect(page.locator("[data-rail-menu]")).toBeVisible();
      await check(page, "FL3");
    });
  });
}
