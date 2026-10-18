import { expect, test, type Page } from "@playwright/test";
import { navPill, openPhone, systemBack, topScreen } from "./fixtures";

// Screen readers on the phone (NP-072b): the Inbox's place says how many links wait there, and
// on L1, I1, R1 and A1 every control has a name and nothing that takes the focus is hidden
// from a screen reader.

/** Controls in the accessibility tree without a name, as Playwright's snapshot shows them. */
async function unnamed(page: Page) {
  const tree = await page.locator("body").ariaSnapshot();
  return tree.split("\n").filter((line) => /^\s*- (button|link|radio|checkbox|textbox|searchbox|switch|menuitem|tab|combobox|slider)(\s*\[[^\]]*\])*:?\s*$/.test(line));
}

/** What takes the focus (a tap's target for TalkBack too) while a screen reader cannot see it. */
const hiddenFocus = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]")]
      .filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && !el.closest("[inert]") && el.closest("[aria-hidden='true']"))
      .filter((el) => getComputedStyle(el).visibility !== "hidden" && el.getClientRects().length > 0)
      .map((el) => el.outerHTML.slice(0, 120)),
  );

async function check(page: Page, frame: string, problems: string[]) {
  await page.waitForTimeout(300);
  for (const line of await unnamed(page)) problems.push(`${frame}: no name: ${line.trim()}`);
  for (const html of await hiddenFocus(page)) problems.push(`${frame}: focusable but hidden: ${html}`);
}

test("the Inbox's place says how many links wait; with none, just its name", async ({ page }) => {
  await openPhone(page);
  const inbox = navPill(page).getByRole("button", { name: /^Inbox/ });
  await expect(inbox).toHaveAccessibleName("Inbox: 2 waiting");
  await inbox.click();
  for (let i = 0; i < 2; i++) await page.locator("[data-decision-pill]").getByRole("button", { name: "Keep" }).click();
  await expect(topScreen(page).locator("[data-inbox-sorted]")).toBeVisible();
  await expect(inbox).toHaveAccessibleName("Inbox");
});

test("L1, I1, R1 and A1: every control is named, nothing focusable is hidden", async ({ page }) => {
  const problems: string[] = [];
  await openPhone(page, { settings: { "demo.supporter": "free" } });
  await check(page, "L1", problems);

  await navPill(page).getByRole("button", { name: /^Inbox/ }).click();
  await expect(page.locator("[data-decision-pill]")).toBeVisible();
  await check(page, "I1", problems);

  await navPill(page).getByRole("button", { name: "All bookmarks" }).click();
  await topScreen(page).locator("[data-bookmark-id]").first().click();
  await expect(topScreen(page).getByRole("button", { name: "Text and theme" })).toBeVisible();
  await check(page, "R1", problems);
  await systemBack(page);

  await topScreen(page).locator("[data-account]").click();
  await expect(page.locator('[data-sheet-kind="you"]')).toBeVisible();
  await check(page, "A1", problems);

  expect(problems).toEqual([]);
});
