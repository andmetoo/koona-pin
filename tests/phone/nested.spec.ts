import { expect, type Page, test } from "@playwright/test";
import { openPhone, topScreen } from "./fixtures";

// Nested collections on the phone (2.19.0, frames N8 and N9): the Library's second chip row and the
// picker's tree, on the demo backend with a small tree seeded over its sample collections.

/** Design, Development > Inspiration > To read: the sample's four collections, two nested. */
async function nest(page: Page) {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const collections = (await api.getCollections()).map((c) => ({ ...c, parent_id: c.name === "Inspiration" ? 2 : c.name === "To read" ? 3 : null }));
    localStorage.setItem("koonapin.demo.v4", JSON.stringify({ bookmarks: (await api.getBookmarks()).items, collections }));
  });
  await page.reload();
  await expect(page.locator("[data-phone]")).toBeVisible();
}

const chips = (page: Page) => topScreen(page).locator(".lib-chips:not(.lib-chips-sub)");
const subChips = (page: Page) => topScreen(page).locator(".lib-chips-sub");

test("N8: a collection with children opens a second row of chips, a level at a time", async ({ page }) => {
  await openPhone(page);
  await nest(page);
  // Row 1: All, Favorites and the top level only; nothing under it for All.
  await expect(chips(page).getByRole("button")).toHaveText([/^All$/, /^Favorites$/, /^Design$/, /^Development$/]);
  await expect(subChips(page)).toHaveCount(0);

  // A top-level collection without children has no second row.
  await chips(page).getByRole("button", { name: "Design" }).click();
  await expect(subChips(page)).toHaveCount(0);

  // A parent: "All" of it (active) and its children.
  await chips(page).getByRole("button", { name: "Development" }).click();
  const sub = subChips(page);
  await expect(sub.getByRole("button")).toHaveText([/^All \d+$/, /^Inspiration \d+$/]);
  await expect(sub.getByRole("button", { name: "All in Development" })).toHaveAttribute("aria-pressed", "true");
  await expect(chips(page).getByRole("button", { name: "Development" })).toHaveAttribute("aria-pressed", "true");

  // Deeper: the row is that collection's children, with "All" of the current one.
  await sub.getByRole("button", { name: /^Inspiration/ }).click();
  await expect(sub.getByRole("button")).toHaveText([/^All \d+$/, /^To read \d+$/]);
  await expect(sub.getByRole("button", { name: "All in Inspiration" })).toHaveAttribute("aria-pressed", "true");
  // The top-level chip keeps marking the branch.
  await expect(chips(page).getByRole("button", { name: "Development" })).toHaveAttribute("aria-pressed", "true");

  // A collection without children stays among its siblings; "All" steps back up to the parent.
  await sub.getByRole("button", { name: /^To read/ }).click();
  await expect(sub.getByRole("button", { name: /^To read/ })).toHaveAttribute("aria-pressed", "true");
  await expect(sub.getByRole("button", { name: "All in Inspiration" })).toHaveAttribute("aria-pressed", "false");
  await sub.getByRole("button", { name: "All in Inspiration" }).click();
  await expect(sub.getByRole("button", { name: "All in Inspiration" })).toHaveAttribute("aria-pressed", "true");

  // The top-level chip goes back to the branch's root, and All clears the row.
  await chips(page).getByRole("button", { name: "Development" }).click();
  await expect(sub.getByRole("button", { name: "All in Development" })).toHaveAttribute("aria-pressed", "true");
  await chips(page).getByRole("button", { name: "All", exact: true }).click();
  await expect(subChips(page)).toHaveCount(0);
});

test("N8: the header counts a parent with everything inside it", async ({ page }) => {
  await openPhone(page);
  await nest(page);
  await chips(page).getByRole("button", { name: "Development" }).click();
  const total = Number((await subChips(page).getByRole("button", { name: "All in Development" }).textContent())!.match(/\d+/)![0]);
  await expect(topScreen(page).locator(".ph-header .ph-meta")).toHaveText(new RegExp(`^${total} links?$`));
});

test("N9: the picker is a tree: parents fold, the chosen one's ancestors stay open, a search lists paths", async ({ page }) => {
  await openPhone(page);
  await nest(page);
  const sheet = page.locator('[data-sheet-kind="collectionPicker"]');
  const row = (name: string) => sheet.getByRole("radio", { name: new RegExp(`^${name}(?= |$)`) });
  const open = async () => {
    const first = topScreen(page).locator("[data-bookmark-id]").first();
    const box = (await first.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 20);
    await page.mouse.down();
    await page.waitForTimeout(650);
    await page.mouse.up();
    await page.locator('[data-sheet-kind="bookmarkMenu"]').getByRole("button", { name: "Move to collection" }).click();
    await expect(sheet.getByRole("dialog", { name: "File into collection" })).toBeVisible();
  };
  await open();
  // Everything open: children indented under their parent, in the tree's order.
  const names = sheet.locator(".cp-line .cp-name");
  await expect(names).toHaveText(["Design", "Development", "Inspiration", "To read"]);
  const indent = async (name: string) => Math.round((await row(name).locator(".cp-name").boundingBox())!.x);
  const [design, inspiration, toRead] = [await indent("Design"), await indent("Inspiration"), await indent("To read")];
  expect(inspiration - design).toBe(20);
  expect(toRead - inspiration).toBe(20);

  // Folding Development hides what is inside it; its chevron says so.
  const fold = sheet.getByRole("button", { name: "Inside Development" });
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(names).toHaveText(["Design", "Development"]);
  await fold.click();
  await expect(names).toHaveText(["Design", "Development", "Inspiration", "To read"]);

  // A choice deep in the tree keeps its ancestors open.
  await row("To read").click();
  await expect(row("To read")).toHaveAttribute("aria-checked", "true");
  await sheet.getByRole("button", { name: "Inside Development" }).click({ force: true });
  await expect(names).toHaveText(["Design", "Development", "Inspiration", "To read"]);

  // A search shows the matches flat, with the path in front.
  await sheet.getByRole("searchbox", { name: "Find or create" }).fill("read");
  await expect(names).toHaveText(["Development › Inspiration › To read"]);
  await expect(sheet.locator(".cp-path")).toHaveText("Development › Inspiration › ");
});
