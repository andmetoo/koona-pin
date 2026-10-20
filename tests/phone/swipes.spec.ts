import { test, expect, type Page } from "@playwright/test";
import { navPill, openPhone, topScreen } from "./fixtures";

// Swipes between filters (owner, 20 October 2026; doc/mobile-design.md, frames SW1–SW4): a
// sideways drag on the list moves to the neighbouring chip, feed or Reading page.

/** A drag from (x, y) by dx sideways and dy down, as a finger that moves and lets go. */
async function drag(page: Page, x: number, y: number, dx: number, dy = 0) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
}
const left = (page: Page) => drag(page, 300, 520, -200);
const right = (page: Page) => drag(page, 100, 520, 200);
const pressed = (page: Page) => topScreen(page).locator('.ph-chips [aria-pressed="true"]');

test("Library: a swipe moves along the chips in their order and never wraps; a tap after it opens nothing", async ({ page }) => {
  await openPhone(page);
  const screen = topScreen(page);
  await expect(pressed(page)).toHaveText("All");
  await right(page);
  await expect(pressed(page)).toHaveText("All");
  await left(page);
  await expect(pressed(page)).toHaveText("Favorites");
  const collection = (await screen.locator(".lib-chips .ph-chip").nth(2).textContent())!;
  await left(page);
  await expect(pressed(page)).toHaveText(collection);
  await right(page);
  await right(page);
  await expect(pressed(page)).toHaveText("All");
  // The drag ended over a row: it did not open the reader.
  await expect(topScreen(page)).not.toHaveAttribute("data-route");
});

test("Library: the last chip scrolls into view, and the end gives nothing more", async ({ page }) => {
  await openPhone(page);
  const chips = topScreen(page).locator(".lib-chips .ph-chip");
  const count = await chips.count();
  for (let i = 1; i < count; i++) {
    await left(page);
    await expect(chips.nth(i)).toHaveAttribute("aria-pressed", "true");
  }
  await left(page);
  await expect(chips.nth(count - 1)).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await chips.nth(count - 1).boundingBox())!.x + (await chips.nth(count - 1).boundingBox())!.width).toBeLessThanOrEqual(393);
});

test("a swipe from the screen's edge is the system's, a short or upright drag is not a swipe", async ({ page }) => {
  await openPhone(page);
  await drag(page, 10, 520, 250);
  await drag(page, 383, 520, -250);
  await expect(pressed(page)).toHaveText("All");
  await drag(page, 300, 520, -20);
  await expect(pressed(page)).toHaveText("All");
  await drag(page, 250, 650, -60, -300);
  await expect(pressed(page)).toHaveText("All");
});

test("Reading: a swipe moves between To read and Read", async ({ page }) => {
  await openPhone(page);
  await navPill(page).getByRole("button", { name: "Reading" }).click();
  const screen = topScreen(page);
  const toRead = screen.getByRole("radio", { name: /^To read \d+$/ });
  const read = screen.getByRole("radio", { name: /^Read \d+$/ });
  await expect(toRead).toHaveAttribute("aria-checked", "true");
  await left(page);
  await expect(read).toHaveAttribute("aria-checked", "true");
  await left(page);
  await expect(read).toHaveAttribute("aria-checked", "true");
  await right(page);
  await expect(toRead).toHaveAttribute("aria-checked", "true");
});

test("Feeds: a swipe moves along the feed chips, All feeds first", async ({ page }) => {
  await openPhone(page);
  await navPill(page).getByRole("button", { name: "Feeds" }).click();
  const screen = topScreen(page);
  await expect(screen.locator("[data-feed-item-id]").first()).toBeVisible();
  const chips = screen.locator(".fd-chips .ph-chip");
  await expect(chips.first()).toHaveAttribute("aria-pressed", "true");
  await left(page);
  await expect(chips.nth(1)).toHaveAttribute("aria-pressed", "true");
  await right(page);
  await expect(chips.first()).toHaveAttribute("aria-pressed", "true");
});
