import { test, expect } from "@playwright/test";
import { FOLD, navPill, openPhone, systemBack, topScreen } from "./fixtures";

// The phone shell (NP-072b wave 0): the nav pill, the stack of screens, sheets and system Back.

test("the nav pill switches tabs, and the app's section follows", async ({ page }) => {
  await openPhone(page);
  const pill = navPill(page);
  await expect(pill.getByRole("button", { name: "All bookmarks" })).toHaveAttribute("aria-current", "page");
  await expect(topScreen(page).getByRole("heading", { level: 1 })).toHaveText("Library");

  await pill.getByRole("button", { name: "Inbox" }).click();
  await expect(pill.getByRole("button", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
  await expect(topScreen(page).getByRole("heading", { level: 1 })).toHaveText(/^(Inbox|Sort inbox)$/);

  await pill.getByRole("button", { name: "Reading" }).click();
  await expect(topScreen(page).getByRole("heading", { level: 1 })).toHaveText("Reading");

  await pill.getByRole("button", { name: "Feeds" }).click();
  await expect(topScreen(page).getByRole("heading", { level: 1 })).toHaveText("Feeds");
  await expect(pill.getByRole("button", { name: "All bookmarks" })).not.toHaveAttribute("aria-current");
});

test("the nav pill hides on a pushed route and shows again at the root", async ({ page }) => {
  await openPhone(page);
  await expect(navPill(page)).toBeVisible();
  await topScreen(page).locator("[data-bookmark-id]").first().click();
  await expect(topScreen(page)).toHaveAttribute("data-route");
  await expect(navPill(page)).toHaveAttribute("data-hidden");
  // Slid below the screen's edge and faded out.
  await expect(navPill(page)).not.toBeInViewport();
  await topScreen(page).getByRole("button", { name: "Back" }).click();
  await expect(navPill(page)).not.toHaveAttribute("data-hidden");
  await expect(navPill(page)).toBeInViewport({ ratio: 1 });
});

test("system Back closes a sheet first, then pops the route, then says false at the root", async ({ page }) => {
  await openPhone(page);
  // At the root with nothing open: Android goes to the background.
  expect(await systemBack(page)).toBe(false);

  await topScreen(page).locator("[data-bookmark-id]").first().click();
  const reader = topScreen(page);
  await expect(reader).toHaveAttribute("data-route");
  await reader.getByRole("button", { name: "More" }).click();
  const menu = page.locator('[data-sheet-kind="bookmarkMenu"]');
  await expect(menu.getByRole("dialog")).toBeVisible();

  expect(await systemBack(page)).toBe(true);
  await expect(menu).toHaveCount(0);
  await expect(topScreen(page)).toHaveAttribute("data-route");

  expect(await systemBack(page)).toBe(true);
  await expect(topScreen(page)).not.toHaveAttribute("data-route");
  await expect(navPill(page)).toBeVisible();

  expect(await systemBack(page)).toBe(false);
});

test("the account cluster opens You & sync; the scrim and Back close it", async ({ page }) => {
  await openPhone(page);
  await topScreen(page).locator("[data-account]").click();
  const you = page.locator('[data-sheet-kind="you"]');
  await expect(you.getByRole("dialog", { name: "You & sync" })).toBeVisible();
  await you.locator(".ph-scrim").click({ position: { x: 20, y: 20 } });
  await expect(you).toHaveCount(0);

  await topScreen(page).locator("[data-account]").click();
  await expect(you.getByRole("dialog")).toBeVisible();
  expect(await systemBack(page)).toBe(true);
  await expect(you).toHaveCount(0);

  await topScreen(page).locator("[data-account]").click();
  await expect(you.getByRole("dialog")).toBeVisible();
  // Settings from the sheet: the sheet closes, the settings route is pushed.
  await you.getByRole("button", { name: "Settings" }).click();
  await expect(you).toHaveCount(0);
  await expect(topScreen(page).getByRole("heading", { level: 1 })).toHaveText("Settings");
});

test('"+" opens the New link sheet; dragging its grabber down dismisses it', async ({ page }) => {
  await openPhone(page);
  await navPill(page).getByRole("button", { name: "New link" }).click();
  const sheet = page.locator('[data-sheet-kind="newLink"]');
  const dialog = sheet.getByRole("dialog", { name: "New link" });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(400);
  const grab = (await sheet.locator(".ph-sheet-grab").boundingBox())!;
  await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
  await page.mouse.down();
  await page.mouse.move(grab.x + grab.width / 2, grab.y + 100, { steps: 5 });
  await page.mouse.move(grab.x + grab.width / 2, grab.y + 260, { steps: 5 });
  await page.mouse.up();
  await expect(sheet).toHaveCount(0);
});

test("an Edit from the long-press menu opens the edit sheet; Cancel closes the editor", async ({ page }) => {
  await openPhone(page);
  const row = topScreen(page).locator("[data-bookmark-id]").first();
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 20);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  const menu = page.locator('[data-sheet-kind="bookmarkMenu"]');
  await expect(menu.getByRole("dialog")).toBeVisible();
  await menu.getByRole("button", { name: "Edit" }).click();
  const edit = page.locator('[data-sheet-kind="edit"]');
  await expect(edit.getByRole("dialog", { name: "Edit link" })).toBeVisible();
  await edit.getByRole("button", { name: "Cancel" }).click();
  await expect(edit).toHaveCount(0);
  // The editor is closed with it: Back has nothing left over the root.
  expect(await systemBack(page)).toBe(false);
});

/** Moves the first bookmark to the trash from its menu: the app says so with Undo. */
async function trashFirst(page: import("@playwright/test").Page) {
  await topScreen(page).getByRole("button", { name: "Search" }).waitFor();
  const row = topScreen(page).locator("[data-bookmark-id]").first();
  const title = (await row.locator(".ph-row").textContent())!;
  await topScreen(page).locator("[data-bookmark-id]").first().click();
  await topScreen(page).getByRole("button", { name: "More" }).click();
  await page.locator('[data-sheet-kind="bookmarkMenu"]').getByRole("button", { name: "Move to Trash" }).click();
  await topScreen(page).getByRole("button", { name: "Back" }).click();
  return title;
}

test("the snackbar shows the app's notice above the pill; Undo takes the change back", async ({ page }) => {
  await openPhone(page);
  const title = await trashFirst(page);
  const snackbar = page.locator("[data-snackbar]");
  await expect(snackbar).toBeVisible();
  await expect(topScreen(page).locator(".ph-row", { hasText: title })).toHaveCount(0);
  const bar = (await snackbar.boundingBox())!;
  const pill = (await navPill(page).boundingBox())!;
  expect(bar.y + bar.height).toBeLessThanOrEqual(pill.y);
  await snackbar.getByRole("button", { name: "Undo" }).click();
  await expect(topScreen(page).locator(".ph-row", { hasText: title })).toHaveCount(1);
});

test("the snackbar goes after 5 s, and waits while a finger is on it", async ({ page }) => {
  await page.clock.install();
  await openPhone(page);
  await trashFirst(page);
  const snackbar = page.locator("[data-snackbar]");
  await expect(snackbar).toBeVisible();
  const box = (await snackbar.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.clock.runFor(8000);
  await expect(snackbar).toBeVisible();
  await page.mouse.up();
  await page.mouse.move(box.x + 40, box.y - 200);
  await page.clock.runFor(6000);
  await expect(snackbar).toHaveCount(0);
});

test.describe("on the Fold's inner screen", () => {
  test("the rail replaces the nav pill and switches tabs", async ({ page }) => {
    await openPhone(page, { viewport: FOLD, insets: { top: 32, right: 0, bottom: 24, left: 0 } });
    await expect(navPill(page)).toHaveCount(0);
    const rail = page.locator("[data-rail]");
    await expect(rail).toBeVisible();
    await rail.getByRole("button", { name: "Feeds" }).click();
    await expect(topScreen(page).getByRole("heading", { level: 1 })).toHaveText("Feeds");
  });
});
