// Nested collections (2.19.0, frames N1–N7): the sidebar's tree, its drags and keys, the row menu,
// «Icon and colour», a deleted parent's children moving up, «Only this collection», and the bookmark
// menu's «Move to» with a field past eight collections.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { openApp } from "../fixtures/app";

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Library" });
const tree = (page: Page) => sidebar(page).getByRole("tree", { name: "Collections" });
const row = (page: Page, name: string) => tree(page).locator("[data-collection-row]").filter({ has: page.locator(`.fade-end:text-is("${name}")`) });
const item = (page: Page, name: string) => row(page, name).locator("[data-collection]");
/** Every shown row as «level name». */
const rows = (page: Page) =>
  tree(page)
    .locator("[data-collection]")
    .evaluateAll((items) => items.map((i) => `${i.getAttribute("aria-level")} ${i.querySelector(".fade-end")?.textContent}`));

/**
 * Design · Development { Rust, Web { React }, Tools } · Inspiration · To read, with two bookmarks
 * moved into Rust and React so the totals add up.
 */
async function nested(page: Page) {
  await openApp(page, { viewport: { width: 1440, height: 900 } });
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const rust = await api.createCollection("Rust", 2);
    const web = await api.createCollection("Web", 2);
    const react = await api.createCollection("React", web.id);
    const tools = await api.createCollection("Tools", 2);
    // By name they would be Rust, Tools, Web.
    await api.moveCollection(tools.id, 2, null);
    const page = await api.getBookmarks({ collectionId: 2 }, {});
    await api.updateBookmark(page.items[0].id, { collection_id: rust.id });
    const all = await api.getBookmarks({}, {});
    const loose = all.items.find((b) => b.collection_id === null || b.collection_id === 3)!;
    await api.updateBookmark(loose.id, { collection_id: react.id });
  });
  await page.reload();
  await expect(item(page, "React")).toBeVisible();
}

async function drag(page: Page, from: Locator, to: Locator, at: number) {
  await from.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const a = (await from.boundingBox())!;
  await page.mouse.move(a.x + 60, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 66, a.y + a.height / 2 + 5, { steps: 3 });
  const b = (await to.boundingBox())!;
  await page.mouse.move(b.x + 70, b.y + b.height * at, { steps: 10 });
}

test.beforeEach(({ page }) => nested(page));

test("the tree: levels, totals, chevrons that fold and are remembered, arrows that move and fold", async ({ page }) => {
  expect(await rows(page)).toEqual(["1 Design", "1 Development", "2 Rust", "2 Web", "3 React", "2 Tools", "1 Inspiration", "1 To read"]);
  // Development's total is its own and everything inside it.
  const own = Number(await item(page, "Rust").locator("span.text-xs").innerText());
  expect(own).toBeGreaterThan(0);
  await expect(item(page, "Development")).toHaveAttribute("aria-expanded", "true");
  await expect(item(page, "Rust")).not.toHaveAttribute("aria-expanded");
  await expect(item(page, "Web")).toHaveAttribute("aria-setsize", "3");
  await expect(item(page, "Web")).toHaveAttribute("aria-posinset", "2");

  // One row in the tab order; the chevron folds, and the fold survives a reload.
  await expect(tree(page).locator("[data-collection][tabindex='0']")).toHaveCount(1);
  await item(page, "Development").locator("[data-fold]").click();
  expect(await rows(page)).toEqual(["1 Design", "1 Development", "1 Inspiration", "1 To read"]);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("All bookmarks");
  await page.reload();
  await expect(item(page, "Development")).toHaveAttribute("aria-expanded", "false");

  // → opens, → again goes to the first child, ↓ to the next, ← to the parent, ← folds.
  await item(page, "Development").focus();
  await page.keyboard.press("ArrowRight");
  await expect(item(page, "Development")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowRight");
  await expect(item(page, "Rust")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(item(page, "React")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(item(page, "Web")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(item(page, "Web")).toHaveAttribute("aria-expanded", "false");
  await expect(item(page, "React")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Web");
  await page.screenshot({ path: "test-results/tree-n1.png" });
});

test("a drag into the middle of a row puts the collection inside it; into a quarter, between rows", async ({ page }) => {
  // Into Design (frame N2): the row lit, the hint under the ghost.
  await drag(page, item(page, "Inspiration"), item(page, "Design"), 0.5);
  await expect(page.locator("[data-drop-hint]")).toHaveText("Into Design");
  await expect(item(page, "Design")).toHaveClass(/bg-accent-soft/);
  await expect(sidebar(page).locator("[data-landing]")).toHaveCount(0);
  await page.screenshot({ path: "test-results/tree-n2.png" });
  await page.mouse.up();
  expect(await rows(page)).toEqual(["1 Design", "2 Inspiration", "1 Development", "2 Rust", "2 Web", "3 React", "2 Tools", "1 To read"]);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("All bookmarks");

  // Below Rust (frame N3): a line at Rust's level, «Into Development, after Rust».
  await drag(page, item(page, "To read"), item(page, "Rust"), 0.9);
  await expect(page.locator("[data-drop-hint]")).toHaveText("Into Development, after Rust");
  await expect(sidebar(page).locator("[data-landing]")).toHaveCount(1);
  await page.screenshot({ path: "test-results/tree-n3.png" });
  await page.mouse.up();
  expect(await rows(page)).toEqual(["1 Design", "2 Inspiration", "1 Development", "2 Rust", "2 To read", "2 Web", "3 React", "2 Tools"]);

  // Onto its own child, or deeper than three levels: nothing lights up, nothing moves.
  await drag(page, item(page, "Development"), item(page, "Web"), 0.5);
  await expect(page.locator("[data-drop-hint]")).toHaveCount(0);
  await page.mouse.up();
  await drag(page, item(page, "Web"), item(page, "Inspiration"), 0.5);
  await expect(page.locator("[data-drop-hint]")).toHaveCount(0);
  await page.mouse.up();
  expect(await rows(page)).toEqual(["1 Design", "2 Inspiration", "1 Development", "2 Rust", "2 To read", "2 Web", "3 React", "2 Tools"]);

  // After a reload the tree is the database's.
  await page.reload();
  expect(await rows(page)).toEqual(["1 Design", "2 Inspiration", "1 Development", "2 Rust", "2 To read", "2 Web", "3 React", "2 Tools"]);
});

test("a folded parent opens under a drag after a moment", async ({ page }) => {
  await item(page, "Development").locator("[data-fold]").click();
  await drag(page, item(page, "Design"), item(page, "Development"), 0.5);
  await expect(item(page, "Rust")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(item(page, "Rust")).toHaveCount(0);
});

test("Alt arrows move a collection among its siblings, into the one above and out, and say where", async ({ page }) => {
  const said = sidebar(page).locator("[aria-live=polite]").first();
  await item(page, "Tools").focus();
  await page.keyboard.press("Alt+ArrowUp");
  expect(await rows(page)).toEqual(["1 Design", "1 Development", "2 Rust", "2 Tools", "2 Web", "3 React", "1 Inspiration", "1 To read"]);
  await expect(said).toHaveText("Tools moved into Development, 2 of 3");
  await expect(item(page, "Tools")).toBeFocused();
  await page.keyboard.press("Alt+ArrowRight");
  expect(await rows(page)).toEqual(["1 Design", "1 Development", "2 Rust", "3 Tools", "2 Web", "3 React", "1 Inspiration", "1 To read"]);
  await expect(said).toHaveText("Tools moved into Rust, 1 of 1");
  await page.keyboard.press("Alt+ArrowLeft");
  await page.keyboard.press("Alt+ArrowLeft");
  expect(await rows(page)).toEqual(["1 Design", "1 Development", "2 Rust", "2 Web", "3 React", "1 Tools", "1 Inspiration", "1 To read"]);
  await expect(said).toHaveText("Tools moved to the top level, 3 of 5");
  await expect(item(page, "Tools")).toBeFocused();
  // Web { React } under Rust would take four levels: refused, nothing moves.
  await item(page, "Web").focus();
  await page.keyboard.press("Alt+ArrowRight");
  expect(await rows(page)).toContain("2 Web");
  await expect(item(page, "Web")).toBeFocused();
});

test("the row menu renames in place, styles the collection and makes one inside", async ({ page }) => {
  await row(page, "Web").hover();
  await row(page, "Web").getByRole("button", { name: "Web: more" }).click();
  const menu = page.getByRole("menu", { name: "Web: more" });
  await expect(menu.getByRole("menuitem")).toHaveText([/Rename\s*F2/, /Icon and colour…/, /New collection inside/, /Move to/, /Delete…/]);
  await menu.getByRole("menuitem", { name: /Move to/ }).hover();
  const moveTo = page.getByRole("menu", { name: "Move to" });
  // Without itself and its own, its parent ticked, the hint of the keys at the end.
  await expect(moveTo.getByRole("menuitem")).toHaveText([/Top level/, /Design/, /Development/, /Rust/, /Tools/, /Inspiration/, /To read/]);
  await expect(moveTo).toContainText("Alt ← → ↑ ↓ move it in the sidebar");
  await page.screenshot({ path: "test-results/tree-n4.png" });
  await menu.getByRole("menuitem", { name: /Rename/ }).click();
  const field = sidebar(page).getByRole("textbox", { name: "New name for Web" });
  await expect(field).toBeFocused();
  await field.fill("Frontend");
  await page.keyboard.press("Enter");
  await expect(item(page, "Frontend")).toBeFocused();
  await page.reload();
  await expect(item(page, "Frontend")).toBeVisible();

  // F2, a taken name: refused with the reason, the old name stays.
  await item(page, "Frontend").focus();
  await page.keyboard.press("F2");
  await sidebar(page).getByRole("textbox", { name: "New name for Frontend" }).fill("design");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Another collection already has this name.")).toBeVisible();
  await expect(item(page, "Frontend")).toBeVisible();

  // Icon and colour (frame N5): each pick shows at once.
  await row(page, "Frontend").hover();
  await row(page, "Frontend").getByRole("button", { name: "Frontend: more" }).click();
  await page.getByRole("menuitem", { name: /Icon and colour/ }).click();
  const style = page.getByRole("dialog", { name: "Icon and colour of Frontend" });
  await expect(style.getByRole("radio")).toHaveCount(45);
  await style.getByRole("radio", { name: "globe" }).click();
  await style.getByRole("radio", { name: "Blue" }).click();
  await expect(style.getByRole("radio", { name: "globe" })).toHaveAttribute("aria-checked", "true");
  await expect(item(page, "Frontend").locator("svg.lucide-globe")).toBeVisible();
  await page.screenshot({ path: "test-results/tree-n5.png" });
  await style.getByRole("textbox", { name: "Or type an emoji" }).fill("🚀");
  await expect(item(page, "Frontend")).toContainText("🚀");
  await style.getByRole("button", { name: "Use a dot" }).click();
  await style.getByRole("button", { name: "Done" }).click();
  await expect(style).toHaveCount(0);
  await expect(item(page, "Frontend").locator("svg.lucide-globe")).toHaveCount(0);
  const stored = await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    return (await api.getCollections()).find((c) => c.name === "Frontend");
  });
  expect(stored).toMatchObject({ color: "blue", icon: null });

  // New collection inside: the dialog names the parent; React's level is the last one.
  await row(page, "Rust").hover();
  await row(page, "Rust").getByRole("button", { name: "Rust: more" }).click();
  await page.getByRole("menuitem", { name: "New collection inside" }).click();
  await page.getByRole("dialog", { name: "New collection in Rust" }).getByRole("textbox").fill("Crates");
  await page.keyboard.press("Enter");
  await expect(item(page, "Crates")).toHaveAttribute("aria-level", "3");
  await row(page, "Crates").hover();
  await row(page, "Crates").getByRole("button", { name: "Crates: more" }).click();
  await expect(page.getByRole("menuitem", { name: "New collection inside" })).toHaveAttribute("aria-disabled", "true");
});

test("deleting a parent moves its children up a level, into its place", async ({ page }) => {
  await row(page, "Development").hover();
  await row(page, "Development").getByRole("button", { name: "Development: more" }).click();
  await page.getByRole("menuitem", { name: /Delete/ }).click();
  const dialog = page.getByRole("dialog", { name: "Delete collection?" });
  await expect(dialog).toContainText("Rust, Web, and Tools move up a level, with everything inside them.");
  await page.screenshot({ path: "test-results/tree-n6.png" });
  await dialog.getByRole("button", { name: "Delete" }).click();
  expect(await rows(page)).toEqual(["1 Design", "1 Rust", "1 Web", "2 React", "1 Tools", "1 Inspiration", "1 To read"]);
});

test("a parent shows what is inside it; «Only this collection» leaves that out", async ({ page }) => {
  await item(page, "Development").click();
  const header = page.locator("[data-collection-header]");
  await expect(header.getByRole("button")).toHaveText([/^Rust\s*\d+$/, /^Web\s*1$/, /^Tools\s*0$/]);
  const total = Number(await item(page, "Development").locator("span.text-xs").innerText());
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(total);
  const only = header.getByRole("checkbox", { name: "Only this collection" });
  await only.check();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(total - 2);
  // Another section and back: the checkbox starts off.
  await header.getByRole("button", { name: /^Web/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Web");
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  await item(page, "Development").click();
  await expect(only).not.toBeChecked();
});

test("«Move to collection» of a bookmark is the tree; past eight collections a field finds one by its path", async ({ page }) => {
  const card = page.locator("[data-bookmark-id]").first();
  await card.hover();
  await card.getByRole("button", { name: /^Actions: / }).click();
  await page.getByRole("menuitem", { name: "Move to collection" }).click();
  const menu = page.getByRole("menu", { name: "Move to collection" });
  await expect(menu.getByRole("searchbox")).toHaveCount(0);
  await expect(menu.getByRole("menuitem").nth(4)).toHaveText(/^React\s*5$/);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    await api.createCollection("Recipes");
  });
  await page.reload();
  await card.hover();
  await card.getByRole("button", { name: /^Actions: / }).click();
  await page.getByRole("menuitem", { name: "Move to collection" }).click();
  const field = menu.getByRole("searchbox", { name: "Find a collection" });
  await expect(field).toBeFocused();
  await field.fill("rea");
  await expect(menu.getByRole("menuitem")).toHaveText([/^Development › Web › React/, /^To read/]);
  await page.screenshot({ path: "test-results/tree-n7.png" });
  await page.keyboard.press("Enter");
  await expect(page.locator("[role=status], [data-notice]").filter({ hasText: "React" }).first()).toBeVisible();
});

test("a narrow window shows the top level only, its dots moving among themselves", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 550 });
  const strip = sidebar(page);
  const dots = () => strip.locator("[data-collection]").evaluateAll((items) => items.map((i) => i.getAttribute("aria-label")));
  expect(await dots()).toEqual(["Design", "Development", "Inspiration", "To read"]);
  await strip.locator("[data-collection]").nth(1).focus();
  await page.keyboard.press("Alt+ArrowDown");
  expect(await dots()).toEqual(["Design", "Inspiration", "Development", "To read"]);
});
