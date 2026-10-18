import { test, expect, type Page } from "@playwright/test";
import { FOLD, navPill, openPhone, systemBack, topScreen } from "./fixtures";

// The phone's library, search and bookmark menu (NP-072b wave 1, frames L1, L2, Q1).

/**
 * Replaces the demo library with `rows` and reloads: each row over the first demo bookmark, or
 * `lean` with only its own fields (10,000 full ones do not fit in localStorage).
 */
async function seed(page: Page, rows: Record<string, unknown>[], { lean = false } = {}) {
  await page.evaluate(
    async ([rows, lean]) => {
      const { api } = await import("/src/services/api.ts");
      const [first] = (await api.getBookmarks()).items;
      const bookmarks = rows.map((row) => (lean ? row : { ...first, image_url: null, favicon_url: null, site_name: null, is_favorite: false, ...row }));
      localStorage.setItem("koonapin.demo.v4", JSON.stringify({ bookmarks, collections: await api.getCollections() }));
    },
    [rows, lean] as const,
  );
  await page.reload();
  await expect(page.locator("[data-phone]")).toBeVisible();
}

/** A long press on `target`, as a finger that stays. */
async function longPress(page: Page, target: import("@playwright/test").Locator) {
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 20);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
}

const rows = (page: Page) => topScreen(page).locator(".lib-row[data-bookmark-id]");
const menu = (page: Page) => page.locator('[data-sheet-kind="bookmarkMenu"]');

test("L1: the header, the search field, the switch, the chips and the shelves", async ({ page }) => {
  await openPhone(page);
  const screen = topScreen(page);
  await expect(screen.getByRole("heading", { level: 1 })).toHaveText("Library");
  await expect(screen.locator(".ph-header .ph-meta")).toHaveText(/^\d+ links?$/);
  await expect(screen.getByRole("button", { name: /^Search \d+ links$/ })).toBeVisible();
  await expect(screen.getByRole("radio", { name: "List" })).toHaveAttribute("aria-checked", "true");
  await expect(screen.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(screen.locator(".lib-label").first()).toBeVisible();
  await expect(screen.locator(".lib-shelf").first()).toBeVisible();
  // Rows are 88 tall with a 64 picture (doc/mobile-design.md).
  const row = (await rows(page).first().boundingBox())!;
  expect(row.height).toBe(88);
  const thumb = (await rows(page).first().locator(".lib-thumb").boundingBox())!;
  expect([thumb.width, thumb.height]).toEqual([64, 64]);
  // The search row at 140 as on the frame (54 status bar, the title at 68).
  const search = (await screen.getByRole("button", { name: /^Search/ }).boundingBox())!;
  expect(Math.round(search.y)).toBe(140);
});

test("L2: the grid switch shows cards in two columns and is kept as the view preference", async ({ page }) => {
  await openPhone(page);
  await topScreen(page).getByRole("radio", { name: "Grid" }).click();
  const cards = topScreen(page).locator(".lib-card[data-bookmark-id]");
  await expect(cards.first()).toBeVisible();
  const [a, b] = [(await cards.nth(0).boundingBox())!, (await cards.nth(1).boundingBox())!];
  expect(a.y).toBe(b.y);
  expect(Math.round(b.x - (a.x + a.width))).toBe(12);
  expect(Math.round(a.width)).toBe(175);
  await page.reload();
  await expect(topScreen(page).getByRole("radio", { name: "Grid" })).toHaveAttribute("aria-checked", "true");
  await expect(cards.first()).toBeVisible();
  await topScreen(page).getByRole("radio", { name: "List" }).click();
  await expect(rows(page).first()).toBeVisible();
});

test("chips narrow the tab's section: Favorites, a collection, All", async ({ page }) => {
  await openPhone(page);
  const screen = topScreen(page);
  const all = await rows(page).count();
  await screen.getByRole("button", { name: "Favorites" }).click();
  await expect(screen.getByRole("button", { name: "Favorites" })).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page).first()).toBeVisible();
  // Every row left is a favourite: its small filled heart.
  const favorites = await rows(page).count();
  expect(favorites).toBeLessThan(all);
  await expect(rows(page).locator(".lib-heart")).toHaveCount(favorites);

  const chip = screen.locator(".lib-chips .ph-chip").nth(2);
  const name = (await chip.textContent())!;
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(screen.locator(".ph-header .ph-meta")).toBeVisible();
  await screen.getByRole("button", { name: "All", exact: true }).click();
  await expect(rows(page)).toHaveCount(all);
  expect(name.length).toBeGreaterThan(0);
});

test("the Reading tab keeps Reading under its chips and shelves it by unread and read", async ({ page }) => {
  await openPhone(page);
  await navPill(page).getByRole("button", { name: "Reading" }).click();
  const screen = topScreen(page);
  await expect(screen.getByRole("heading", { level: 1 })).toHaveText("Reading");
  await expect(screen.locator(".lib-label").first()).toHaveText(/Unread|Read/);
  const reading = await rows(page).count();
  await screen.getByRole("button", { name: "Favorites" }).click();
  await expect(screen.getByRole("button", { name: "Favorites" })).toHaveAttribute("aria-pressed", "true");
  // Favourites within Reading, not all of them.
  await expect.poll(() => rows(page).count()).toBeLessThanOrEqual(reading);
  await expect(screen.getByRole("heading", { level: 1 })).toHaveText("Reading");
});

test("a tap opens the reader; a long press opens the menu with the bookmark's title and site", async ({ page }) => {
  await openPhone(page);
  const first = rows(page).first();
  const title = (await first.locator(".ph-row").textContent())!;
  const id = await first.getAttribute("data-bookmark-id");
  await first.click();
  await expect(topScreen(page)).toHaveAttribute("data-route");
  expect(await systemBack(page)).toBe(true);

  await longPress(page, rows(page).first());
  const dialog = menu(page).getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".ph-title2")).toHaveText(title);
  // The long press did not open the reader as well.
  await expect(topScreen(page)).not.toHaveAttribute("data-route");
  for (const name of ["Open original", "Edit", "Move to collection", "Copy link", "Move to Trash"])
    await expect(dialog.getByRole("button", { name, exact: true })).toBeVisible();
  // Move to collection: the menu gives way to the collection picker for this bookmark.
  await dialog.getByRole("button", { name: "Move to collection" }).click();
  await expect(menu(page)).toHaveCount(0);
  await expect(page.locator('[data-sheet-kind="collectionPicker"]').getByRole("dialog")).toBeVisible();
  expect(id).not.toBeNull();
});

test("the menu's favourite and Reading change the bookmark; Reading says so with Undo", async ({ page }) => {
  await openPhone(page);
  const row = rows(page).filter({ hasNot: page.locator(".lib-heart") }).first();
  const id = (await row.getAttribute("data-bookmark-id"))!;
  const same = topScreen(page).locator(`.lib-row[data-bookmark-id="${id}"]`);
  await longPress(page, row);
  await menu(page).getByRole("button", { name: "Add to favorites" }).click();
  await expect(same.locator(".lib-heart")).toBeVisible();
  // The menu is gone first: while it leaves, its scrim still takes touches (reported to the lead).
  await expect(menu(page)).toHaveCount(0);

  await longPress(page, same);
  const reading = menu(page).getByRole("button", { name: /Send to Reading|Remove from Reading/ });
  const label = (await reading.textContent())!;
  await reading.click();
  const snackbar = page.locator("[data-snackbar]");
  await expect(snackbar).toContainText(label.startsWith("Send") ? "Sent to Reading" : "Removed from Reading");
  await snackbar.getByRole("button", { name: "Undo" }).click();
  await expect(menu(page)).toHaveCount(0);
  await longPress(page, same);
  await expect(menu(page).getByRole("button", { name: label })).toBeVisible();
});

test("Q1: Search opens over the tab without the pill, finds bookmarks and posts by scope; Cancel is Back", async ({ page }) => {
  await openPhone(page);
  await topScreen(page).getByRole("button", { name: /^Search/ }).click();
  const search = topScreen(page);
  await expect(search).toHaveAttribute("data-route");
  await expect(navPill(page)).toHaveAttribute("data-hidden");
  const field = search.getByRole("searchbox", { name: "Search" });
  await expect(field).toBeFocused();
  await field.fill("design");
  await expect(search.locator(".lib-label").first()).toHaveText(/^\d+\+? results?$/);
  await expect(search.locator(".lib-row[data-bookmark-id]").first()).toBeVisible();

  await search.getByRole("radio", { name: "Feeds" }).click();
  await expect(search.locator(".lib-row[data-post-id]").first()).toBeVisible();
  await expect(search.locator(".lib-row[data-bookmark-id]")).toHaveCount(0);
  await search.getByRole("radio", { name: "Library" }).click();
  await expect(search.locator(".lib-row[data-bookmark-id]").first()).toBeVisible();
  await expect(search.locator(".lib-row[data-post-id]")).toHaveCount(0);

  // Nothing found says so.
  await field.fill("qqzzxx");
  await expect(search.locator("[data-empty]")).toContainText("Nothing matches “qqzzxx”");

  // The tab underneath kept its own list.
  await search.getByRole("button", { name: "Cancel" }).click();
  await expect(topScreen(page)).not.toHaveAttribute("data-route");
  await expect(navPill(page)).not.toHaveAttribute("data-hidden");
  await expect(rows(page).first()).toBeVisible();

  await topScreen(page).getByRole("button", { name: /^Search/ }).click();
  await expect(topScreen(page)).toHaveAttribute("data-route");
  expect(await systemBack(page)).toBe(true);
  await expect(topScreen(page)).not.toHaveAttribute("data-route");
});

test("a search result opens the reader, and its long press the menu", async ({ page }) => {
  await openPhone(page);
  await topScreen(page).getByRole("button", { name: /^Search/ }).click();
  await topScreen(page).getByRole("searchbox", { name: "Search" }).fill("design");
  const result = topScreen(page).locator(".lib-row[data-bookmark-id]").first();
  const title = (await result.locator(".ph-row").textContent())!;
  await longPress(page, result);
  await expect(menu(page).getByRole("dialog").locator(".ph-title2")).toHaveText(title);
  expect(await systemBack(page)).toBe(true);
  await result.click();
  await expect(topScreen(page)).toHaveAttribute("data-route");
  await expect(topScreen(page).locator("[data-bookmark-id]")).toHaveCount(0);
});

test("an empty library says so and offers New link", async ({ page }) => {
  await openPhone(page);
  await seed(page, []);
  const empty = topScreen(page).locator("[data-empty]");
  await expect(empty).toContainText("Your bookmarks will live here");
  await empty.getByRole("button", { name: "New link" }).click();
  await expect(page.locator('[data-sheet-kind="newLink"]').getByRole("dialog")).toBeVisible();
});

test("10,000 bookmarks: a few rows in the DOM, pages load while scrolling, the day shelves hold", async ({ page }) => {
  await openPhone(page);
  const now = Date.now();
  await seed(
    page,
    Array.from({ length: 10_000 }, (_, i) => ({
      id: i + 1,
      url: `https://e.test/${i + 1}`,
      domain: "e.test",
      title: `Entry ${i + 1}`,
      collection_id: null,
      deleted_at: null,
      triaged_at: new Date(now - i * 60_000).toISOString(),
      tags: [],
      created_at: new Date(now - i * 60_000).toISOString(),
      revision: 2,
    })),
    { lean: true },
  );
  const screen = topScreen(page);
  await expect(screen.locator(".ph-header .ph-meta")).toHaveText("10,000 links");
  await expect(screen.locator(".lib-list")).toBeVisible();
  expect(await rows(page).count()).toBeLessThan(30);
  await expect(screen.locator(".lib-label").first()).toHaveText("Today");
  // Down to the end of the loaded pages: the next ones come.
  const loaded = async () => Number(await screen.locator(".lib-list").getAttribute("data-entries"));
  const before = await loaded();
  for (let i = 0; i < 4; i++) {
    await screen.evaluate((el) => el.scrollBy(0, el.scrollHeight));
    await page.waitForTimeout(150);
  }
  await expect.poll(loaded).toBeGreaterThan(before);
  expect(await rows(page).count()).toBeLessThan(40);
});

test("pull to refresh arms past its threshold and spins while the list is read again", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true });
  const page = await context.newPage();
  await openPhone(page);
  const screen = topScreen(page);
  await expect(rows(page).first()).toBeVisible();
  const disc = screen.locator(".lib-pull-disc");
  const touch = (type: string, y: number) =>
    screen.evaluate(
      (el, [type, y]) => {
        const point = new Touch({ identifier: 1, target: el, clientX: 200, clientY: y as number });
        el.dispatchEvent(new TouchEvent(type as string, { touches: type === "touchend" ? [] : [point], changedTouches: [point], bubbles: true, cancelable: true }));
      },
      [type, y] as const,
    );
  await touch("touchstart", 300);
  await touch("touchmove", 340);
  await expect(disc).toHaveAttribute("data-pull", "pulling");
  await touch("touchmove", 460);
  await expect(disc).toHaveAttribute("data-pull", "armed");
  await touch("touchend", 460);
  await expect(disc).toHaveAttribute("data-pull", "refreshing");
  await expect(disc).not.toHaveAttribute("data-pull");
  await expect(rows(page).first()).toBeVisible();

  // A short pull springs back without refreshing.
  await touch("touchstart", 300);
  await touch("touchmove", 360);
  await touch("touchend", 360);
  await expect(disc).not.toHaveAttribute("data-pull");
  await context.close();
});

test.describe("on the Fold's inner screen", () => {
  test("the list fills the pane beside the rail, and the grid takes more columns", async ({ page }) => {
    await openPhone(page, { viewport: FOLD, insets: { top: 32, right: 0, bottom: 24, left: 0 } });
    const rail = (await page.locator("[data-rail]").boundingBox())!;
    const row = (await rows(page).first().boundingBox())!;
    expect(row.x + row.width).toBeLessThan(rail.x);
    await topScreen(page).getByRole("radio", { name: "Grid" }).click();
    const cards = topScreen(page).locator(".lib-card[data-bookmark-id]");
    await expect(cards.first()).toBeVisible();
    const tops = await cards.evaluateAll((all) => all.map((c) => c.getBoundingClientRect().top));
    expect(tops.filter((top) => top === tops[0]).length).toBeGreaterThan(2);
  });
});
