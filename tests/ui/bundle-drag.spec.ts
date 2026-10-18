// Dragging into the bundle (share-bundle.md, piece C): collections, tag chips, feed rows and All
// feeds go to the bundle by a drag; sidebar targets refuse sidebar rows; the capsule follows the
// noise rule, and with reduced motion only a 300 ms border says something landed.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { openApp } from "../fixtures/app";

const capsule = (page: Page) => page.locator("[data-bundle-capsule]");
const capsuleButton = (page: Page) => capsule(page).locator("> button").first();
const announcer = (page: Page) => page.locator("[data-announcer]");
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Library" });
const rowStack = (page: Page) => page.locator("[data-row-stack]");
const collection = (page: Page, name: string) => sidebar(page).locator("[data-collection-row]").filter({ hasText: name });
const collectionNames = (page: Page) => sidebar(page).locator("[data-collection-row] [data-collection] .fade-end").allInnerTexts();
const allBookmarks = (page: Page) => sidebar(page).getByRole("button", { name: /^All bookmarks/ });

async function centre(locator: Locator) {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function moveTo(page: Page, locator: Locator, dy = 0) {
  const at = await centre(locator);
  await page.mouse.move(at.x, at.y + dy, { steps: 8 });
}

/** Press on a sidebar row and take it past the 4 px threshold, still inside the sidebar. */
async function pick(page: Page, row: Locator) {
  const at = await centre(row);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 6, at.y + 4, { steps: 3 });
  return at;
}

/** Out of the sidebar into the library, then onto the capsule. */
async function toCapsule(page: Page) {
  await page.mouse.move(700, 400, { steps: 8 });
  await expect(capsule(page)).toBeVisible();
  await moveTo(page, capsuleButton(page));
  await expect(capsule(page)).toHaveAttribute("data-over", "");
}

/** Whether an element matching `selector` (with `text`, if given) shows up from now on. */
async function watch(page: Page, selector: string, text = "") {
  await page.evaluate(
    ({ selector, text }) => {
      const w = window as unknown as { seen: boolean };
      w.seen = false;
      new MutationObserver(() => {
        const found = [...document.querySelectorAll(selector)].some((el) => el.textContent?.includes(text));
        if (found) w.seen = true;
      }).observe(document.body, { childList: true, subtree: true });
    },
    { selector, text },
  );
}
const seen = (page: Page) => page.evaluate(() => (window as unknown as { seen: boolean }).seen);

// Tall enough that the tag chips are not under the sidebar's footer.
test.beforeEach(({ page }) => openApp(page, { viewport: { width: 1200, height: 1100 }, settings: { view: "grid" }, cards: 6 }));

test("a collection dragged to the capsule becomes a section; a reorder still reorders", async ({ page }) => {
  await expect(capsule(page)).toHaveCount(0);
  await pick(page, collection(page, "Development"));
  // Inside the sidebar it is the plain reorder ghost; outside, the one-row stack.
  await expect(rowStack(page)).toHaveCount(0);
  await page.mouse.move(700, 400, { steps: 8 });
  await expect(rowStack(page)).toContainText("Development · 1 link");
  await expect(rowStack(page).locator("[data-drop-hint]")).toHaveText("Drop on the bundle");
  await toCapsule(page);
  await expect(capsule(page)).toContainText("Add collection “Development”");
  await expect(rowStack(page).locator("[data-drop-hint]")).toHaveText("Add collection “Development”");
  // Over it the count bubble gives way.
  await expect(capsule(page).locator("[data-bundle-count]")).toHaveCount(0);
  await page.mouse.up();
  await expect(announcer(page)).toHaveText("Added Development to the bundle, 1 item");
  await expect(capsuleButton(page)).toHaveAccessibleName("Bundle, 1 item");
  // The drop opened nothing: the view is still All bookmarks.
  await expect(allBookmarks(page)).toHaveAttribute("aria-current", "page");
  await capsuleButton(page).click();
  await expect(page.locator("[data-bundle-panel] [data-bundle-section^='collection:']")).toContainText("Development");
  await page.keyboard.press("Escape");

  // Inside the sidebar the move is what it was.
  expect(await collectionNames(page)).toEqual(["Design", "Development", "Inspiration", "To read"]);
  await pick(page, collection(page, "Design"));
  await moveTo(page, collection(page, "Inspiration"), 10);
  await expect(sidebar(page).locator("[data-landing]")).toHaveCount(1);
  await expect(rowStack(page)).toHaveCount(0);
  await page.mouse.up();
  await expect.poll(() => collectionNames(page)).toEqual(["Development", "Inspiration", "Design", "To read"]);
});

test("a tag chip adds a tag section, a feed row and All feeds add feeds", async ({ page }) => {
  const chip = sidebar(page).getByRole("button", { name: "interfaces", exact: true });
  await pick(page, chip);
  await toCapsule(page);
  await expect(rowStack(page)).toContainText("interfaces · 2 links");
  await expect(capsule(page)).toContainText("Add tag “interfaces”");
  await page.mouse.up();
  await expect(announcer(page)).toHaveText("Added interfaces to the bundle, 2 items");
  // The click that ended the drag did not filter by the tag.
  await expect(chip).toHaveAttribute("aria-pressed", "false");

  await pick(page, sidebar(page).locator("[data-feed-row]").filter({ hasText: "The Verge" }));
  await toCapsule(page);
  await expect(capsule(page)).toContainText("Add 1 feed");
  await page.mouse.up();
  await expect(announcer(page)).toHaveText("Added 1 feed to the bundle, 3 items");

  await pick(page, sidebar(page).getByRole("button", { name: /^All feeds/ }));
  await toCapsule(page);
  await expect(capsule(page)).toContainText(/Add \d+ feeds?/);
  await page.mouse.up();
  await expect(announcer(page)).toHaveText(/^Added \d+ feeds? to the bundle, \d+ items$/);

  await capsuleButton(page).click();
  const sections = page.locator("[data-bundle-panel] [data-bundle-section]");
  await expect(sections).toHaveCount(2);
  await expect(sections.first()).toHaveAttribute("data-bundle-section", "tag:interfaces");
  await expect(sections.last()).toHaveAttribute("data-bundle-section", "feeds");
});

test("a sidebar row dropped on another sidebar row changes nothing, and nothing there lights up", async ({ page }) => {
  const before = await collectionNames(page);
  await pick(page, sidebar(page).getByRole("button", { name: "interfaces", exact: true }));
  await moveTo(page, collection(page, "Development"));
  await expect(rowStack(page).locator("[data-drop-hint]")).toBeVisible();
  // No sidebar target takes a sidebar row: no data-drop, no accent fill.
  await expect(sidebar(page).locator("[data-drop]")).toHaveCount(0);
  await expect(collection(page, "Development").locator("[data-collection]")).not.toHaveClass(/bg-accent-soft/);
  await page.mouse.up();
  await expect(rowStack(page)).toHaveCount(0);
  expect(await collectionNames(page)).toEqual(before);
  // Nothing opened and nothing was added.
  await expect(allBookmarks(page)).toHaveAttribute("aria-current", "page");
  await expect(capsule(page)).toHaveCount(0);

  // Esc cancels a drag out of the sidebar too, and the release after it opens nothing.
  await pick(page, sidebar(page).locator("[data-feed-row]").first());
  await toCapsule(page);
  await page.keyboard.press("Escape");
  await expect(rowStack(page)).toHaveCount(0);
  await page.mouse.up();
  await expect(capsule(page)).toHaveCount(0);
  await expect(allBookmarks(page)).toHaveAttribute("aria-current", "page");
});

test("the capsule waits until the pointer leaves the sidebar; only near it does it move", async ({ page }) => {
  const start = await pick(page, sidebar(page).locator("[data-feed-row]").first());
  await page.mouse.move(start.x + 20, start.y + 120, { steps: 6 });
  await expect(rowStack(page).locator("[data-drop-hint]")).toBeVisible();
  await expect(capsule(page)).toHaveCount(0);
  await page.mouse.move(700, 300, { steps: 6 });
  await expect(capsule(page)).toBeVisible();
  // Far from it: no rise, no glow.
  await expect(capsule(page)).not.toHaveAttribute("data-near");
  expect(await capsuleButton(page).evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42)).toBe(0);
  await expect(capsule(page).locator(".bundle-glow")).toHaveCSS("opacity", "0");
  // Near (≤ 120 px): it rises and the glow grows.
  const box = (await capsuleButton(page).boundingBox())!;
  await page.mouse.move(box.x - 40, box.y + box.height / 2, { steps: 4 });
  await expect(capsule(page)).toHaveAttribute("data-near", "");
  await expect.poll(() => capsuleButton(page).evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42)).toBeLessThan(0);
  await expect.poll(() => capsule(page).locator(".bundle-glow").evaluate((el) => Number(getComputedStyle(el).opacity))).toBeGreaterThan(0);
  // Back in the sidebar it stays (it came once) and settles.
  await page.mouse.move(start.x, start.y, { steps: 6 });
  await expect(capsule(page)).toBeVisible();
  await expect(capsule(page)).not.toHaveAttribute("data-near");
  await page.mouse.up();
  await expect(capsule(page)).toHaveCount(0);
});

test("a drop flies cards into the capsule; the count rolls", async ({ page }) => {
  await pick(page, sidebar(page).getByRole("button", { name: "interfaces", exact: true }));
  await toCapsule(page);
  await watch(page, "[data-bundle-flyer]");
  await page.mouse.up();
  await expect.poll(() => seen(page)).toBe(true);
  await expect(page.locator("[data-bundle-flyer]")).toHaveCount(0);
  await expect(capsule(page).locator("[data-bundle-count]")).toHaveText("2");
  // A second drop: the old count rolls out as the new one comes in.
  await pick(page, sidebar(page).locator("[data-feed-row]").first());
  await toCapsule(page);
  await watch(page, ".bundle-roll-out", "2");
  await page.mouse.up();
  await expect.poll(() => seen(page)).toBe(true);
  await expect(capsule(page).locator("[data-bundle-count]")).toHaveText("3");
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("nothing moves; a 2 px accent border shows for 300 ms", async ({ page }) => {
    await pick(page, sidebar(page).getByRole("button", { name: "interfaces", exact: true }));
    await toCapsule(page);
    await expect(capsule(page)).toHaveAttribute("data-near", "");
    // Near and over, it holds still.
    await expect(capsuleButton(page)).toHaveCSS("transform", "none");
    await expect(capsule(page).locator(".bundle-fan")).toHaveCSS("transform", "none");
    await watch(page, "[data-bundle-flyer]");
    await page.mouse.up();
    // Away from it, so the ring is the landing's and not the hover's.
    await page.mouse.move(700, 300);
    await expect(capsule(page)).toHaveAttribute("data-landed", "");
    await expect(capsule(page).locator(".bundle-shell")).toHaveCSS("box-shadow", /0px 0px 0px 2px inset$/);
    expect(await capsule(page).evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
    await expect(capsule(page)).not.toHaveAttribute("data-landed");
    await expect(capsule(page).locator(".bundle-shell")).toHaveCSS("box-shadow", /0px 0px 0px 1px inset$/);
    expect(await seen(page)).toBe(false);
    await expect(capsule(page).locator("[data-bundle-count]")).toHaveText("2");
    await expect(announcer(page)).toHaveText("Added interfaces to the bundle, 2 items");
  });
});
