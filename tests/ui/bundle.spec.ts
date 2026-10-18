// The bundle (share-bundle.md, piece B): the capsule, the panel and its ways in, against the browser
// preview; the system Save dialog is mocked.
import { test, expect, type Page } from "@playwright/test";
import { openApp } from "../fixtures/app";

const capsule = (page: Page) => page.locator("[data-bundle-capsule] > button").first();
const panel = (page: Page) => page.getByRole("dialog", { name: /./ }).and(page.locator("[data-bundle-panel]"));
const bar = (page: Page) => page.getByRole("toolbar", { name: "Selected bookmarks" });
const announcer = (page: Page) => page.locator("[data-announcer]");
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Library" });
const card = (page: Page, title: string) =>
  page.locator("article[data-bookmark-id]").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
const rows = (page: Page) => panel(page).locator("[data-bundle-row] > button[aria-expanded]");

async function select(page: Page, titles: string[]) {
  for (const title of titles) await card(page, title).locator("h2").first().click({ modifiers: ["ControlOrMeta"] });
  await expect(bar(page).getByRole("status")).toHaveText(`${titles.length} selected`);
}
async function addSelection(page: Page) {
  await bar(page).getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: /^Add to bundle/ }).click();
}
async function openFromMenu(page: Page) {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Share as list…/ }).click();
  await expect(panel(page)).toBeVisible();
}
/** Save answers as the desktop app would, and keeps what it was given. */
async function mockSave(page: Page, delay = 0) {
  await page.evaluate(async (delay) => {
    const { bundleApi } = await import("/src/services/bundleApi.ts");
    const { titleFileName } = await import("/src/services/listText.ts");
    const calls: { text: string; id: string; name?: string }[] = [];
    (window as unknown as { saveCalls: typeof calls }).saveCalls = calls;
    bundleApi.save = async (text, id, name) => {
      calls.push({ text, id, name });
      // The system dialog takes a while to come up.
      await new Promise((done) => setTimeout(done, delay));
      return { outcome: "saved", file_name: name === undefined ? `${id}.kpin` : titleFileName(name), count: 1 };
    };
  }, delay);
}
const saveCalls = (page: Page) => page.evaluate(() => (window as unknown as { saveCalls: { text: string; id: string; name?: string }[] }).saveCalls);

test.beforeEach(({ page }) => openApp(page, { viewport: { width: 1200, height: 800 }, settings: { view: "grid" }, cards: 6 }));

test("Export → Add to bundle; the capsule sits above the bulk bar and comes down without it", async ({ page }) => {
  await expect(page.locator("[data-bundle-capsule]")).toHaveCount(0);
  await select(page, ["The architecture of silence", "Typography is a voice"]);
  await addSelection(page);
  await expect(announcer(page)).toHaveText("Added 2 bookmarks to the bundle, 2 items");
  await expect(capsule(page)).toHaveAccessibleName("Bundle, 2 items");
  const bottom = async () => 800 - (await capsule(page).boundingBox())!.y - (await capsule(page).boundingBox())!.height;
  // 24 + 52 (the bar) + 12 above the window's bottom while the bar shows (S6), never beside it.
  expect(Math.round(await bottom())).toBe(88);
  // Again: nothing new comes in.
  await addSelection(page);
  await expect(announcer(page)).toHaveText("Already in the bundle, 2 items");
  await page.keyboard.press("Escape");
  await expect(bar(page)).toHaveCount(0);
  await expect.poll(async () => Math.round(await bottom())).toBe(24);
});

test("«Add {view}» adds a collection, a tag, All bookmarks and a feed, each as its section says", async ({ page }) => {
  await sidebar(page).getByRole("button", { name: /^Development/ }).click();
  await openFromMenu(page);
  // The empty bundle: the button of the empty state, focused.
  await expect(panel(page).locator("[data-bundle-empty]")).toBeVisible();
  const addDev = panel(page).getByRole("button", { name: /^Add Development · 1$/ });
  await expect(addDev).toBeFocused();
  await addDev.click();
  await expect(announcer(page)).toHaveText("Added Development to the bundle, 1 item");
  await expect(panel(page).locator("[data-bundle-section]")).toHaveCount(1);
  await expect(panel(page).locator("[data-bundle-add]")).toHaveCount(0);
  await expect(panel(page).getByRole("textbox", { name: "Title" })).toHaveValue("Development");

  // A tag of All bookmarks.
  await sidebar(page).getByRole("button", { name: "All bookmarks" }).click();
  const tag = sidebar(page).getByRole("button", { name: "design", exact: true });
  await tag.click();
  await panel(page).locator("[data-bundle-add]").click();
  await expect(panel(page).locator("[data-bundle-section='tag:design']")).toBeVisible();
  await expect(panel(page).getByRole("textbox", { name: "Title" })).toHaveValue("Development and 1 more");
  await tag.click();

  // All bookmarks: what is not in yet goes to Links, on top.
  await panel(page).getByRole("button", { name: /^Add All bookmarks · 6$/ }).click();
  await expect(announcer(page)).toHaveText(/^Added \d bookmarks? to the bundle, 6 items$/);
  await expect(panel(page).locator("[data-bundle-section]").first()).toHaveAttribute("data-bundle-section", "links");
  await expect(panel(page).locator("[data-bundle-add]")).toHaveCount(0);

  // A feed: into Feeds, last.
  await sidebar(page).getByRole("button", { name: /^The Verge \d/ }).click();
  await panel(page).getByRole("button", { name: /^Add The Verge · 1$/ }).click();
  await expect(panel(page).locator("[data-bundle-section]").last()).toHaveAttribute("data-bundle-section", "feeds");
  await expect(panel(page).locator("[data-bundle-meta]")).toHaveText("7 items · CC0, anyone may reuse it");
  await expect(capsule(page)).toHaveAccessibleName("Bundle, 7 items");
});

test("keyboard only: Tab to the capsule, Enter, F6 both ways, Delete a row, Esc back to the capsule", async ({ page }) => {
  await select(page, ["Typography is a voice", "Notes on attention"]);
  await addSelection(page);
  await page.keyboard.press("Escape");
  await expect(bar(page)).toHaveCount(0);
  // The capsule is in the tab order after the list.
  await card(page, "Notes on attention").focus();
  for (let i = 0; i < 40 && !(await capsule(page).evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(capsule(page)).toBeFocused();
  await expect(capsule(page)).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(panel(page)).toHaveAttribute("aria-modal", "false");
  await expect(capsule(page)).toHaveAttribute("aria-expanded", "true");
  await expect(rows(page).first()).toBeFocused();
  await page.keyboard.press("F6");
  await expect(page.locator("[data-view] [data-bookmark-id]:focus")).toHaveCount(1);
  await page.keyboard.press("F6");
  await expect(rows(page).first()).toBeFocused();
  // Enter opens a row; Delete removes the focused one and leaves the library alone.
  await page.keyboard.press("Enter");
  await expect(rows(page).first()).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Delete");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toBeFocused();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(capsule(page)).toBeFocused();
  // From ⋯ the focus goes back to ⋯.
  await openFromMenu(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "More", exact: true })).toBeFocused();
});

test("Save writes the built list under the title's name; Copy gives Markdown; Clear has Undo", async ({ page, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockSave(page);
  await sidebar(page).getByRole("button", { name: /^Design/ }).click();
  await openFromMenu(page);
  await panel(page).getByRole("button", { name: /^Add Design/ }).click();
  await panel(page).getByRole("button", { name: "Add description and author" }).click();
  await panel(page).getByRole("textbox", { name: "Description" }).fill("Two good reads.");
  await panel(page).getByRole("button", { name: "Save .kpin…" }).click();
  await expect(panel(page).getByRole("status")).toContainText("Saved design.kpin");
  await expect(panel(page).getByRole("button", { name: "Show" })).toBeVisible();
  const [call] = await saveCalls(page);
  expect(call.id).toBe("design");
  const file = JSON.parse(call.text);
  expect(file).toMatchObject({ format: "koona", title: "Design", description: "Two good reads.", license: "CC0-1.0" });
  expect(file.sections).toEqual([expect.objectContaining({ name: "Design" })]);
  // The contents stay after a save.
  await expect(rows(page)).toHaveCount(2);

  await panel(page).getByRole("button", { name: "Copy as Markdown" }).click();
  await expect(panel(page).getByRole("status")).toHaveText(/^Copied 2 links as Markdown/);
  if (browserName === "chromium") expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^# Design\n\nTwo good reads\.\n\n## Design\n\n- \[/);

  await panel(page).getByRole("button", { name: "Clear", exact: true }).click();
  await expect(panel(page).locator("[data-bundle-empty]")).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Save .kpin…" })).toBeDisabled();
  await expect(panel(page).getByRole("button", { name: "Copy as Markdown" })).toBeDisabled();
  await panel(page).getByRole("button", { name: "Undo" }).click();
  await expect(rows(page)).toHaveCount(2);
});

test("a double click on Save opens one dialog; a title in Cyrillic names the file, the id stays ASCII", async ({ page }) => {
  await mockSave(page, 300);
  await sidebar(page).getByRole("button", { name: /^Design/ }).click();
  await openFromMenu(page);
  await panel(page).getByRole("button", { name: /^Add Design/ }).click();
  await panel(page).getByRole("textbox", { name: "Title" }).fill("Мои ссылки");
  // Two clicks before React renders again, as a fast double click on a busy machine lands.
  await panel(page)
    .getByRole("button", { name: "Save .kpin…" })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect(panel(page).getByRole("status")).toContainText("Saved мои-ссылки.kpin");
  const calls = await saveCalls(page);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ id: "", name: "Мои ссылки" });
  const file = JSON.parse(calls[0].text);
  expect(file.title).toBe("Мои ссылки");
  expect(file).not.toHaveProperty("id");
});

test("× hides the resting capsule; a drag brings it back and a drop on it adds", async ({ page }) => {
  await select(page, ["Typography is a voice"]);
  await addSelection(page);
  await page.keyboard.press("Escape");
  await capsule(page).hover();
  await page.getByRole("button", { name: "Hide the bundle" }).click();
  await expect(page.locator("[data-bundle-capsule]")).toHaveCount(0);
  // Still there: ⋯ says how many and opens it.
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /^Share as list…/ })).toContainText("1");
  await page.keyboard.press("Escape");

  await select(page, ["The architecture of silence", "Noticing the everyday"]);
  const target = page.locator("[data-bundle-capsule]");
  const preview = page.locator("[data-bookmark-id][data-selected] [data-preview]").first();
  const a = (await preview.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 8, { steps: 3 });
  await expect(target).toBeVisible();
  await expect(target).not.toHaveAttribute("data-over");
  const b = (await target.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
  await expect(target).toHaveAttribute("data-over", "");
  await expect(target).toContainText("Add 2 bookmarks to bundle");
  await expect(page.locator("[data-drop-hint]")).toHaveText("Add 2 bookmarks to bundle");
  await page.mouse.up();
  await expect(announcer(page)).toHaveText("Added 2 bookmarks to the bundle, 3 items");
  // Hidden for the session: after the drop it rests hidden again.
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-bundle-capsule]")).toHaveCount(0);
  await openFromMenu(page);
  await expect(rows(page)).toHaveCount(3);
});

test("the sidebar has no right-click menus; a reload empties the bundle", async ({ page }) => {
  for (const row of [
    sidebar(page).locator("[data-collection-row]").first(),
    sidebar(page).getByRole("button", { name: /^All feeds/ }),
    sidebar(page).locator("[data-feed-row]").first(),
  ]) {
    await row.click({ button: "right" });
    await expect(page.locator("[role=menu]")).toHaveCount(0);
  }
  await select(page, ["Typography is a voice"]);
  await addSelection(page);
  await expect(capsule(page)).toBeVisible();
  await page.reload();
  await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
  await expect(page.locator("[data-bundle-capsule]")).toHaveCount(0);
  await openFromMenu(page);
  await expect(panel(page).locator("[data-bundle-empty]")).toBeVisible();
});

test("a bookmark trashed while the panel is open leaves the bundle, and Save never writes it", async ({ page }) => {
  await mockSave(page);
  await select(page, ["Ten principles for good design", "Notes on attention"]);
  await addSelection(page);
  await page.keyboard.press("Escape");
  await openFromMenu(page);
  await expect(rows(page)).toHaveCount(2);
  await card(page, "Ten principles for good design").locator("h2").first().click({ modifiers: ["ControlOrMeta"] });
  await page.keyboard.press("Delete");
  await expect(card(page, "Ten principles for good design")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(1);
  await expect(panel(page).locator("[data-bundle-meta]")).toHaveText("1 item · CC0, anyone may reuse it · 1 item left the bundle");
  await panel(page).getByRole("button", { name: "Save .kpin…" }).click();
  await expect(panel(page).getByRole("status")).toContainText("Saved");
  const [call] = await saveCalls(page);
  expect(JSON.parse(call.text).items.map((i: { title: string }) => i.title)).toEqual(["Notes on attention"]);
});
