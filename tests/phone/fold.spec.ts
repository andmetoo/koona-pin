import { expect, type Locator, type Page, test } from "@playwright/test";
import { FOLD, navPill, openPhone, PHONE, systemBack, topScreen } from "./fixtures";

// The Galaxy Z Fold's inner screen (NP-072b wave 2, frames FL1–FL3): the vertical rail on the side
// the person holds, the list pane next to it, the detail sheet on the far side; the handedness
// switch; Back on the Fold; and what survives folding and unfolding, on the demo backend.

/** FL1's Android zones: a 32 status bar and a 24 gesture inset. */
const INSETS = { top: 32, right: 0, bottom: 24, left: 0 };

const rail = (page: Page) => page.locator("[data-rail]");
const primary = (page: Page) => page.locator("[data-rail-primary]");
const listPane = (page: Page) => page.locator('[data-pane="list"]');
const detailPane = (page: Page) => page.locator('[data-pane="detail"]');
const detailScreen = (page: Page) => detailPane(page).locator("[data-screen]:not([hidden])");
const rows = (page: Page) => listPane(page).locator("[data-screen]:not([hidden]) [data-bookmark-id]");
const editSheet = (page: Page) => page.locator('[data-sheet-kind="edit"]');

const openFold = (page: Page, settings: Record<string, string> = {}) => openPhone(page, { viewport: FOLD, insets: INSETS, settings });

async function longPress(page: Page, target: Locator, at = { x: 36, y: 30 }) {
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + at.x, box.y + at.y);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
}

const box = async (locator: Locator) => (await locator.boundingBox())!;

test("the rail is on the right by default, the list next to it and the detail sheet on the far side", async ({ page }) => {
  await openFold(page);
  await expect(page.locator("[data-phone]")).toHaveAttribute("data-hand", "right");
  await expect(navPill(page)).toHaveCount(0);

  // 72 wide, 32 from the edge (clear of the 24 back-gesture strip), 16 above the gesture inset.
  const r = await box(rail(page));
  expect(r.width).toBe(72);
  expect(Math.round(FOLD.width - (r.x + r.width))).toBe(32);
  expect(Math.round(FOLD.height - (r.y + r.height))).toBe(24 + 16);
  for (const name of ["Inbox", "All bookmarks", "Reading", "Feeds", "New link"]) await expect(rail(page).getByRole("button", { name, exact: true })).toBeVisible();
  await expect(rail(page).getByRole("button", { name: "All bookmarks" })).toHaveAttribute("aria-current", "page");
  // Nothing selected: no primary action, the calm empty sheet.
  await expect(primary(page)).toHaveCount(0);
  await expect(page.locator("[data-detail-empty]")).toBeVisible();

  const detail = await box(detailPane(page));
  const list = await box(listPane(page));
  expect(Math.round(detail.x)).toBe(24);
  expect(Math.round(detail.y)).toBe(32 + 16);
  expect(list.x).toBeGreaterThanOrEqual(detail.x + detail.width);
  expect(list.x + list.width).toBeLessThanOrEqual(r.x);
  // The multitasking handle at the top centre stays clear: nothing tappable above the sheet.
  expect(detail.y).toBeGreaterThan(46);
});

test("controls on the left are the exact mirror", async ({ page }) => {
  await openFold(page, { foldHand: "left" });
  await expect(page.locator("[data-phone]")).toHaveAttribute("data-hand", "left");
  const r = await box(rail(page));
  expect(Math.round(r.x)).toBe(32);
  const detail = await box(detailPane(page));
  const list = await box(listPane(page));
  expect(Math.round(FOLD.width - (detail.x + detail.width))).toBe(24);
  expect(list.x).toBeGreaterThanOrEqual(r.x + r.width);
  expect(list.x + list.width).toBeLessThanOrEqual(detail.x);

  // The sheet's circles mirror too: more on the outer (right) side, favourite next to the list.
  await rows(page).nth(1).click();
  const more = await box(detailScreen(page).getByRole("button", { name: "More" }));
  const open = await box(detailScreen(page).getByRole("button", { name: "Open original" }));
  const heart = await box(detailScreen(page).getByRole("button", { name: /favorite/i }));
  expect(more.x).toBeGreaterThan(open.x);
  expect(open.x).toBeGreaterThan(heart.x);
  // Text stays left-aligned.
  await expect(detailScreen(page).getByRole("heading", { level: 1 })).toHaveCSS("text-align", /start|left/);
});

test("a long press on the rail opens its popover: it moves the controls, and the side stays after a reload", async ({ page }) => {
  await openFold(page);
  await longPress(page, rail(page));
  const menu = page.locator("[data-rail-menu]");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Navigation rail");
  await expect(menu.getByRole("menuitem", { name: "Move controls to the left" })).toBeFocused();
  // The long press is not a tap: the place under the finger did not change.
  await expect(rail(page).getByRole("button", { name: "Inbox" })).not.toHaveAttribute("aria-current", "page");

  await menu.getByRole("menuitem", { name: "Move controls to the left" }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator("[data-phone]")).toHaveAttribute("data-hand", "left");
  expect(Math.round((await box(rail(page))).x)).toBe(32);

  await page.reload();
  await expect(page.locator("[data-phone]")).toHaveAttribute("data-hand", "left");

  // Escape and Back close it without a change.
  await longPress(page, rail(page));
  await expect(menu.getByRole("menuitem", { name: "Move controls to the right" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await longPress(page, rail(page));
  await expect(menu).toBeVisible();
  expect(await systemBack(page)).toBe(true);
  await expect(menu).toHaveCount(0);
  await expect(page.locator("[data-phone]")).toHaveAttribute("data-hand", "left");

  // "Layout settings…" opens Settings → Layout in the detail sheet.
  await longPress(page, rail(page));
  await menu.getByRole("menuitem", { name: "Layout settings…" }).click();
  await expect(detailScreen(page).getByRole("heading", { level: 1 })).toHaveText("Layout");
  await expect(detailScreen(page).getByRole("radio", { name: "Controls on the left" })).toBeChecked();
  await detailScreen(page).getByRole("radio", { name: "Controls on the right" }).click();
  await expect(page.locator("[data-phone]")).toHaveAttribute("data-hand", "right");
});

test("a row's tap selects it into the detail sheet; Read on the rail opens the reader there; Back walks back", async ({ page }) => {
  await openFold(page);
  const row = rows(page).nth(1);
  const title = (await row.locator(".ph-row").textContent())!;
  await row.click();
  await expect(row).toHaveAttribute("aria-current", "true");
  await expect(detailScreen(page).getByRole("heading", { level: 1 })).toHaveText(title);
  await expect(detailScreen(page)).toContainText(/Saved /);
  // The list stays: the tab's screen still shows beside it.
  await expect(listPane(page).getByRole("heading", { level: 1 })).toHaveText("Library");
  await expect(primary(page)).toHaveAccessibleName("Read");

  await primary(page).click();
  await expect(detailScreen(page).getByRole("button", { name: "Done" })).toBeVisible();
  await expect(row).toHaveAttribute("aria-current", "true");
  await expect(primary(page)).toHaveCount(0);

  // Back: the reader, then the selection, then nothing to close at the tab's root.
  expect(await systemBack(page)).toBe(true);
  await expect(detailScreen(page).getByRole("heading", { level: 1 })).toHaveText(title);
  expect(await systemBack(page)).toBe(true);
  await expect(page.locator("[data-detail-empty]")).toBeVisible();
  await expect(row).not.toHaveAttribute("aria-current", "true");
  expect(await systemBack(page)).toBe(false);

  // Another row replaces the selection; Back clears it in one step.
  await rows(page).nth(0).click();
  await rows(page).nth(2).click();
  await expect(rows(page).nth(2)).toHaveAttribute("aria-current", "true");
  expect(await systemBack(page)).toBe(true);
  await expect(page.locator("[data-detail-empty]")).toBeVisible();
});

test("Search fills the list pane; Cancel closes it with the result chosen from it", async ({ page }) => {
  await openFold(page);
  await listPane(page).getByRole("button", { name: /Search/ }).click();
  await page.keyboard.type("design");
  const result = listPane(page).locator("[data-screen]:not([hidden]) [data-bookmark-id]").first();
  await result.click();
  await expect(result).toHaveAttribute("aria-current", "true");
  await expect(detailScreen(page).getByRole("heading", { level: 1 })).toBeVisible();
  await listPane(page).getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("[data-detail-empty]")).toBeVisible();
  await expect(listPane(page).getByRole("heading", { level: 1 })).toHaveText("Library");
});

test("a post from Feeds fills the detail sheet; Save on the rail saves it as a bookmark", async ({ page }) => {
  await openFold(page);
  await rail(page).getByRole("button", { name: "Feeds" }).click();
  const post = listPane(page).locator(".fd-post").first();
  const title = (await post.locator(".fd-title").textContent())!;
  await post.click();
  await expect(post).toHaveAttribute("aria-current", "true");
  await expect(detailScreen(page).locator(".reader-title")).toHaveText(title);
  for (const name of ["Text and theme", "Open original", "Add to Reading"]) await expect(detailScreen(page).getByRole("button", { name })).toBeVisible();

  await expect(primary(page)).toHaveAccessibleName("Save as bookmark");
  await primary(page).click();
  await expect(primary(page)).toHaveAccessibleName("Saved as a bookmark");
  await expect(primary(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-snackbar]")).toBeVisible();
  await expect(post).toContainText("Saved");
});

test("folding and unfolding keeps the tab, the open bookmark or post, and an edit's draft", async ({ page }) => {
  await openPhone(page, { viewport: PHONE });
  // A phone's reader becomes the Fold's selection, read in the detail sheet…
  const first = topScreen(page).locator("[data-bookmark-id]").nth(1);
  const id = await first.getAttribute("data-bookmark-id");
  await first.click();
  await expect(topScreen(page).getByRole("button", { name: "Done" })).toBeVisible();
  await page.setViewportSize(FOLD);
  await expect(rail(page)).toBeVisible();
  await expect(detailScreen(page).getByRole("button", { name: "Done" })).toBeVisible();
  await expect(rows(page).and(page.locator(`[data-bookmark-id="${id}"]`))).toHaveAttribute("aria-current", "true");

  // …and a bookmark chosen on the Fold is its reader once folded; Back returns to the list.
  const other = rows(page).nth(2);
  const label = (await other.locator(".ph-row").textContent())!;
  await other.click();
  await expect(detailScreen(page).getByRole("heading", { level: 1 })).toHaveText(label);
  await page.setViewportSize(PHONE);
  await expect(topScreen(page)).toHaveAttribute("aria-label", label);
  await expect(topScreen(page).getByRole("button", { name: "Done" })).toBeVisible();
  expect(await systemBack(page)).toBe(true);
  await expect(navPill(page)).toBeVisible();
  expect(await systemBack(page)).toBe(false);

  // The tab and a post: Feeds stays open, the post moves between the stack and the detail sheet.
  await navPill(page).getByRole("button", { name: "Feeds" }).click();
  const post = topScreen(page).locator(".fd-post").first();
  const postTitle = (await post.locator(".fd-title").textContent())!;
  await post.click();
  await expect(topScreen(page).locator(".reader-title")).toHaveText(postTitle);
  await page.setViewportSize(FOLD);
  await expect(rail(page).getByRole("button", { name: "Feeds" })).toHaveAttribute("aria-current", "page");
  await expect(detailScreen(page).locator(".reader-title")).toHaveText(postTitle);
  await expect(listPane(page).locator(".fd-post").first()).toHaveAttribute("aria-current", "true");
  await page.setViewportSize(PHONE);
  await expect(topScreen(page).locator(".reader-title")).toHaveText(postTitle);
  expect(await systemBack(page)).toBe(true);

  // An open sheet and what was typed in it.
  await navPill(page).getByRole("button", { name: "All bookmarks" }).click();
  await longPress(page, topScreen(page).locator("[data-bookmark-id]").first(), { x: 40, y: 20 });
  await page.locator('[data-sheet-kind="bookmarkMenu"]').getByRole("button", { name: "Edit" }).click();
  const field = editSheet(page).getByRole("textbox", { name: "Title" });
  await field.fill("A draft that survives the hinge");
  await page.setViewportSize(FOLD);
  await expect(rail(page)).toBeVisible();
  await expect(editSheet(page)).toBeVisible();
  await expect(field).toHaveValue("A draft that survives the hinge");
  await page.setViewportSize(PHONE);
  await expect(navPill(page)).toBeAttached();
  await expect(field).toHaveValue("A draft that survives the hinge");
});
