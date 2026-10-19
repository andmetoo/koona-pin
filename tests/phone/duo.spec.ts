import { expect, type Locator, type Page, test } from "@playwright/test";
import { DUO_INNER, DUO_OUTER, navPill, openPhone } from "./fixtures";

// iPhone Duo on iOS 27.1 (frames DU1–DU4): the system's vertical bar is a column on the right
// edge of both displays, and our rail lives in it where UIKit puts its tab bar; a screen's
// secondary actions take its toolbar slots under the status block; the inner display's two panes
// keep to either side of the fold. The bar comes from the koona-mobile plugin (here injected as
// the bridge's `bar()`); without one every phone keeps its layout.

const rail = (page: Page) => page.locator("[data-rail]");
const listPane = (page: Page) => page.locator('[data-pane="list"]');
const detailPane = (page: Page) => page.locator('[data-pane="detail"]');
const columnActions = (page: Page) => page.locator("[data-vbar-actions] .ph-circle");
const box = async (locator: Locator) => (await locator.boundingBox())!;

const openOuter = (page: Page, theme: "light" | "dark" = "light") => openPhone(page, { ...DUO_OUTER, platform: "ios", theme });
const openInner = (page: Page, theme: "light" | "dark" = "light") => openPhone(page, { ...DUO_INNER, platform: "ios", theme });

test("outer display (DU4): the rail in the right column instead of the nav pill, the list clear of it", async ({ page }) => {
  await openOuter(page);
  await expect(page.locator("[data-phone]")).toHaveAttribute("data-vbar", "right");
  await expect(navPill(page)).toHaveCount(0);
  // In the column (x 382–466), on UIKit's tab line, its bottom on the 34 bottom inset.
  const r = await box(rail(page));
  expect(r.x).toBeGreaterThanOrEqual(382);
  expect(r.x + r.width).toBeLessThanOrEqual(466);
  expect(Math.round(r.y + r.height)).toBe(678 - 34);
  expect(r.y).toBeGreaterThan(174);
  // No primary action on a list; the account cluster stays in the header, left of the column.
  await expect(page.locator("[data-rail-primary]")).toHaveCount(0);
  const account = await box(page.locator("[data-screen]:not([hidden]) [data-account]"));
  expect(account.x + account.width).toBeLessThanOrEqual(382);
  // The list keeps out of the column; the page itself does not add the column's inset again.
  const row = await box(page.locator("[data-screen]:not([hidden]) [data-bookmark-id]").first());
  expect(row.x + row.width).toBeLessThanOrEqual(382);
  expect(row.x + row.width).toBeGreaterThan(382 - 40);
  // A pushed screen hides the rail as it hides the pill.
  await page.locator("[data-screen]:not([hidden]) [data-bookmark-id]").first().click();
  await expect(page.locator(".ph-rail-column")).toHaveAttribute("data-hidden", "true");
});

test("outer display: the rail takes the tabs and opens New link", async ({ page }) => {
  await openOuter(page);
  await rail(page).getByRole("button", { name: "Feeds", exact: true }).click();
  await expect(rail(page).getByRole("button", { name: "Feeds", exact: true })).toHaveAttribute("aria-current", "page");
  // Feeds' refresh moves into the column's first toolbar slot, 38 pt under the status block.
  const refresh = await box(columnActions(page).first());
  expect(refresh.width).toBe(38);
  expect(Math.round(refresh.y)).toBe(174 + 5);
  expect(Math.round(refresh.x)).toBe(382 + 17);
  await rail(page).getByRole("button", { name: "New link", exact: true }).click();
  await expect(page.locator('[data-sheet-kind="newLink"]')).toBeVisible();
});

test("inner display (DU1): the rail in the column, the list between the fold and the column, the bookmark beyond the fold", async ({ page }) => {
  await openInner(page);
  await expect(page.locator("[data-phone]")).toHaveAttribute("data-fold", "true");
  const r = await box(rail(page));
  expect(r.x).toBeGreaterThanOrEqual(867);
  expect(r.x + r.width).toBeLessThanOrEqual(951);
  expect(Math.round(r.y + r.height)).toBe(669 - 34);
  // The account cluster is in the list pane's header, not above the rail.
  await expect(page.locator(".ph-rail-account")).toHaveCount(0);
  await expect(listPane(page).locator("[data-account]")).toBeVisible();

  await listPane(page).locator("[data-screen]:not([hidden]) [data-bookmark-id]").first().click();
  const detail = await box(detailPane(page));
  expect(detail.x).toBe(16);
  expect(detail.x + detail.width).toBeLessThanOrEqual(455.5);
  expect(Math.round(detail.y + detail.height)).toBe(669 - 34);
  const list = await box(listPane(page));
  expect(list.x).toBeGreaterThanOrEqual(495.5);
  expect(list.x + list.width).toBeLessThanOrEqual(867);
  // Read is the rail's primary circle (52); open original and favourite take the column's slots.
  expect((await box(page.locator("[data-rail-primary]"))).width).toBe(52);
  await expect(columnActions(page)).toHaveCount(2);
  const first = await box(columnActions(page).first());
  expect(Math.round(first.y)).toBe(124 + 5);
  expect(Math.round(first.x)).toBe(867 + 17);
  await expect(detailPane(page).getByRole("button", { name: "Open original" })).toHaveCount(0);
});

test("inner display (DU2): Feeds' refresh holds the column, so a post keeps its circles on its sheet", async ({ page }) => {
  await openInner(page);
  await rail(page).getByRole("button", { name: "Feeds", exact: true }).click();
  await expect(columnActions(page)).toHaveCount(1);
  await expect(columnActions(page).first()).toHaveAccessibleName("Check for new posts");
});

test("inner display (DU3): triage spans the fold, the card on the near side and the decisions beyond it", async ({ page }) => {
  await openInner(page);
  await rail(page).getByRole("button", { name: /^Inbox/ }).click();
  const card = await box(page.locator(".inb-stack"));
  expect(card.x + card.width).toBeLessThanOrEqual(455.5);
  const pill = await box(page.locator(".inb-decide"));
  expect(pill.x).toBeGreaterThanOrEqual(495.5);
  expect(pill.x + pill.width).toBeLessThanOrEqual(867);
  await expect(detailPane(page)).toBeHidden();
});

test("the controls cannot change sides beside the vertical bar: no Layout row, no popover", async ({ page }) => {
  await openInner(page);
  await expect(page.locator("[data-phone]")).toHaveAttribute("data-hand", "right");
  await listPane(page).locator("[data-account]").click();
  await expect(page.locator('[data-sheet-kind="you"]')).toBeVisible();
  await expect(page.locator('[data-sheet-kind="you"]').getByText("Layout", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // A long press on the rail opens no "move the controls" popover.
  const r = await box(rail(page));
  await page.mouse.move(r.x + 36, r.y + 30);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  await expect(page.locator("[data-rail-menu]")).toHaveCount(0);
});

test("a stored left hand does not move the rail out of the vertical bar", async ({ page }) => {
  await openPhone(page, { ...DUO_INNER, platform: "ios", settings: { foldHand: "left" } });
  await expect(page.locator("[data-phone]")).toHaveAttribute("data-hand", "right");
  expect((await box(rail(page))).x).toBeGreaterThanOrEqual(867);
});

test("dark: the inner display's chrome in the dark tokens", async ({ page }) => {
  await openInner(page, "dark");
  await expect(page.locator("[data-phone]")).toHaveAttribute("data-vbar", "right");
  await expect(rail(page)).toBeVisible();
});

// Without a vertical bar nothing changes: iOS keeps the pill inside the side insets (the outer
// display before iOS reports a bar, a phone on its side), Android keeps its pill as it was.

test("iOS without a bar: the nav pill keeps inside the right inset", async ({ page }) => {
  await openPhone(page, { viewport: DUO_OUTER.viewport, insets: DUO_OUTER.insets, platform: "ios" });
  await expect(page.locator("[data-phone]")).not.toHaveAttribute("data-vbar");
  const pill = await box(navPill(page));
  expect(pill.x + pill.width).toBeLessThanOrEqual(382 - 16);
  expect(Math.abs(pill.x + pill.width / 2 - 382 / 2)).toBeLessThan(1);
});

test("Android with a side inset: the nav pill as before, centred on the window", async ({ page }) => {
  await openPhone(page, { viewport: DUO_OUTER.viewport, insets: DUO_OUTER.insets });
  const pill = await box(navPill(page));
  expect(Math.abs(pill.x + pill.width / 2 - 466 / 2)).toBeLessThan(1);
});
