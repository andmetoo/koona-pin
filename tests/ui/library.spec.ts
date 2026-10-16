import { test, expect } from "@playwright/test";
// Safari uses Option-Tab for all controls; ordinary Tab follows its text-field preference.
const tabKey = (browserName: string, backwards = false) =>
  `${process.platform === "darwin" && browserName === "webkit" ? "Alt+" : ""}${backwards ? "Shift+" : ""}Tab`;
type Page = import("@playwright/test").Page;
type Locator = import("@playwright/test").Locator;
/** Where a plain click on a card or row selects it (NP-123): a card's title, a row's collection — no link, no button. */
const selectSpot = (card: Locator) => card.locator("[data-collection], h2:not(:has(a))").first();
/** The card or row of a bookmark, by its exact title. */
const bookmarkNamed = (page: Page, title: string) =>
  page.locator("article[data-bookmark-id]").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
/** A click on a card or row: alone it selects only it, with Ctrl it toggles, with Shift it adds the range. */
const clickCard = (card: Locator, modifiers?: ("ControlOrMeta" | "Shift")[]) => selectSpot(card).click({ modifiers });
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("koonapin.demo.v4"));
  await page.reload();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
});
test("hover keeps card and preview geometry stable", async ({ page }) => {
  const card = page.locator('[data-bookmark-id="1"]');
  const before = await card.boundingBox();
  const image = await card.locator("[data-preview]").boundingBox();
  await card.hover();
  await page.waitForTimeout(220);
  expect(await card.boundingBox()).toEqual(before);
  expect(await card.locator("[data-preview]").boundingBox()).toEqual(image);
});
test("search, favorites and list view", async ({ page }) => {
  await page.getByRole("textbox", { name: "Search the library" }).fill("ARCHITECTURE");
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  await page.getByRole("textbox", { name: "Search the library" }).fill("");
  await page.getByRole("button", { name: "Favorites 2" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(2);
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator('[data-view="list"]')).toBeVisible();
});
test("dialog restores focus and editor persists collection clearing", async ({ page }) => {
  const add = page.getByRole("button", { name: "Add link", exact: true });
  // WebKit on macOS does not focus a button on a mouse click. Test the keyboard-origin restore.
  await add.focus();
  await add.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(add).toBeFocused();
  await page.locator('[data-bookmark-id="1"]').hover();
  await page.getByRole("button", { name: /^Actions:/ }).first().click();
  await page.getByRole("menuitem", { name: "Edit…" }).click();
  await page.getByLabel("Collection", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator('[data-bookmark-id="1"] [data-collection]')).toContainText("No collection");
});
test("card menu moves a bookmark to a collection with the keyboard", async ({ page }) => {
  await page.locator('[data-bookmark-id="2"]').hover();
  await page.getByRole("button", { name: /^Actions: The architecture/ }).click();
  await expect(page.getByRole("menuitem").first()).toBeFocused();
  // Open, Copy, Edit, Favorite, Send to Reading (NP-121), Save for offline (NP-126), then Move.
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Move to collection" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("menuitem", { name: "Development" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  // Escape closes the menu and returns focus to its button.
  const trigger = page.getByRole("button", { name: /^Actions: The architecture/ });
  await page.locator('[data-bookmark-id="2"]').hover();
  await trigger.focus();
  await trigger.press("Enter");
  await expect(page.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator('[data-bookmark-id="2"] [data-collection]')).toContainText("Development");
});
for (const width of [800, 1200, 1600])
  test(`layout at ${width}px and both themes`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 800 ? 550 : 800 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    for (const [theme, label] of [
      ["light", "Light"],
      ["dark", "Dark"],
    ]) {
      await page.getByRole("radio", { name: label }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    }
    await page.getByRole("button", { name: "All bookmarks" }).click();
    await page.screenshot({ path: `test-results/library-${width}.png` });
  });
test("language: English by default, switches without a restart, «System» follows the system", async ({ page }) => {
  // A new install speaks English whatever the system says (NP-085).
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByLabel("Language", { exact: true })).toHaveValue("en");
  await page.getByLabel("Language", { exact: true }).selectOption("ru");
  await expect(page.getByRole("heading", { name: "Настройки" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  // The browser of the tests is English: «System» is English.
  await page.getByLabel("Язык", { exact: true }).selectOption("system");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
});
test("demo library is created in the interface's language and kept after a switch", async ({ page }) => {
  await expect(page.getByText("Ten principles for good design")).toBeVisible();
  await expect(page.getByRole("button", { name: "To read 1" })).toBeVisible();
  // The first change saves it: switching to Russian keeps the English library.
  await page.locator('[data-bookmark-id="4"]').hover();
  await page.locator('[data-bookmark-id="4"]').getByRole("button", { name: "Add to favorites" }).click();
  await expect(page.getByRole("button", { name: "Favorites 3" })).toBeVisible();
  await page.evaluate(() => localStorage.setItem("koonapin.language", "ru"));
  await page.reload();
  await expect(page.getByRole("button", { name: "Избранное 3" })).toBeVisible();
  await expect(page.getByText("Ten principles for good design")).toBeVisible();
  // Without a saved library the reload creates it again, now in Russian.
  await page.evaluate(() => localStorage.removeItem("koonapin.demo.v4"));
  await page.reload();
  await expect(page.getByText("Десять принципов хорошего дизайна")).toBeVisible();
  await expect(page.getByRole("button", { name: "Прочитать 1" })).toBeVisible();
});
test("incoming capture preserves reading position until explicitly revealed", async ({ page }) => {
  // A short window, so the six cards scroll.
  await page.setViewportSize({ width: 1200, height: 550 });
  const scroll = page.locator('[data-scroll="main"]');
  await scroll.evaluate((el) => (el.scrollTop = 180));
  const before = await scroll.evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(20);
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const { bookmark: incoming } = await api.addBookmark({
      url: "https://example.com/incoming",
      title: "Incoming capture",
    });
    await api.updateBookmark(incoming.id, {
      notes: "Metadata arrived before the next frame",
    });
  });
  await expect(page.getByRole("button", { name: "New bookmarks · 1" })).toBeVisible();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(before);
  await page.getByRole("button", { name: "New bookmarks · 1" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(7);
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(0);
});
test("inbox: new links wait there until a decision, the notification hides until a newer one", async ({ page }) => {
  const inbox = (count: number) => page.getByRole("button", { name: `Inbox ${count}`, exact: true });
  const banner = page.getByRole("region", { name: "New bookmarks" });
  const bell = page.locator("[data-notification-bell]");
  const centre = page.getByRole("dialog", { name: "Notifications" });
  const waiting = centre.locator('[data-notification="inbox"]');
  const cards = page.locator("[data-bookmark-id]");
  const capture = (url: string) =>
    page.evaluate(async (url) => {
      const { api } = await import("/src/services/api.ts");
      await api.addBookmark({ url, title: "From the browser" });
    }, url);
  // All bookmarks include the inbox; no banner over the list, the bell tells about it.
  await expect(inbox(2)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/All bookmarks\s*6/);
  await expect(banner).toHaveCount(0);
  await expect(bell).toHaveAccessibleName("Notifications, 1 new");
  await bell.click();
  await expect(waiting).toContainText("2 new in Inbox");
  await expect(waiting).toContainText("Keeping, filing or tossing them takes about a minute.");
  await page.keyboard.press("Escape");
  await inbox(2).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Inbox\s*2/);
  await expect(cards).toHaveCount(2);
  // In the section the banner stays: it is the way into triage, and it cannot be hidden there.
  await expect(banner.getByRole("button", { name: "Sort" })).toBeVisible();
  await expect(banner.getByRole("button", { name: "Hide until new bookmarks arrive" })).toHaveCount(0);
  // Search stays in the section.
  await page.getByRole("textbox", { name: "Search the library" }).fill("silence");
  await expect(cards).toHaveCount(1);
  await expect(page.getByText("1 of 2")).toBeVisible();
  await page.getByRole("textbox", { name: "Search the library" }).fill("");
  // A capture is in the inbox and its counter at once.
  await capture("https://example.com/captured");
  await expect(cards).toHaveCount(3);
  await expect(inbox(3)).toBeVisible();
  // A decision, here the star, takes a bookmark out of the inbox.
  await page.locator('[data-bookmark-id="2"]').hover();
  await page.locator('[data-bookmark-id="2"]').getByRole("button", { name: "Add to favorites" }).click();
  await expect(cards).toHaveCount(2);
  await expect(inbox(2)).toBeVisible();
  await expect(page.getByRole("button", { name: "Favorites 3" })).toBeVisible();

  // Hidden until a bookmark newer than the ones waiting arrives, also after a restart.
  await page.getByRole("button", { name: "All bookmarks" }).click();
  await bell.click();
  await waiting.getByRole("button", { name: "Hide until new bookmarks arrive" }).click();
  await expect(waiting).toHaveCount(0);
  await expect(centre).toContainText("Nothing new");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(cards).toHaveCount(7);
  await expect(bell).toHaveAccessibleName("Notifications");
  await expect(inbox(2)).toBeVisible();
  await capture("https://example.com/newer");
  await expect(bell).toHaveAccessibleName("Notifications, 1 new");
  await bell.click();
  await expect(waiting).toContainText("3 new in Inbox");
  await page.keyboard.press("Escape");

  // Nothing left: no notification, no badge, the empty inbox.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    for (const b of (await api.getBookmarks({ onlyInbox: true })).items) await api.updateBookmark(b.id, { notes: "Decided" });
  });
  await bell.click();
  await expect(waiting).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(page.getByRole("heading", { name: "All sorted" })).toBeVisible();
});
test("trash: delete without a dialog, undo, restore with every field, a link saved again comes back", async ({ page }) => {
  const nav = (name: string) => page.getByRole("button", { name, exact: true });
  const cards = page.locator("[data-bookmark-id]");
  const toast = page.locator(".fixed[role=status]");
  // The context menu works on a card and on a row alike.
  const trashCard = async (id: number) => {
    await page.locator(`[data-bookmark-id="${id}"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to trash" }).click();
  };
  // The undo notice: its button, then Ctrl Z.
  await trashCard(1);
  await expect(toast).toContainText("Moved to Trash");
  await expect(cards).toHaveCount(5);
  await toast.getByRole("button", { name: /Undo/ }).click();
  await expect(cards).toHaveCount(6);
  await trashCard(1);
  await expect(nav("Trash 1")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(toast).toContainText("Back from Trash: «Ten principles for good design»");
  await expect(nav("Trash 0")).toBeVisible();

  // In the trash: out of counts and search, newest deletion first, days left, the note.
  await trashCard(3);
  await trashCard(1);
  await expect(nav("Favorites 0")).toBeVisible();
  await expect(nav("All bookmarks 4")).toBeVisible();
  await expect(nav("Design 0")).toBeVisible();
  await page.getByRole("textbox", { name: "Search the library" }).fill("principles");
  await expect(cards).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search the library" }).fill("");
  await nav("Trash 2").click();
  await expect(page.getByText(/Restore brings one back with its note/)).toBeVisible();
  await expect(page.getByRole("region", { name: "New bookmarks" })).toHaveCount(0);
  await expect(cards.first()).toHaveAttribute("data-bookmark-id", "1");
  await expect(cards.first()).toContainText("30 days left");
  await page.getByRole("textbox", { name: "Search the library" }).fill("typography");
  await expect(cards).toHaveCount(1);
  await page.getByRole("textbox", { name: "Search the library" }).fill("");

  // Restore brings back the star, the collection and the tags.
  await page.getByRole("button", { name: "List", exact: true }).click();
  const row = page.locator('[data-bookmark-id="1"]');
  await row.hover();
  await row.getByRole("button", { name: "Restore" }).click();
  await expect(cards).toHaveCount(1);
  await nav("Favorites 1").click();
  await expect(row).toContainText("Design");
  await expect(row.getByRole("button", { name: "principles", exact: true })).toBeVisible();

  // Added again by hand: back from the trash, waiting in the inbox.
  await page.getByRole("button", { name: "Add link", exact: true }).click();
  await page.getByLabel("Link", { exact: true }).fill("https://type.today/en");
  await page.getByRole("button", { name: "Save link" }).click();
  await expect(toast).toContainText("Back from Trash, waiting in Inbox");
  await expect(nav("Trash 0")).toBeVisible();
  await expect(nav("Inbox 3")).toBeVisible();
  // Added once more: it is in the library already, and the notice says nothing changed.
  await page.getByRole("button", { name: "Add link", exact: true }).click();
  await page.getByLabel("Link", { exact: true }).fill("https://type.today/en");
  await page.getByRole("button", { name: "Save link" }).click();
  await expect(toast).toContainText("This link is already in the library; nothing changed");
  await expect(nav("Inbox 3")).toBeVisible();

  // An import leaves a link in the trash where it is and says so.
  await trashCard(3);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: /Browser bookmarks/ }).click();
  await page.locator("input[type=file]").setInputFiles({
    name: "bookmarks.html",
    mimeType: "text/html",
    buffer: Buffer.from('<a href="https://type.today/en">Typography</a>'),
  });
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const report = page.getByRole("dialog", { name: "Import finished" });
  await expect(report.getByRole("status")).toHaveText("No new bookmarks");
  await expect(report).toContainText("In Trash — left there1");
  await report.getByRole("button", { name: "Done" }).click();
  await expect(nav("Trash 1")).toBeVisible();
  await nav("Trash 1").click();
  await page.locator('[data-bookmark-id="3"]').hover();
  await page.locator('[data-bookmark-id="3"]').getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("heading", { name: "Trash is empty" })).toBeVisible();
});
test("trash: deleting for good asks first, «Keep» keeps it, emptying takes the rest", async ({ page }) => {
  const nav = (name: string) => page.getByRole("button", { name, exact: true });
  const cards = page.locator("[data-bookmark-id]");
  const toast = page.locator(".fixed[role=status]");
  for (const id of [1, 2, 3]) {
    await page.locator(`[data-bookmark-id="${id}"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to trash" }).click();
  }
  await nav("Trash 3").click();
  await page.getByRole("button", { name: "List", exact: true }).click();

  // One bookmark from the row: the dialog names it, «Keep» changes nothing.
  const row = page.locator('[data-bookmark-id="1"]');
  await row.hover();
  await row.getByRole("button", { name: "Delete forever…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete forever?" });
  await expect(dialog).toContainText("«Ten principles for good design» will be deleted for good");
  await dialog.getByRole("button", { name: "Keep" }).click();
  await expect(cards).toHaveCount(3);
  await row.hover();
  await row.getByRole("button", { name: "Delete forever…" }).click();
  await dialog.getByRole("button", { name: "Delete forever" }).click();
  await expect(toast).toContainText("Deleted for good");
  await expect(toast.getByRole("button", { name: /Undo/ })).toHaveCount(0);
  await expect(cards).toHaveCount(2);
  await expect(nav("Trash 2")).toBeVisible();

  // The menu of a bookmark in the trash offers it too.
  await page.locator('[data-bookmark-id="2"]').click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Delete forever…" })).toBeVisible();
  await page.keyboard.press("Escape");

  // The whole trash: the count in the dialog, then empty.
  await page.getByRole("button", { name: "Empty trash…" }).click();
  const empty = page.getByRole("dialog", { name: "Empty trash?" });
  await expect(empty).toContainText("2 bookmarks will be deleted for good");
  await empty.getByRole("button", { name: "Delete forever" }).click();
  await expect(toast).toContainText("Trash emptied: 2 bookmarks deleted for good");
  await expect(page.getByRole("heading", { name: "Trash is empty" })).toBeVisible();
  await expect(nav("All bookmarks 3")).toBeVisible();
  // Gone after a restart too.
  await page.reload();
  await expect(nav("Trash 0")).toBeVisible();
});
test("undo: Ctrl Z takes actions back one by one, a decision returns to the inbox, a later change wins", async ({ page }) => {
  const nav = (name: string) => page.getByRole("button", { name, exact: true });
  const card = (id: number) => page.locator(`[data-bookmark-id="${id}"]`);
  const toast = page.locator(".fixed[role=status]");
  const alert = page.locator(".fixed[role=alert]");
  // Two decisions about a bookmark from the inbox: the star, then a collection.
  await card(2).hover();
  await card(2).getByRole("button", { name: "Add to favorites" }).click();
  await expect(nav("Inbox 1")).toBeVisible();
  await card(2).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to collection" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("menuitem", { name: "Development" }).click();
  await expect(toast).toContainText("Moved to «Development»");
  await expect(toast.getByRole("button", { name: /Undo/ })).toBeVisible();
  // The last action first, then the one before: the bookmark waits in the inbox again.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(toast).toContainText("Undone: «The architecture of silence»");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(card(2).locator("[data-collection]")).toContainText("Inspiration");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(nav("Inbox 2")).toBeVisible();
  await expect(nav("Favorites 2")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(toast).toContainText("Nothing to undo");

  // The editor's save is one action; its notice undoes it.
  await card(3).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit…" }).click();
  await page.getByLabel("Title", { exact: true }).fill("The voice of type");
  await page.getByLabel("Note", { exact: true }).fill("Show the team");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card(3)).toContainText("The voice of type");
  await toast.getByRole("button", { name: /Undo/ }).click();
  await expect(toast).toContainText("Undone: «Typography is a voice»");
  await expect(card(3)).toContainText("Typography is a voice");

  // Saved again from the trash meanwhile: «to the trash» is not undone over it.
  await card(3).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await page.getByRole("button", { name: "Add link", exact: true }).click();
  await page.getByLabel("Link", { exact: true }).fill("https://type.today/en");
  await page.getByRole("button", { name: "Save link" }).click();
  await expect(toast).toContainText("Back from Trash, waiting in Inbox");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(alert).toContainText("Not undone: «Typography is a voice» has changed since");
  await expect(nav("Inbox 3")).toBeVisible();
  await expect(nav("Trash 0")).toBeVisible();

  // Deleted for good: nothing to bring back, and it says so.
  await card(1).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await nav("Trash 1").click();
  await card(1).hover();
  await card(1).getByRole("button", { name: "Delete forever…" }).click();
  await page.getByRole("dialog", { name: "Delete forever?" }).getByRole("button", { name: "Delete forever" }).click();
  await expect(toast).toContainText("Deleted for good");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(alert).toContainText("Not undone: «Ten principles for good design» was deleted for good");
  await expect(nav("Trash 0")).toBeVisible();
});
test("triage: every key, a failed decision, undo, a new link, the end and back to the library", async ({ page }) => {
  const nav = (name: string) => page.getByRole("button", { name, exact: true });
  const heading = page.getByRole("heading", { level: 1 });
  const title = page.locator("[data-triage-card] h2");
  const toast = page.locator(".fixed[role=status]");
  const alert = page.locator(".fixed[role=alert]");
  const add = (url: string, title: string) =>
    page.evaluate(
      async ([url, title]) => {
        const { api } = await import("/src/services/api.ts");
        await api.addBookmark({ url, title });
      },
      [url, title],
    );
  // Three new links join the two waiting: the queue goes newest first.
  for (const [url, name] of [
    ["https://example.com/a", "First new"],
    ["https://example.com/b", "Second new"],
    ["https://example.com/c", "Third new"],
  ])
    await add(url, name);
  await page.evaluate(() => {
    (window as unknown as { opened: string[] }).opened = [];
    window.open = (url) => ((window as unknown as { opened: string[] }).opened.push(String(url)), null);
  });
  await page.locator("[data-notification-bell]").click();
  await page.getByRole("dialog", { name: "Notifications" }).getByRole("button", { name: "Sort", exact: true }).click();
  await expect(heading).toHaveText(/Sort inbox\s*1 of 5/);
  await expect(title).toHaveText("Third new");
  await expect(page.locator("[data-triage-card]")).toContainText(/example\.com\s*·\s*added by hand today at \d/);
  await expect(page.getByText("Up next")).toBeVisible();

  // F and T stay on the card; Space opens the page.
  await page.keyboard.press("f");
  await expect(nav("Favorites 3")).toBeVisible();
  await page.keyboard.press("t");
  await page.getByRole("textbox", { name: "New tag" }).fill("Urgent");
  await page.keyboard.press("Enter");
  await expect(toast).toContainText("Tag «urgent» added");
  await expect(page.locator("[data-triage-card] ~ div").getByText("#urgent")).toBeVisible();
  await page.keyboard.press("Space");
  expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual(["https://example.com/c"]);
  await expect(heading).toHaveText(/1 of 5/);

  // A number files and moves on; ← to the trash; Z brings it back to the card.
  await page.keyboard.press("2");
  await expect(heading).toHaveText(/2 of 5/);
  await expect(page.getByRole("listitem").filter({ hasText: "Third new" })).toContainText("→ Development");
  await page.keyboard.press("ArrowLeft");
  await expect(nav("Trash 1")).toBeVisible();
  await page.keyboard.press("z");
  await expect(toast).toContainText("Back in the queue: Second new");
  await expect(title).toHaveText("Second new");
  await expect(heading).toHaveText(/2 of 5/);
  await expect(nav("Trash 0")).toBeVisible();
  await page.keyboard.press("ArrowRight");

  // E: the editor; its save is a decision and moves on.
  await expect(title).toHaveText("First new");
  await page.keyboard.press("e");
  await page.getByLabel("Title", { exact: true }).fill("First, corrected");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(heading).toHaveText(/4 of 5/);
  await expect(page.getByRole("listitem").filter({ hasText: "First, corrected" })).toContainText("kept");

  // A link saved during triage joins the end.
  await add("https://example.com/d", "Came during triage");
  await expect(heading).toHaveText(/4 of 6\s*\+1 new/);

  // A failed decision keeps the card; «Try again» or the same key tries again.
  await expect(title).toHaveText("The architecture of silence");
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const { CommandError } = await import("/src/services/errors.ts");
    const original = api.trashBookmark;
    api.trashBookmark = async (id) => {
      api.trashBookmark = original;
      throw new CommandError("database_busy", "busy");
    };
  });
  await page.keyboard.press("ArrowLeft");
  await expect(alert).toContainText("Couldn't move to trash: the library is busy");
  await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(heading).toHaveText(/4 of 6/);
  await page.keyboard.press("ArrowLeft");
  await expect(heading).toHaveText(/5 of 6/);
  await expect(alert).toHaveCount(0);

  // The end: the summary, the badge gone; Z brings the last card back.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("heading", { name: "Inbox sorted" })).toBeVisible();
  await expect(page.getByText("6 bookmarks decided: 4 kept, 1 filed into collections, 1 moved to trash.")).toBeVisible();
  await expect(nav("Inbox")).toBeVisible();
  await page.keyboard.press("z");
  await expect(title).toHaveText("Came during triage");
  await expect(nav("Inbox 1")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  // Ten bookmarks, one of them in the trash.
  await expect(heading).toHaveText(/All bookmarks\s*9/);
});
test("triage: a collection is suggested by the site, explained, and nothing changes until chosen", async ({ page }) => {
  // Two links from example.org already lie in «Inspiration»; a third waits.
  const newId = await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    for (const n of [1, 2]) {
      const { bookmark } = await api.addBookmark({ url: `https://example.org/${n}`, title: `Example ${n}` });
      await api.updateBookmark(bookmark.id, { collection_id: 3 });
    }
    return (await api.addBookmark({ url: "https://example.org/new", title: "One more example" })).bookmark.id;
  });
  await page.locator("[data-notification-bell]").click();
  await page.getByRole("dialog", { name: "Notifications" }).getByRole("button", { name: "Sort", exact: true }).click();
  await expect(page.locator("[data-triage-card] h2")).toHaveText("One more example");
  const offered = page.locator("[data-suggested]");
  const chips = page.locator("[data-keys] button");
  await expect(offered).toHaveText(/1\s*Inspiration\s*suggested/);
  await expect(chips.nth(1)).toHaveText(/2\s*Design/);
  await offered.hover();
  await expect(page.getByRole("tooltip").filter({ hasText: "Links from example.org" })).toHaveText(
    "Links from example.org mostly live in «Inspiration»: 2 of 2",
  );
  // Shown, not applied: the bookmark still waits without a collection.
  const stored = () =>
    page.evaluate(async (id) => {
      const { api } = await import("/src/services/api.ts");
      const { items } = await api.getBookmarks({}, { id });
      return [items[0].collection_id, items[0].triaged_at];
    }, newId);
  expect(await stored()).toEqual([null, null]);
  await page.keyboard.press("1");
  await expect(page.getByRole("listitem").filter({ hasText: "One more example" })).toContainText("→ Inspiration");
  expect((await stored())[0]).toBe(3);
  // A site with nothing filed: no suggestion, the sidebar order.
  await expect(page.locator("[data-triage-card] h2")).toHaveText("The architecture of silence");
  await expect(offered).toHaveCount(0);
  await expect(chips.first()).toHaveText(/1\s*Design/);
});
test("triage: the decisions keep their words at any width, a longer label goes compact (NP-084)", async ({ page }) => {
  const row = page.locator("[data-fit]");
  const label = row.locator("[data-label]");
  /** The row inside its column, the words whole, no sideways scroll. */
  const fits = () =>
    row.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const inside = [...el.children].every((b) => {
        const r = b.getBoundingClientRect();
        return r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && b.scrollWidth <= b.clientWidth;
      });
      const words = el.querySelector("[data-label]");
      return {
        inside,
        overflow: el.scrollWidth > el.clientWidth || document.documentElement.scrollWidth > innerWidth,
        words: !words || words.scrollWidth <= words.clientWidth,
      };
    });
  const language = (code: string) =>
    page.evaluate(async (code) => {
      const { default: i18n } = await import("/src/i18n/index.ts");
      await i18n.changeLanguage(code);
    }, code);
  await page.locator("[data-notification-bell]").click();
  await page.getByRole("dialog", { name: "Notifications" }).getByRole("button", { name: "Sort", exact: true }).click();
  await expect(page.locator("[data-triage-card]")).toBeVisible();
  // 1160 px is the reported window: 1740 px at 150 %, the «Только что» column beside the card.
  for (const [code, words] of [
    ["en", "Move to trash"],
    ["ru", "В корзину"],
  ]) {
    await language(code);
    for (const width of [800, 1100, 1160, 1600]) {
      await page.setViewportSize({ width, height: width === 800 ? 550 : 800 });
      await expect(label, `${code} ${width}`).toHaveText(words);
      await expect(row).toHaveAttribute("data-fit", "0");
      await expect.poll(fits, { message: `${code} ${width}` }).toEqual({ inside: true, overflow: false, words: true });
    }
  }
  // A label half as long again: Keep and the heart stay in the row, the keys go first, then the words.
  await page.evaluate(async () => {
    const { default: i18n } = await import("/src/i18n/index.ts");
    i18n.addResource("en", "translation", "triage.trash", "Move this one to the trash");
  });
  await language("en");
  for (const width of [800, 1100, 1160, 1600]) {
    await page.setViewportSize({ width, height: width === 800 ? 550 : 800 });
    await expect(row.getByRole("button", { name: "Move this one to the trash" })).toBeVisible();
    await expect.poll(fits, { message: `long ${width}` }).toEqual({ inside: true, overflow: false, words: true });
  }
  await page.setViewportSize({ width: 1600, height: 800 });
  await expect(row).toHaveAttribute("data-fit", "0");
  await page.setViewportSize({ width: 1160, height: 800 });
  await expect(row).not.toHaveAttribute("data-fit", "0");
  // A wider window brings the words back.
  await page.setViewportSize({ width: 1600, height: 800 });
  await expect(row).toHaveAttribute("data-fit", "0");
  await expect(label).toHaveText("Move this one to the trash");

  // The keys work as before.
  await page.setViewportSize({ width: 1160, height: 800 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/1 of 2/);
  await page.keyboard.press("f");
  await expect(row.getByRole("button", { name: "Remove from favorites" })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/2 of 2/);
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("heading", { name: "Inbox sorted" })).toBeVisible();
});
test("triage: Esc goes back where it was opened, the inbox always offers it", async ({ page }) => {
  await page.getByRole("button", { name: "Inbox 2", exact: true }).click();
  const banner = page.getByRole("region", { name: "New bookmarks" });
  // In the inbox the banner has no «hide»: it is the way into triage.
  await expect(banner.getByRole("button", { name: "Hide until new bookmarks arrive" })).toHaveCount(0);
  await banner.getByRole("button", { name: "Sort" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Sort inbox\s*1 of 2/);
  await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "Finish" }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Inbox\s*1/);
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
});
test("metadata updates keep order and filtered captures stay out of the list", async ({ page }) => {
  const ids = await page
    .locator("[data-bookmark-id]")
    .evaluateAll((elements) => elements.map((e) => e.getAttribute("data-bookmark-id")));
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    await api.updateBookmark(3, { notes: "Updated asynchronously" });
  });
  expect(
    await page.locator("[data-bookmark-id]").evaluateAll((elements) => elements.map((e) => e.getAttribute("data-bookmark-id"))),
  ).toEqual(ids);
  await page.getByRole("button", { name: "Favorites 2" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(2);
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    await api.addBookmark({
      url: "https://example.com/not-a-favorite",
      title: "Not a favorite",
    });
  });
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(2);
});
test("an older search response cannot replace the current query", async ({ page }) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const original = api.getBookmarks;
    api.getBookmarks = async (filters) => {
      const rows = await original(filters);
      if (filters?.search === "Architecture") await new Promise((resolve) => setTimeout(resolve, 450));
      return rows;
    };
  });
  await page.getByRole("textbox", { name: "Search the library" }).fill("Architecture");
  await page.waitForTimeout(190);
  await page.getByRole("textbox", { name: "Search the library" }).fill("Typography");
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  await page.waitForTimeout(500);
  await expect(page.locator('[data-bookmark-id="3"]')).toBeVisible();
});

test("list geometry stays within the window and broken previews keep their space", async ({ page }) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const data = {
      bookmarks: (await api.getBookmarks()).items,
      collections: await api.getCollections(),
    };
    data.bookmarks[0].image_url = "/broken-preview.png";
    data.bookmarks[0].title = "A very long title that goes on ".repeat(12);
    localStorage.setItem("koonapin.demo.v4", JSON.stringify(data));
  });
  await page.reload();
  await expect(page.locator('[data-bookmark-id="1"] [data-preview-fallback]')).toBeVisible();
  await page.getByRole("button", { name: "List", exact: true }).click();
  const preview = await page.locator('[data-bookmark-id="1"] [data-preview]').boundingBox();
  expect(preview?.width).toBe(64);
  expect(preview?.height).toBe(44);
  expect(await page.locator('[data-scroll="main"]').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.locator('[data-bookmark-id="1"]').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
});

test("save errors preserve entered data and HTML import skips duplicate and unsupported links", async ({ page }) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const original = api.addBookmark;
    let failed = false;
    api.addBookmark = async (data) => {
      if (!failed) {
        failed = true;
        throw new Error("Could not write the link");
      }
      return original(data);
    };
  });
  await page.getByRole("button", { name: "Add link", exact: true }).click();
  await page.getByLabel("Link", { exact: true }).fill("https://example.com/new-link");
  await page.getByLabel("Title", { exact: true }).fill("My find");
  await page.getByRole("button", { name: "Save link" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not write the link");
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("My find");
  await page.getByRole("button", { name: "Save link" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(7);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: /Browser bookmarks/ }).click();
  await page.locator("input[type=file]").setInputFiles({
    name: "bookmarks.html",
    mimeType: "text/html",
    buffer: Buffer.from(
      '<a href="https://example.com/new-link">Duplicate</a><a href="https://example.com/imported">Imported</a><a href="javascript:alert(1)">Unsupported</a>',
    ),
  });
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const report = page.getByRole("dialog", { name: "Import finished" });
  await expect(report.getByRole("status")).toHaveText("1 bookmark added to Library");
  await expect(report).toContainText("Already in the library — left as they were1");
  await expect(report).toContainText("Not a web address (javascript:, place:, file:)1");
  await report.getByRole("button", { name: "Done" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(8);
});

test("command errors speak the interface's language, never the app's English alone (NP-085)", async ({ page }) => {
  const save = async (link: string, button: string, field: string) => {
    await page.getByLabel(field, { exact: true }).fill(link);
    await page.getByRole("button", { name: button }).click();
  };
  await page.getByRole("button", { name: "Add link", exact: true }).click();
  await save("ftp://example.com/file", "Save link", "Link");
  await expect(page.getByRole("alert")).toHaveText("Only http:// and https:// links can be saved.");
  await page.keyboard.press("Escape");

  await page.evaluate(() => localStorage.setItem("koonapin.language", "ru"));
  await page.reload();
  await page.getByRole("button", { name: "Добавить ссылку", exact: true }).click();
  await save("ftp://example.com/file", "Сохранить ссылку", "Ссылка");
  await expect(page.getByRole("alert")).toHaveText("Сохранить можно только ссылки http:// и https://.");
  // A failure without words of its own: the sentence is Russian, the app's text a detail.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const { CommandError } = await import("/src/services/errors.ts");
    api.addBookmark = async () => {
      throw new CommandError("internal", "The system cannot find the file.");
    };
  });
  await save("https://example.com/file", "Сохранить ссылку", "Ссылка");
  await expect(page.getByRole("alert")).toHaveText("Что-то пошло не так: The system cannot find the file");
});

const fixture = (name: string) => new URL(`../fixtures/bookmarks/${name}.html`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
async function openImport(page: import("@playwright/test").Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: /Browser bookmarks/ }).click();
  await page.locator("dialog input[type=file]").setInputFiles(file);
  return page.getByRole("dialog");
}

test("import: browser folders become collections and tags, the report gives reasons, a repeated import changes nothing", async ({ page }) => {
  const dialog = await openImport(page, fixture("chrome"));
  await expect(dialog).toContainText("7 links in 4 folders · choose another file");
  await expect(dialog.getByRole("radio", { name: "Library" })).toHaveAttribute("aria-checked", "true");
  await dialog.getByRole("button", { name: "Import", exact: true }).click();

  const report = page.getByRole("dialog", { name: "Import finished" });
  await expect(report.getByRole("status")).toHaveText("7 bookmarks added to Library");
  await expect(report).toContainText("2 new collections: Работа, Чтение · 2 new tags");
  await expect(report).toContainText("Skipped3");
  await expect(report).toContainText("Repeated within the file1");
  await report.getByRole("button", { name: "Show the skipped addresses" }).click();
  await expect(report.getByRole("listitem")).toHaveText(["javascript:void(document.title)", "https://github.com/", "chrome://settings/"]);
  await report.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Top-level folder → collection, nested folders → tags, the browser's date kept.
  await page.getByRole("button", { name: /^Работа 3/ }).click();
  await page.getByRole("button", { name: "List", exact: true }).click();
  const tokio = page.locator("[data-bookmark-id]", { hasText: "Tokio" });
  await expect(tokio.getByRole("button", { name: "rust" })).toBeVisible();
  await expect(tokio.getByRole("button", { name: "async" })).toBeVisible();
  await expect(tokio.locator("time")).toHaveAttribute("datetime", "2023-07-22T04:31:40.000Z");

  // Again: nothing new, nothing changed.
  const again = await openImport(page, fixture("chrome"));
  await again.getByRole("button", { name: "Import", exact: true }).click();
  await expect(report.getByRole("status")).toHaveText("No new bookmarks");
  await expect(report).toContainText("Already in the library — left as they were7");
  await expect(report).not.toContainText("new collections");
});

test("import into the inbox: the banner counts the import; an error changes nothing; an empty file is named", async ({ page }) => {
  const dialog = await openImport(page, fixture("firefox"));
  await dialog.getByRole("radio", { name: "Inbox" }).click();
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  const report = page.getByRole("dialog", { name: "Import finished" });
  await expect(report.getByRole("status")).toHaveText("7 bookmarks added to Inbox");
  await report.getByRole("button", { name: "Open Inbox" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Inbox");
  await expect(page.getByRole("region", { name: "New bookmarks" })).toContainText("9 new bookmarks are waiting — 7 of them from the import");

  // The library is busy: the dialog keeps the file and offers to try again.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const { CommandError } = await import("/src/services/errors.ts");
    api.importHtmlBookmarks = async () => {
      throw new CommandError("database_busy", "database is locked");
    };
  });
  const failing = await openImport(page, fixture("edge"));
  await failing.getByRole("button", { name: "Import", exact: true }).click();
  await expect(failing.getByRole("alert")).toContainText("Couldn't import. Another program is using the library. Try again in a few seconds.");
  await expect(failing.getByRole("alert")).toContainText("Nothing was added — the library is as it was.");
  await expect(failing.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(failing).toContainText("edge.html");
  await failing.getByRole("button", { name: "Cancel" }).click();
  // Nothing came in: the nested folder «Fonts» did not become a tag.
  await expect(page.getByRole("complementary", { name: "Library" }).getByRole("button", { name: /^fonts$/i })).toHaveCount(0);

  const empty = await openImport(page, { name: "notes.html", mimeType: "text/html", buffer: Buffer.from("<html><body>Notes</body></html>") });
  await expect(empty.getByRole("alert")).toContainText("This file has no bookmarks");
  await expect(empty.getByRole("button", { name: "Import", exact: true })).toBeDisabled();
});

test("export: saved says how many and offers Show; cancelled says nothing; a failure names the reason and tries again", async ({ page }) => {
  const exportAs = async (item: RegExp) => {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: item }).click();
  };
  const toast = page.locator("[role=status], [role=alert]").filter({ hasText: /saved/i });
  // The trash stays out of HTML and CSV; JSON takes everything.
  await page.locator('[data-bookmark-id="2"]').hover();
  await page.locator('[data-bookmark-id="2"]').getByRole("button", { name: /^Actions:/ }).click();
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await exportAs(/HTML for browsers/);
  await expect(toast).toContainText(/^5 bookmarks saved to koona-pin-\d{4}-\d{2}-\d{2}\.html/);
  await expect(toast.getByRole("button", { name: "Show" })).toBeVisible();
  await exportAs(/JSON — full copy/);
  await expect(toast).toContainText(/^6 bookmarks saved to koona-pin-.*\.json/);

  // CSV gets its column titles in the interface's language; a cancelled dialog says nothing.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const calls: unknown[] = [];
    (window as unknown as { exportCalls: unknown[] }).exportCalls = calls;
    let attempt = 0;
    api.exportLibrary = async (format, columns) => {
      calls.push({ format, columns });
      attempt++;
      if (attempt === 1) return { outcome: "cancelled" };
      if (attempt === 2) return { outcome: "failed", file_name: "koona-pin.csv", folder: "D:\\", problem: "disk_full", detail: "There is not enough space on the disk. (os error 112)" };
      return { outcome: "saved", file_name: "koona-pin.csv", count: 5 };
    };
  });
  await exportAs(/CSV for spreadsheets/);
  await expect.poll(() => page.evaluate(() => (window as unknown as { exportCalls: unknown[] }).exportCalls.length)).toBe(1);
  await expect(page.getByText("koona-pin.csv", { exact: false })).toHaveCount(0);
  const calls = await page.evaluate(() => (window as unknown as { exportCalls: { format: string; columns: Record<string, string> }[] }).exportCalls);
  expect(calls[0]).toMatchObject({ format: "csv", columns: { title: "Title", inbox: "In Inbox", saved: "Saved" } });

  await exportAs(/CSV for spreadsheets/);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Couldn't save koona-pin.csv: the disk is full. Nothing was written.");
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(toast).toContainText("5 bookmarks saved to koona-pin.csv");
});

/** A JSON copy as Export writes it: one bookmark the demo has, one waiting in the inbox, one in the trash. */
async function copyFile(page: import("@playwright/test").Page, edit: (copy: Record<string, unknown>) => void = () => {}) {
  const existing = await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    return (await api.getBookmarks()).items[0].url;
  });
  const at = "2026-09-01T10:00:00.000Z";
  const bookmark = (uid: string, url: string, title: string, more: Record<string, unknown> = {}) => ({
    uid, url, title, description: null, notes: null, domain: new URL(url).hostname, image_url: null, favicon_url: null, site_name: null,
    is_favorite: false, collection: null, tags: [], source: "import", created_at: at, updated_at: at, triaged_at: at, deleted_at: null, ...more,
  });
  const copy: Record<string, unknown> = {
    format: "koona-pin",
    version: 1,
    exported_at: "2026-10-04T18:20:00.000Z",
    app_version: "0.1.0",
    collections: [
      { uid: "c1", name: "Restored", color: null, icon: null, created_at: at },
      { uid: "c2", name: "One more", color: null, icon: null, created_at: at },
    ],
    tags: [{ uid: "t1", name: "from-the-copy", created_at: at }],
    bookmarks: [
      bookmark("b1", existing, "Already here"),
      bookmark("b2", "https://restored.example/inbox", "Waiting to be sorted", { triaged_at: null, collection: "c1", tags: ["from-the-copy"] }),
      bookmark("b3", "https://restored.example/trash", "Was in the trash", { deleted_at: at }),
    ],
  };
  edit(copy);
  return { name: "koona-pin-2026-10-04.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(copy)) };
}
async function openRestore(page: import("@playwright/test").Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: /Koona Pin backup/ }).click();
  const dialog = page.getByRole("dialog", { name: "Restore from a JSON copy" });
  await dialog.locator("input[type=file]").first().setInputFiles(file);
  return dialog;
}

test("restore: merge adds what is missing with its state and keeps what is there; a bad copy is refused with nothing changed", async ({ page }) => {
  const dialog = await openRestore(page, await copyFile(page));
  await expect(dialog).toContainText(/3 bookmarks · 2 collections · 1 tag · Oct 4, 2026/);
  await expect(dialog.getByRole("radio", { name: /Merge with the current library/ })).toHaveAttribute("aria-checked", "true");
  await dialog.getByRole("button", { name: "Restore", exact: true }).click();
  const report = page.getByRole("dialog", { name: "Restore finished" });
  await expect(report.getByRole("status")).toHaveText("2 bookmarks added from the copy");
  await expect(report).toContainText("2 new collections · 1 new tag");
  await expect(report).toContainText("Of them waiting in Inbox1");
  await expect(report).toContainText("Of them in Trash1");
  await expect(report).toContainText("Already in the library — left as they were1");
  await report.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("button", { name: /^Restored 1/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Inbox 3/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Trash 1/ })).toBeVisible();

  // Refused copies: the library stays as it was.
  const refused = [
    [{ name: "notes.json", mimeType: "application/json", buffer: Buffer.from("not json") }, "This isn't a JSON file."],
    [await copyFile(page, (c) => (c.format = "other-app")), "This isn't a Koona Pin copy"],
    [await copyFile(page, (c) => (c.version = 2)), "The copy was made by a newer Koona Pin (format 2)"],
    [await copyFile(page, (c) => ((c.bookmarks as { url: string }[])[1].url = "javascript:alert(1)")), "The copy is damaged: bookmark 2 has no valid address. Nothing was changed."],
  ] as const;
  for (const [file, text] of refused) {
    const bad = await openRestore(page, file);
    await expect(bad.getByRole("alert")).toContainText(text);
    await expect(bad).toContainText("Checked: the copy can't be restored");
    await expect(bad.getByText("Choose another file")).toBeVisible();
    await bad.getByRole("button", { name: "Cancel" }).click();
  }
  await expect(page.getByRole("button", { name: /^Trash 1/ })).toBeVisible();
});

test("restore: replace asks first with the numbers, then the library is the copy and the backup is named", async ({ page }) => {
  const dialog = await openRestore(page, await copyFile(page));
  await dialog.getByRole("radio", { name: /Replace the library/ }).click();
  await dialog.getByRole("button", { name: "Restore", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Replace the library?" });
  await expect(confirm).toContainText("The library has 6 bookmarks now; after the restore it will hold the 3 of the copy.");
  // «Keep» changes nothing.
  await confirm.getByRole("button", { name: "Keep" }).click();
  await expect(page.getByRole("dialog", { name: "Replace the library?" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Restore", exact: true }).click();
  await page.getByRole("dialog", { name: "Replace the library?" }).getByRole("button", { name: "Replace" }).click();
  const report = page.getByRole("dialog", { name: "Restore finished" });
  await expect(report.getByRole("status")).toHaveText("3 bookmarks restored");
  await expect(report).toContainText("Backup of the previous library:");
  await expect(report.getByRole("button", { name: "Show" })).toBeVisible();
  await report.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("2");
  await expect(page.getByRole("button", { name: /^Trash 1/ })).toBeVisible();
});

test("backup: the settings explain copies, the dialog lists them, asks with the numbers and names the copy of the old library", async ({ page }) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("A backup is the whole library exactly as it was")).toBeVisible();
  await page.getByRole("button", { name: "Restore…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Restore from a backup" });
  const radios = dialog.getByRole("radio");
  await expect(radios).toHaveCount(2);
  await expect(radios.first()).toHaveAttribute("aria-checked", "true");
  await expect(radios.first()).toContainText(/Today, \d{1,2}:\d\d/);
  await expect(radios.nth(1)).toContainText("Before a library update");
  await radios.nth(1).click();
  await expect(radios.nth(1)).toHaveAttribute("aria-checked", "true");
  await dialog.getByRole("button", { name: "Restore…" }).click();
  const confirm = page.getByRole("dialog", { name: /^Restore the copy from / });
  await expect(confirm).toContainText("The library has 6 bookmarks now; the copy holds 4.");
  // «Keep» changes nothing and returns to the list.
  await confirm.getByRole("button", { name: "Keep" }).click();
  await expect(page.getByRole("dialog", { name: /^Restore the copy from / })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Restore…" }).click();
  await page.getByRole("dialog", { name: /^Restore the copy from / }).getByRole("button", { name: "Restore", exact: true }).click();
  const report = page.getByRole("dialog", { name: "Library restored" });
  await expect(report.getByRole("status")).toContainText("4 bookmarks from the copy of");
  await expect(report).toContainText("koonapin.before-restore-demo.db");
  await report.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("duplicates: the section groups the same page, the main one is chosen, merge keeps everything and Ctrl Z takes it back", async ({ page }) => {
  const add = async (url: string) => {
    await page.getByRole("button", { name: "Add link", exact: true }).click();
    await page.getByLabel("Link", { exact: true }).fill(url);
    await page.getByRole("button", { name: "Save link" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  };
  const nav = (name: string) => page.getByRole("complementary").getByRole("button", { name, exact: true });
  // No duplicates: no sidebar entry; the menu «⋯» still leads to the section.
  await expect(page.getByRole("complementary").getByRole("button", { name: /^Duplicates/ })).toHaveCount(0);
  await add("http://vitsoe.com/rw/about/good-design/?utm_source=mail");
  await add("https://www.vitsoe.com/rw/about/good-design#top");
  await add("https://example.com/vitsoe?ref=other");
  await nav("Duplicates 1").click();

  const group = page.locator("[data-duplicate-group='vitsoe.com/rw/about/good-design']");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Duplicates");
  const radios = group.getByRole("radio");
  await expect(radios).toHaveCount(3);
  // The plainest address of the oldest: the demo's own bookmark with its note, tags and collection.
  await expect(radios.first()).toHaveAttribute("aria-checked", "true");
  await expect(radios.first()).toContainText("Ten principles for good design");
  await expect(group.locator("[data-after]")).toContainText("tags design, principles");
  await expect(group.locator("[data-after]")).toContainText("the other 2 go to Trash for 30 days");
  // Another main one changes what stays, then back.
  await radios.nth(2).click();
  await expect(radios.nth(2)).toHaveAttribute("aria-checked", "true");
  await radios.first().click();

  await group.getByRole("button", { name: "Merge" }).click();
  const toast = page.getByRole("status").filter({ hasText: "merged" });
  await expect(toast).toContainText("3 bookmarks merged into «Ten principles for good design»");
  await expect(page.getByRole("heading", { name: "No duplicates" })).toBeVisible();
  await expect(nav("Trash 2")).toBeVisible();
  await expect(nav("Duplicates 0")).toBeVisible();

  // Ctrl Z: the group again, nothing lost.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(radios).toHaveCount(3);
  await expect(nav("Trash 0")).toBeVisible();

  // «Not duplicates» hides it until undone.
  await group.getByRole("button", { name: "Not duplicates" }).click();
  await expect(page.getByText("Group hidden: «vitsoe.com/rw/about/good-design»")).toBeVisible();
  await expect(page.getByRole("heading", { name: "No duplicates" })).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(radios).toHaveCount(3);

  // «Merge all…» asks first with the numbers.
  await page.getByRole("button", { name: "Merge all…" }).click();
  const confirm = page.getByRole("dialog", { name: "Merge 1 group?" });
  await expect(confirm).toContainText("3 bookmarks become 1");
  await confirm.getByRole("button", { name: "Merge all" }).click();
  await expect(page.getByRole("heading", { name: "No duplicates" })).toBeVisible();

  // The kept bookmark has everything; a page with another parameter was never a duplicate.
  await nav("All bookmarks 7").click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(7);
});

test("link check: the person starts it, results come in groups, replace and trash are undone with Ctrl Z", async ({ page }) => {
  const add = async (url: string) => {
    await page.getByRole("button", { name: "Add link", exact: true }).click();
    await page.getByLabel("Link", { exact: true }).fill(url);
    await page.getByRole("button", { name: "Save link" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  };
  // The demo's made-up answers (services/demo.ts): 404, a move, no answer.
  await add("https://example.org/page-1");
  await add("https://example.org/page-3");
  await add("https://example.org/page-4");
  const sidebar = page.getByRole("complementary");
  // Nothing checked yet: no sidebar entry; the menu «⋯» leads to the section.
  await expect(sidebar.getByRole("button", { name: /^Link check/ })).toHaveCount(0);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: /Link check/ }).click();

  // Before the first check: what will happen; nothing starts on its own.
  await expect(page.getByRole("heading", { name: "Check your links" })).toBeVisible();
  await expect(page.getByText("Each site sees an ordinary request from your computer", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Check 9 links" }).click();
  await expect(page.locator("[data-link-check='finished']")).toContainText("Checked 9 links today at");

  const row = (url: string) => page.locator("[data-bookmark-id]").filter({ hasText: url });
  const gone = page.locator("[data-link-group='gone']");
  const moved = page.locator("[data-link-group='moved']");
  const failed = page.locator("[data-link-group='failed']");
  await expect(gone.locator("[data-bookmark-id]").filter({ hasText: "example.org/page-1" }).locator("[data-result]")).toHaveText("404 · Not found");
  await expect(moved.locator("[data-bookmark-id]").filter({ hasText: "example.org/page-3" })).toContainText("https://example.org/moved/page-3");
  await expect(failed.locator("[data-bookmark-id]").filter({ hasText: "example.org/page-4" }).locator("[data-result]")).toHaveText("No answer in 10 s");
  await expect(failed).toContainText("Not counted as broken");
  // The sidebar counts what needs a decision: broken and moved, not «could not check».
  const decide = (await gone.locator("[data-bookmark-id]").count()) + (await moved.locator("[data-bookmark-id]").count());
  await expect(sidebar.getByRole("button", { name: `Link check ${decide}`, exact: true })).toBeVisible();

  // «Replace address»: the bookmark takes the new address; Ctrl Z puts the old one and its result back.
  await row("example.org/page-3").getByRole("button", { name: "Replace address" }).click();
  await expect(page.getByText("Address replaced: example.org")).toBeVisible();
  await expect(row("example.org/page-3")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(moved.locator("[data-bookmark-id]").filter({ hasText: "example.org/page-3" })).toBeVisible();

  // «Move to trash» on hover; Ctrl Z brings it back to the group.
  await row("example.org/page-1").hover();
  await row("example.org/page-1").getByRole("button", { name: "Move to trash" }).click();
  await expect(page.getByText(/1 bookmark in Trash/)).toBeVisible();
  await expect(row("example.org/page-1")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(gone.locator("[data-bookmark-id]").filter({ hasText: "example.org/page-1" })).toBeVisible();
});

test("import of 10 000 links shows progress and keeps the window usable", async ({ page }) => {
  let html = "<DL>";
  for (let i = 0; i < 10_000; i++) html += `<DT><A HREF="https://example.com/${i}" ADD_DATE="1700000000">Link ${i}</A>`;
  const dialog = await openImport(page, { name: "big.html", mimeType: "text/html", buffer: Buffer.from(html + "</DL>") });
  await expect(dialog).toContainText("10,000 links");
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByRole("progressbar")).toBeVisible();
  // Escape does not close it while the file is being written.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Import finished" }).getByRole("status")).toHaveText("10,000 bookmarks added to Library", { timeout: 20_000 });
});

test("a large library loads page by page while scrolling", async ({ page }) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const [first] = (await api.getBookmarks()).items;
    const bookmarks = Array.from({ length: 250 }, (_, i) => ({
      ...first,
      id: i + 1,
      url: `https://example.com/${i + 1}`,
      title: i % 2 ? `Ёлка ${i + 1}` : `Entry ${i + 1}`,
      tags: [],
      // Every fifth one shares a time with its neighbour: the id breaks the tie.
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 250 - i + (i % 5 === 0 ? 1 : 0))).toISOString(),
    }));
    localStorage.setItem("koonapin.demo.v4", JSON.stringify({ bookmarks, collections: await api.getCollections() }));
  });
  await page.reload();
  // Virtualized: only rows near the screen are in the DOM; `data-loaded` counts the pages read.
  const list = page.locator("[data-loaded]");
  await expect(list).toHaveAttribute("data-loaded", "100");
  expect(await page.locator("[data-bookmark-id]").count()).toBeLessThan(60);
  const scroll = page.locator('[data-scroll="main"]');
  await scroll.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(list).toHaveAttribute("data-loaded", "200");
  await scroll.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(list).toHaveAttribute("data-loaded", "250");
  await scroll.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  // The oldest bookmark (id 250 here: the list starts with id 1) ends the list.
  await expect(page.locator('[data-bookmark-id="250"]')).toBeVisible();
  await expect(page.locator("[data-bookmark-id]").last()).toHaveAttribute("data-bookmark-id", "250");

  // «е» finds «Ёлка»; the count covers every page, not only the loaded one.
  await page.getByRole("textbox", { name: "Search the library" }).fill("елка");
  await expect(page.getByText("125 of 250")).toBeVisible();
  await expect(list).toHaveAttribute("data-loaded", "100");
});

/** 250 demo bookmarks, «Entry 1» to «Entry 250», newest first by id. */
async function largeLibrary(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const [first] = (await api.getBookmarks()).items;
    const bookmarks = Array.from({ length: 250 }, (_, i) => ({
      ...first,
      id: i + 1,
      url: `https://example.com/${i + 1}`,
      title: `Entry ${i + 1}`,
      tags: [],
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }));
    localStorage.setItem("koonapin.demo.v4", JSON.stringify({ bookmarks, collections: await api.getCollections() }));
  });
  await page.reload();
  await expect(page.locator("[data-loaded]")).toHaveAttribute("data-loaded", "100");
}

test("a change during a page request shows the newer version", async ({ page }) => {
  await largeLibrary(page);
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const original = api.getBookmarks;
    api.getBookmarks = async (filters, request) => {
      const result = await original(filters, request);
      // The page is read, then bookmark 150 (first on it) changes before it arrives.
      if (request?.after && request.after.id === 151) {
        await api.updateBookmark(150, { title: "Changed while loading" });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return result;
    };
  });
  await page.locator('[data-scroll="main"]').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.locator("[data-loaded]")).toHaveAttribute("data-loaded", /^(200|250)$/);
  await expect(page.locator('[data-bookmark-id="150"]')).toContainText("Changed while loading");
});

test("a failing next page is not retried in a loop", async ({ page }) => {
  await largeLibrary(page);
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const original = api.getBookmarks;
    (window as unknown as { failures: number }).failures = 0;
    api.getBookmarks = async (filters, request) => {
      if (request?.after) {
        (window as unknown as { failures: number }).failures++;
        throw new Error("The disk is unavailable");
      }
      return original(filters, request);
    };
  });
  await page.locator('[data-scroll="main"]').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.getByText("The disk is unavailable")).toBeVisible();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { failures: number }).failures)).toBe(1);
  await expect(page.locator("[data-loaded]")).toHaveAttribute("data-loaded", "100");
});

test("a changed bookmark joins an open search by the search rules", async ({ page }) => {
  const search = page.getByRole("textbox", { name: "Search the library" });
  await search.fill("ёлочн ИГРУШКИ");
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(0);
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    await api.updateBookmark(3, { notes: "Игрушки для елочных базаров" });
  });
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  await expect(page.locator('[data-bookmark-id="3"]')).toBeVisible();
  await expect(page.getByText("1 of 6")).toBeVisible();
});

test("list rows: date groups over all pages, hover actions, a click selects (NP-123)", async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 9, 3, 12, 0));
  await largeLibrary(page);
  await page.getByRole("button", { name: "List", exact: true }).click();
  // 250 bookmarks from January: one group «Earlier» sized by the database, not by the 100 loaded rows.
  await expect(page.getByRole("heading", { name: "Earlier 250" })).toBeVisible();

  const row = page.locator('[data-bookmark-id="250"]');
  const bar = page.getByRole("toolbar", { name: "Selected bookmarks" });
  // No checkbox any more, and no column for it: the thumbnail starts the row.
  await row.hover();
  await expect(row.getByRole("checkbox")).toHaveCount(0);
  const rowBox = (await row.boundingBox())!;
  const thumb = (await row.locator("[data-preview]").boundingBox())!;
  expect(thumb.x - rowBox.x).toBeLessThan(10);
  await clickCard(row);
  await expect(row).toHaveAttribute("data-selected", "true");
  await expect(bar.getByRole("status")).toHaveText("1 selected");
  // A changed bookmark stays selected.
  await row.getByRole("button", { name: "Move to collection" }).click();
  await page.getByRole("menuitem", { name: "Development" }).click();
  await expect(row.locator("[data-collection]")).toContainText("Development");
  await expect(row).toHaveAttribute("data-selected", "true");
  // A deleted one leaves the selection silently.
  await row.hover();
  await row.getByRole("button", { name: "Move to trash" }).click();
  await expect(page.locator('[data-bookmark-id="250"]')).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Earlier 249" })).toBeVisible();
  await expect(bar).toHaveCount(0);
});

const rowTitles = (page: import("@playwright/test").Page) => page.locator("article[data-bookmark-id] h2").allTextContents();

test("sort: the menu orders every section, by title and site without date groups, the trash keeps its own, the choice stays (NP-114)", async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 9, 3, 12, 0));
  await page.reload();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "List", exact: true }).click();
  const sort = page.getByRole("button", { name: /^Sort: / });
  // Newest first by default, named on the button in a wide window; the date groups are there.
  await expect(sort).toHaveAccessibleName("Sort: Newest first");
  await expect(sort).toContainText("Newest first");
  const groups = page.getByRole("heading", { name: /^(Today|Yesterday|This week|Earlier)/ });
  await expect(groups).toHaveText([/^Yesterday/, /^This week/]);
  const newest = await rowTitles(page);

  // The menu says which one is chosen; the keys move through it like any menu.
  await sort.click();
  const menu = page.getByRole("menu", { name: "Sort by" });
  await expect(menu.getByRole("menuitemradio")).toHaveText(["Newest first", "Oldest first", "Title A–Z", "Site A–Z"]);
  await expect(menu.getByRole("menuitemradio", { name: "Newest first" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitemradio", { name: "Oldest first" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(sort).toContainText("Oldest first");
  await expect.poll(() => rowTitles(page)).toEqual([...newest].reverse());
  // Oldest first keeps the groups, in their order of time.
  await expect(groups).toHaveText([/^This week/, /^Yesterday/]);

  await sort.click();
  await menu.getByRole("menuitemradio", { name: "Title A–Z" }).click();
  await expect.poll(() => rowTitles(page)).toEqual([...newest].sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "accent" })));
  await expect(groups).toHaveCount(0);

  await sort.click();
  await menu.getByRole("menuitemradio", { name: "Site A–Z" }).click();
  const sites = () => page.locator("article[data-bookmark-id] [data-domain], article[data-bookmark-id] p button").allTextContents();
  await expect.poll(async () => {
    const shown = await sites();
    return shown.join() === [...shown].sort((a, b) => a.replace(/^www\./, "").localeCompare(b.replace(/^www\./, ""))).join();
  }).toBe(true);

  // Every section reads in the chosen order; the trash keeps newest deletion first and has no button.
  await page.getByRole("button", { name: /^Favorites/ }).click();
  await expect(sort).toContainText("Site A–Z");
  await page.getByRole("button", { name: /^Trash/ }).click();
  await expect(page.getByRole("button", { name: /^Sort: / })).toHaveCount(0);

  // Kept like the view.
  await page.reload();
  await page.getByRole("button", { name: "All bookmarks" }).click();
  await expect(page.getByRole("button", { name: /^Sort: / })).toHaveAccessibleName("Sort: Site A–Z");
});

test("collections: a drag puts one in another place, Esc and a drop outside change nothing, Alt arrows move it, the order stays (NP-114)", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const sidebar = page.getByRole("complementary", { name: "Library" });
  const collections = sidebar.getByRole("navigation", { name: "Collections" });
  const names = () => collections.locator("[data-collection]").evaluateAll((rows) => rows.map((r) => r.querySelector("span.truncate")?.textContent));
  const row = (name: string) => collections.locator("[data-collection]").filter({ hasText: name });
  // Never moved: by name.
  expect(await names()).toEqual(["Design", "Development", "Inspiration", "To read"]);

  // «To read» above «Development»: the line where it lands, the ghost, the row faded.
  const from = (await row("To read").boundingBox())!;
  const to = (await row("Development").boundingBox())!;
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 46, from.y + from.height / 2 - 6, { steps: 3 });
  await page.mouse.move(to.x + 60, to.y + 4, { steps: 10 });
  await expect(page.locator("[data-landing]")).toHaveCount(1);
  await expect(page.locator('[data-collection-row] .opacity-45, [data-collection-row].opacity-45')).toHaveCount(1);
  await page.screenshot({ path: "test-results/collection-move-1440.png" });
  await page.mouse.up();
  expect(await names()).toEqual(["Design", "To read", "Development", "Inspiration"]);
  // The drop did not open the collection it ended on.
  await expect(page.getByRole("heading", { level: 1 })).toContainText("All bookmarks");

  // Esc while moving, and a drop outside the list: nothing changes.
  const design = (await row("Design").boundingBox())!;
  await page.mouse.move(design.x + 40, design.y + design.height / 2);
  await page.mouse.down();
  await page.mouse.move(design.x + 40, design.y + 80, { steps: 8 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.mouse.move(design.x + 40, design.y + design.height / 2);
  await page.mouse.down();
  await page.mouse.move(design.x + 600, design.y + 60, { steps: 8 });
  await page.mouse.up();
  expect(await names()).toEqual(["Design", "To read", "Development", "Inspiration"]);
  await expect(page.locator("[data-landing]")).toHaveCount(0);

  // From the keyboard: the hint on focus, Alt arrows, the focus stays on the moved one.
  await row("Development").focus();
  await page.keyboard.press(tabKey(browserName, true));
  await page.keyboard.press(tabKey(browserName));
  await expect(row("Development")).toBeFocused();
  await expect(sidebar.getByRole("tooltip").filter({ hasText: "Move" }).first()).toBeVisible();
  await page.keyboard.press("Alt+ArrowUp");
  await page.keyboard.press("Alt+ArrowUp");
  expect(await names()).toEqual(["Development", "Design", "To read", "Inspiration"]);
  await expect(row("Development")).toBeFocused();
  await page.keyboard.press("Alt+ArrowUp");
  expect(await names()).toEqual(["Development", "Design", "To read", "Inspiration"]);
  await expect(sidebar.locator("[aria-live=polite]")).toHaveText("Development: place 1 of 4");

  // The menus follow the sidebar: «Move to collection» of a card.
  await page.locator('[data-bookmark-id="2"]').hover();
  await page.getByRole("button", { name: /^Actions: The architecture/ }).click();
  await page.getByRole("menuitem", { name: "Move to collection" }).click();
  // Keys 1–9 too: the first nine in the sidebar's order, as in triage.
  await expect(page.getByRole("menu", { name: "Move to collection" }).getByRole("menuitem")).toHaveText([
    /^Development\s*1$/,
    /^Design\s*2$/,
    /^To read\s*3$/,
    /^Inspiration\s*4$/,
    /No collection/,
  ]);
  await page.keyboard.press("Escape");

  // After a reload, and a new collection goes to the end.
  await page.reload();
  expect(await names()).toEqual(["Development", "Design", "To read", "Inspiration"]);
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    await api.createCollection("Archive");
  });
  await page.reload();
  expect(await names()).toEqual(["Development", "Design", "To read", "Inspiration", "Archive"]);
});

test("sort and collections in a narrow window: the order is an icon with a hint, the dots of the strip move (NP-114)", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 550 });
  const sort = page.getByRole("button", { name: "Sort: Newest first" });
  await expect(sort).toBeVisible();
  await expect(sort).not.toContainText("Newest first");
  expect((await sort.boundingBox())!.width).toBeLessThan(40);
  await sort.hover();
  await expect(page.getByRole("tooltip", { name: "Sort: Newest first" })).toBeVisible();

  const strip = page.getByRole("complementary", { name: "Library" });
  const dots = () => strip.locator("[data-collection]").evaluateAll((rows) => rows.map((r) => r.getAttribute("aria-label")));
  expect(await dots()).toEqual(["Design", "Development", "Inspiration", "To read"]);
  const last = (await strip.locator("[data-collection]").last().boundingBox())!;
  const first = (await strip.locator("[data-collection]").first().boundingBox())!;
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width / 2 + 6, last.y, { steps: 3 });
  await page.mouse.move(first.x + first.width / 2, first.y + 3, { steps: 10 });
  await expect(page.locator("[data-landing]")).toHaveCount(1);
  await page.mouse.up();
  expect(await dots()).toEqual(["To read", "Design", "Development", "Inspiration"]);
});

for (const view of ["Grid", "List"])
  test(`selection in the ${view === "Grid" ? "grid" : "list"}: Ctrl and Shift click, a frame that scrolls and loads pages, Esc`, async ({ page }) => {
    await largeLibrary(page);
    await page.getByRole("button", { name: view, exact: true }).click();
    const popups: unknown[] = [];
    page.on("popup", (popup) => popups.push(popup));
    const bar = page.getByRole("toolbar", { name: "Selected bookmarks" });
    const count = bar.getByRole("status");
    const selected = page.locator("[data-selected]");
    const card = (id: number) => page.locator(`[data-bookmark-id="${id}"]`);

    // Newest first: 250, 249, 248… A click selects one, the next click another instead (NP-123).
    await clickCard(card(248));
    await expect(count).toHaveText("1 selected");
    await clickCard(card(250));
    await expect(count).toHaveText("1 selected");
    await expect(card(250)).toHaveAttribute("data-selected", "true");
    await expect(card(248)).not.toHaveAttribute("data-selected");
    await clickCard(card(247), ["Shift"]);
    await expect(count).toHaveText("4 selected");
    await clickCard(card(249), ["ControlOrMeta"]);
    await expect(count).toHaveText("3 selected");
    await expect(selected).toHaveCount(3);
    // A plain click on one of several leaves it alone.
    await clickCard(card(248));
    await expect(count).toHaveText("1 selected");
    await clickCard(card(250), ["ControlOrMeta"]);
    await clickCard(card(249), ["ControlOrMeta"]);
    await expect(count).toHaveText("3 selected");
    expect(popups).toHaveLength(0);
    await expect(bar.getByRole("button", { name: "Trash", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);

    // A frame from the empty margin down past the bottom edge scrolls the list;
    // pages load on the way and the frame keeps selecting rows that left the DOM.
    const scroll = page.locator('[data-scroll="main"]');
    const box = (await scroll.boundingBox())!;
    await page.mouse.move(box.x + 10, box.y + 3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 60, box.y + 200, { steps: 5 });
    await page.mouse.move(box.x + box.width - 60, box.y + box.height + 150, { steps: 5 });
    const selectedCount = async () => Number(((await count.textContent()) ?? "0").split(" ")[0]);
    await expect.poll(selectedCount, { timeout: 15_000 }).toBeGreaterThan(100);
    await page.mouse.up();
    await expect(page.locator("[data-selection-frame]")).toHaveCount(0);
    expect(Number(await page.locator("[data-loaded]").getAttribute("data-loaded"))).toBeGreaterThan(100);
    const framed = await selectedCount();
    // Scrolling back keeps it: the selection is by id, not by element.
    await scroll.evaluate((el) => el.scrollTo({ top: 0 }));
    await expect(page.locator('[data-bookmark-id="250"]')).toHaveAttribute("data-selected", "true");
    await expect(count).toHaveText(`${framed} selected`);

    // A frame without a modifier replaces the selection, with Ctrl it adds.
    await page.mouse.move(box.x + 10, box.y + 3);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + 60, { steps: 5 });
    // Selection updates on requestAnimationFrame; releasing immediately can cancel its tick.
    await expect(count).toHaveText("1 selected");
    await page.mouse.up();
    await expect(count).toHaveText("1 selected");
    await clickCard(card(240), ["ControlOrMeta"]);
    await expect(count).toHaveText("2 selected");

    // A click on an empty place clears it.
    await page.mouse.click(box.x + 10, box.y + box.height - 10);
    await expect(bar).toHaveCount(0);
  });

test("selection: Ctrl A takes every match of 10 000 without loading them; search keeps it, another section clears it", async ({ page }) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const [first] = (await api.getBookmarks()).items;
    // Keep the selection fixture below WebKit's localStorage quota (the app uses SQLite).
    // A repeated full Bookmark carries many optional fields unrelated to this scenario.
    const bookmarks = Array.from({ length: 10_000 }, (_, i) => ({
      id: i + 1,
      url: `https://e.test/${i + 1}`,
      domain: "e.test",
      title: i % 10 ? `Entry ${i + 1}` : `Ёлка ${i + 1}`,
      collection_id: null,
      triaged_at: first.triaged_at,
      deleted_at: null,
      tags: [],
      is_favorite: i < 3,
      created_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    }));
    localStorage.setItem("koonapin.demo.v4", JSON.stringify({ bookmarks, collections: await api.getCollections() }));
  });
  await page.reload();
  await expect(page.locator("[data-loaded]")).toHaveAttribute("data-loaded", "100");
  const bar = page.getByRole("toolbar", { name: "Selected bookmarks" });
  const search = page.getByRole("textbox", { name: "Search the library" });

  // In the search field Ctrl A is the field's own.
  await search.fill("ёлка");
  await search.press("ControlOrMeta+a");
  await expect(bar).toHaveCount(0);
  await search.fill("");
  await page.locator('[data-scroll="main"]').click({ position: { x: 5, y: 5 } });

  const started = Date.now();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(bar.getByRole("status")).toHaveText("10000 selected");
  expect(Date.now() - started).toBeLessThan(1000);
  // Selected, not loaded: the list still holds one page.
  await expect(page.locator("[data-loaded]")).toHaveAttribute("data-loaded", "100");

  // Search narrows the list, not the selection; the hint counts what it hides.
  await search.fill("ёлка");
  await expect(page.getByText("9000 of the 10000 selected are hidden by the search — actions include them")).toBeVisible();
  await expect(page.locator('[data-bookmark-id="9991"]')).toHaveAttribute("data-selected", "true");
  // Esc in the field clears the query first and keeps the selection.
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(page.getByText(/hidden by the search/)).toHaveCount(0);

  // Another section clears it.
  await page.getByRole("button", { name: /^Favorites/ }).click();
  await expect(bar).toHaveCount(0);
  // Ctrl A there adds that section only; Esc in the empty field clears it.
  await page.locator('[data-scroll="main"]').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+a");
  await expect(bar.getByRole("status")).toHaveText("3 selected");
  await search.focus();
  await search.press("Escape");
  await expect(bar).toHaveCount(0);
});

/** Ctrl+click on these demo cards. */
async function selectCards(page: import("@playwright/test").Page, titles: string[]) {
  for (const title of titles) await clickCard(bookmarkNamed(page, title), ["ControlOrMeta"]);
  await expect(page.getByRole("toolbar", { name: "Selected bookmarks" }).getByRole("status")).toHaveText(`${titles.length} selected`);
}
const notice = (page: import("@playwright/test").Page, text: string | RegExp) =>
  page.locator("[role=status], [role=alert]").filter({ hasText: text });

test("bulk actions: move, tag and star as one action each, undone whole; Del to the trash; a failure changes nothing", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const bar = page.getByRole("toolbar", { name: "Selected bookmarks" });
  const three = ["The architecture of silence", "Typography is a voice", "Interfaces that stay out of the way"];
  await selectCards(page, three);
  await expect(page.getByRole("button", { name: /^Inbox/ })).toContainText("2");

  // «Move to…»: the menu above the bar; the selection stays.
  await bar.getByRole("button", { name: "Move to…" }).click();
  await page.getByRole("menuitem", { name: "Development" }).click();
  await expect(notice(page, "3 bookmarks moved to «Development»")).toBeVisible();
  await expect(bar.getByRole("status")).toHaveText("3 selected");
  // «Interfaces…» was there already: counted in the notice, not changed.
  await expect(page.getByRole("button", { name: /^Development/ })).toContainText("3");
  // A decision sorts the inbox one out of the inbox, as a single edit does.
  await expect(page.getByRole("button", { name: /^Inbox/ })).toContainText("1");
  await page.screenshot({ path: "test-results/bulk-moved-1440.png" });
  // Ctrl Z takes back the two it changed, the inbox included.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(notice(page, "Undone for 2 bookmarks")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Development/ })).toContainText("1");
  await expect(page.getByRole("button", { name: /^Inbox/ })).toContainText("2");

  // «Tag»: a field with the library's tags; Enter adds the typed one to every selected.
  await bar.getByRole("button", { name: "Tag" }).click();
  const field = page.getByRole("combobox", { name: "Tag for the selected bookmarks" });
  await expect(field).toBeFocused();
  await expect(page.getByRole("listbox", { name: "Tags in the library" }).getByRole("option")).not.toHaveCount(0);
  await page.screenshot({ path: "test-results/bulk-tag-1440.png" });
  await field.fill("Urgent");
  await field.press("Enter");
  await expect(notice(page, "Tag «urgent» added to 3 bookmarks")).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Library" }).getByRole("button", { name: "urgent" })).toBeVisible();

  // A second click on «Tag» or «Move to…» closes what the first opened.
  await bar.getByRole("button", { name: "Tag" }).click();
  await expect(field).toBeVisible();
  await bar.getByRole("button", { name: "Tag" }).click();
  await expect(field).toHaveCount(0);
  await bar.getByRole("button", { name: "Move to…" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await bar.getByRole("button", { name: "Move to…" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);

  // One of the three has a star: «Favorite» stars all, then offers to take it off.
  // From the keyboard: the button keeps the focus when it turns into «Unfavorite» (named «Remove from favorites»).
  await bar.getByRole("button", { name: "Favorite", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(notice(page, "3 bookmarks in Favorites")).toBeVisible();
  await expect(bar.getByRole("button", { name: "Remove from favorites" })).toBeFocused();
  await bar.getByRole("button", { name: "Remove from favorites" }).click();
  await expect(notice(page, "3 bookmarks removed from Favorites")).toBeVisible();
  // «Undo» in the notice undoes that action only.
  await notice(page, "removed from Favorites").getByRole("button", { name: /Undo/ }).click();
  await expect(page.getByRole("button", { name: /^Favorites/ })).toContainText("4");

  // A failure changes nothing: the alert waits, the selection stays, «Try again» does the same again.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const { CommandError } = await import("/src/services/errors.ts");
    const original = api.bulkUpdate;
    let failed = false;
    api.bulkUpdate = async (ids, change) => {
      if (!failed) {
        failed = true;
        throw new CommandError("database_busy", "database is locked");
      }
      return original(ids, change);
    };
  });
  await bar.getByRole("button", { name: "Move to…" }).click();
  await page.getByRole("menuitem", { name: "Inspiration" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toHaveText(/Couldn't move 3 bookmarks to «Inspiration»: the library is busy\. Nothing changed\./);
  await expect(page.getByRole("button", { name: /^Inspiration/ })).toContainText("2");
  await expect(bar.getByRole("status")).toHaveText("3 selected");
  await page.screenshot({ path: "test-results/bulk-failed-1440.png" });
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(notice(page, "3 bookmarks moved to «Inspiration»")).toBeVisible();

  // Del: to the trash without a dialog; the selected leave the list and the bar closes.
  await page.keyboard.press("Delete");
  await expect(notice(page, "3 bookmarks in Trash")).toBeVisible();
  await expect(bar).toHaveCount(0);
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(3);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(notice(page, "Back from Trash: 3 bookmarks")).toBeVisible();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
});

test("reading: the sidebar counts the unread, R sends the selection and takes it out in Reading, the menu marks read, Ctrl Z undoes, a restart keeps it (NP-121)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const sidebar = page.getByRole("navigation", { name: "Sections" });
  const reading = sidebar.getByRole("button", { name: /^Reading/ });
  const cards = page.locator("[data-bookmark-id]");
  const titles = () => cards.locator("h2").allTextContents();
  // The sample library has three to read; the row sits under Favorites.
  await expect(reading).toHaveText(/Reading\s*3/);
  const rows = await sidebar.getByRole("button").allTextContents();
  expect(rows.findIndex((r) => r.startsWith("Reading"))).toBe(rows.findIndex((r) => r.startsWith("Favorites")) + 1);
  await reading.click();
  await expect(cards).toHaveCount(3);
  // Newest added first, whatever order the library is in.
  expect(await titles()).toEqual(["Ten principles for good design", "Typography is a voice", "Interfaces that stay out of the way"]);
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toContainText("Reading");

  // R in the library sends the selection; Ctrl Z takes it back whole.
  await sidebar.getByRole("button", { name: /^All bookmarks/ }).click();
  await selectCards(page, ["Noticing the everyday", "Notes on attention"]);
  await page.keyboard.press("r");
  await expect(notice(page, "2 bookmarks sent to Reading")).toBeVisible();
  await expect(reading).toHaveText(/Reading\s*5/);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(notice(page, "Undone for 2 bookmarks")).toBeVisible();
  await expect(reading).toHaveText(/Reading\s*3/);
  // The bar does the same, its button named in full.
  await page.getByRole("toolbar", { name: "Selected bookmarks" }).getByRole("button", { name: "Send to Reading" }).click();
  await expect(reading).toHaveText(/Reading\s*5/);
  await page.keyboard.press("Escape");

  // The newest sent come first; in Reading, R takes the selection out.
  await reading.click();
  await expect(cards).toHaveCount(5);
  expect((await titles()).slice(2)).toEqual(["Ten principles for good design", "Typography is a voice", "Interfaces that stay out of the way"]);
  await selectCards(page, ["Typography is a voice"]);
  await page.keyboard.press("r");
  await expect(notice(page, "1 bookmark removed from Reading")).toBeVisible();
  await expect(cards).toHaveCount(4);
  await expect(reading).toHaveText(/Reading\s*4/);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(cards).toHaveCount(5);
  await page.keyboard.press("Escape");

  // «Mark as read» in the card menu: the unread count drops, the card goes to the bottom.
  await page.locator('[data-bookmark-id="1"]').hover();
  await page.getByRole("button", { name: "Actions: Ten principles for good design" }).click();
  await expect(page.getByRole("menuitem", { name: "Remove from Reading R" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Mark as read" }).click();
  await expect(notice(page, "Marked as read")).toBeVisible();
  await expect(reading).toHaveText(/Reading\s*4/);
  await expect.poll(async () => (await titles()).at(-1)).toBe("Ten principles for good design");
  await page.screenshot({ path: "test-results/reading-1440.png" });

  // The state outlives a restart.
  await page.reload();
  await expect(reading).toHaveText(/Reading\s*4/);
  await reading.click();
  await expect(cards).toHaveCount(5);
  // «Remove from Reading» from the menu, undone from its notice.
  await page.locator('[data-bookmark-id="1"]').hover();
  await page.getByRole("button", { name: "Actions: Ten principles for good design" }).click();
  await page.getByRole("menuitem", { name: "Mark as unread" }).click();
  await expect(reading).toHaveText(/Reading\s*5/);
  await page.locator('[data-bookmark-id="1"]').hover();
  await page.getByRole("button", { name: "Actions: Ten principles for good design" }).click();
  await page.getByRole("menuitem", { name: /^Remove from Reading/ }).click();
  await expect(cards).toHaveCount(4);
  await notice(page, "Removed from Reading").getByRole("button", { name: /Undo/ }).click();
  await expect(cards).toHaveCount(5);
  // Nothing in the trash is listed or counted.
  await page.locator('[data-bookmark-id="1"]').hover();
  await page.getByRole("button", { name: "Actions: Ten principles for good design" }).click();
  await page.getByRole("menuitem", { name: /^Move to trash/ }).click();
  await expect(cards).toHaveCount(4);
  await expect(reading).toHaveText(/Reading\s*4/);
});

test("bulk actions: a new collection from the selection, export of the selected, the trash restores and deletes for good", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const bar = page.getByRole("toolbar", { name: "Selected bookmarks" });
  await selectCards(page, ["Ten principles for good design", "Noticing the everyday"]);

  // The name field in the sidebar: Esc creates nothing, Enter creates and moves in one action.
  await bar.getByRole("button", { name: "Move to…" }).click();
  await page.getByRole("menuitem", { name: "New collection from selection…" }).click();
  const name = page.getByRole("textbox", { name: "Name of the new collection" });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("New collection");
  await expect(page.getByText("Enter — create and move")).toBeVisible();
  await page.screenshot({ path: "test-results/bulk-new-collection-1440.png" });
  await name.press("Escape");
  await expect(name).toHaveCount(0);
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Move to…" }).click();
  await page.getByRole("menuitem", { name: "New collection from selection…" }).click();
  await name.fill("Picked");
  await name.press("Enter");
  await expect(notice(page, "2 bookmarks moved to «Picked»")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Picked/ })).toContainText("2");

  // Export: the formats of the «⋯» menu, the selected only.
  await bar.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: /CSV for spreadsheets/ }).click();
  await expect(notice(page, /^2 bookmarks saved to koona-pin-selected-\d{4}-\d{2}-\d{2}\.csv/)).toBeVisible();

  // In the trash the bar offers to restore, export and delete for good.
  await page.keyboard.press("Delete");
  await page.getByRole("button", { name: /^Trash/ }).click();
  await page.locator('[data-scroll="main"]').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+a");
  await expect(bar.getByRole("status")).toHaveText("2 selected");
  await expect(bar.getByRole("button", { name: "Move to…" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/bulk-trash-1440.png" });
  await bar.getByRole("button", { name: "Restore" }).click();
  await expect(notice(page, "2 bookmarks restored")).toBeVisible();
  await expect(bar).toHaveCount(0);
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(0);

  await page.getByRole("button", { name: "All bookmarks" }).click();
  await selectCards(page, ["Ten principles for good design", "Noticing the everyday"]);
  await page.keyboard.press("Delete");
  await page.getByRole("button", { name: /^Trash/ }).click();
  await page.locator('[data-scroll="main"]').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  const dialog = page.getByRole("dialog", { name: "Delete forever?" });
  await expect(dialog).toContainText("2 bookmarks will be deleted for good");
  await dialog.getByRole("button", { name: "Delete forever" }).click();
  await expect(notice(page, "2 bookmarks deleted for good")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Trash/ })).toContainText("0");
});

/** Press on `from`, move past the 4 px threshold, then over `to`; the button stays down. */
async function dragOver(page: import("@playwright/test").Page, from: import("@playwright/test").Locator, to: import("@playwright/test").Locator) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 8, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
}
const dropHint = (page: import("@playwright/test").Page) => page.locator("[data-drop-hint]");

test("drag: the selection onto a collection, a tag and the trash; the hint names the action and Ctrl Z takes it back", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const bar = page.getByRole("toolbar", { name: "Selected bookmarks" });
  const sidebar = page.getByRole("complementary", { name: "Library" });
  const three = ["The architecture of silence", "Typography is a voice", "Interfaces that stay out of the way"];
  await selectCards(page, three);
  // Sheet S3: the bar counts them; its keys are in the hints of its buttons (#319).
  await expect(bar.getByRole("status")).toHaveText("3 selected");
  const opened: string[] = [];
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    (window as unknown as { opened: string[] }).opened = [];
    api.openUrl = async (url: string) => void (window as unknown as { opened: string[] }).opened.push(url);
  });

  // From the preview of a selected card onto «Development»: the stack, the targets, the hint.
  const preview = page.locator("[data-bookmark-id][data-selected] [data-preview]").first();
  await dragOver(page, preview, sidebar.getByRole("button", { name: /^Development/ }));
  await expect(dropHint(page)).toHaveText("Move 3 to “Development”");
  await expect(page.locator("[data-drag-stack]")).toContainText("and 2 more bookmarks");
  await expect(page.locator("[data-dragging] [data-selected]").first()).toHaveCSS("opacity", "0.45");
  await expect(sidebar.getByText("New collection from selection")).toBeVisible();
  await expect(sidebar.getByText("Tags — drop on a tag to add it")).toBeVisible();
  await expect(page.getByText("Release over a collection, a tag or Trash")).toBeVisible();
  await page.screenshot({ path: "test-results/drag-collection-1440.png" });
  await page.mouse.up();
  await expect(notice(page, "3 bookmarks moved to «Development»")).toBeVisible();
  await expect(page.locator("[data-drag-stack]")).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: /^Development/ })).toContainText("3");
  // The drop did not open the card it started on, and the selection stays.
  expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual(opened);
  await expect(bar.getByRole("status")).toHaveText("3 selected");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(notice(page, "Undone for 2 bookmarks")).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /^Development/ })).toContainText("1");

  // Every tag is a target while dragging, the hidden ones too; the hint follows the pointer.
  const tags = sidebar.locator('[data-drop^="tag:"]');
  await expect(sidebar.getByRole("button", { name: /^\+ \d+ more/ })).toBeVisible();
  await dragOver(page, preview, sidebar.getByRole("button", { name: /^Favorites/ }));
  await expect(dropHint(page)).toHaveText("Drop on a collection, a tag or Trash");
  await expect(tags).toHaveCount(10);
  await expect(sidebar.getByRole("button", { name: /^\+ \d+ more/ })).toHaveCount(0);
  const last = tags.last();
  const tag = (await last.textContent())!;
  const box = (await last.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  await expect(dropHint(page)).toHaveText(`Add tag “${tag}” to 3`);
  await page.screenshot({ path: "test-results/drag-tag-1440.png" });
  await page.mouse.up();
  await expect(notice(page, `Tag «${tag}» added to 3 bookmarks`)).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /^\+ \d+ more/ })).toBeVisible();

  // «Trash»: no confirmation, the selected leave and the bar closes; Ctrl Z brings them back.
  await dragOver(page, preview, sidebar.getByRole("button", { name: /^Trash/ }));
  await expect(dropHint(page)).toHaveText("Move 3 to Trash");
  await page.screenshot({ path: "test-results/drag-trash-1440.png" });
  await page.mouse.up();
  await expect(notice(page, "3 bookmarks in Trash")).toBeVisible();
  await expect(bar).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(notice(page, "Back from Trash: 3 bookmarks")).toBeVisible();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
});

test("drag: Esc and a drop outside a target change nothing; an unselected card still starts the frame; a new collection asks for its name", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const bar = page.getByRole("toolbar", { name: "Selected bookmarks" });
  const sidebar = page.getByRole("complementary", { name: "Library" });
  await selectCards(page, ["Ten principles for good design", "Noticing the everyday"]);
  const selected = page.locator("[data-bookmark-id][data-selected]").first();

  // Esc ends the drag only: no action, the selection stays.
  await dragOver(page, selected.locator("[data-preview]"), sidebar.getByRole("button", { name: /^Inspiration/ }));
  await expect(dropHint(page)).toHaveText("Move 2 to “Inspiration”");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-drag-stack]")).toHaveCount(0);
  await page.mouse.up();
  await expect(bar.getByRole("status")).toHaveText("2 selected");
  await expect(sidebar.getByRole("button", { name: /^Inspiration/ })).toContainText("2");
  await expect(page.locator("[data-dragging]")).toHaveCount(0);

  // Released over the list: nothing happens.
  await dragOver(page, selected.locator("[data-preview]"), page.getByRole("heading", { name: "All bookmarks" }));
  await page.mouse.up();
  await expect(page.locator("[role=status], [role=alert]").filter({ hasText: /moved|in Trash|added/ })).toHaveCount(0);
  await expect(bar.getByRole("status")).toHaveText("2 selected");

  // A press on an unselected card is a selection frame, as before.
  const other = page.locator("[data-bookmark-id]:not([data-selected])").first();
  const box = (await other.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height + 20, { steps: 4 });
  await expect(page.locator("[data-selection-frame]")).toBeVisible();
  await expect(page.locator("[data-drag-stack]")).toHaveCount(0);
  await page.mouse.up();
  await expect(bar.getByRole("status")).toHaveText("1 selected");

  // «New collection from selection»: the name field, Enter creates and moves in one action.
  await page.keyboard.press("Escape");
  await selectCards(page, ["Ten principles for good design", "Noticing the everyday"]);
  // The target appears only once the drag has started.
  await dragOver(page, page.locator("[data-bookmark-id][data-selected] [data-preview]").first(), sidebar.getByRole("button", { name: /^Favorites/ }));
  const fresh = (await sidebar.getByText("New collection from selection").boundingBox())!;
  await page.mouse.move(fresh.x + fresh.width / 2, fresh.y + fresh.height / 2, { steps: 6 });
  await expect(dropHint(page)).toHaveText("New collection from 2");
  await page.screenshot({ path: "test-results/drag-new-collection-1440.png" });
  await page.mouse.up();
  const name = page.getByRole("textbox", { name: "Name of the new collection" });
  await expect(name).toBeFocused();
  await name.fill("Dragged");
  await name.press("Enter");
  await expect(notice(page, "2 bookmarks moved to «Dragged»")).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /^Dragged/ })).toContainText("2");
});

test("drag in a narrow window: collection dots and the trash of the strip are targets; the trash section does not drag", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await selectCards(page, ["The architecture of silence", "Typography is a voice"]);
  const strip = page.getByRole("complementary", { name: "Library" });
  const preview = page.locator("[data-bookmark-id][data-selected] [data-preview]").first();
  await dragOver(page, preview, strip.getByRole("button", { name: "Development", exact: true }));
  await expect(dropHint(page)).toHaveText("Move 2 to “Development”");
  await page.screenshot({ path: "test-results/drag-narrow-900.png" });
  await page.mouse.up();
  await expect(notice(page, "2 bookmarks moved to «Development»")).toBeVisible();
  await dragOver(page, preview, strip.getByRole("button", { name: "Trash", exact: true }));
  await expect(dropHint(page)).toHaveText("Move 2 to Trash");
  await page.mouse.up();
  await expect(notice(page, "2 bookmarks in Trash")).toBeVisible();

  // In the trash a press on a selected card does not lift it.
  await strip.getByRole("button", { name: "Trash", exact: true }).click();
  await page.locator('[data-scroll="main"]').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+a");
  await dragOver(page, page.locator("[data-bookmark-id][data-selected] [data-preview]").first(), strip.getByRole("button", { name: "Development", exact: true }));
  await expect(page.locator("[data-drag-stack]")).toHaveCount(0);
  await page.mouse.up();
});

test("bulk actions on 1 000 bookmarks keep the loaded pages and the scroll position", async ({ page }) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const [first] = (await api.getBookmarks()).items;
    const bookmarks = Array.from({ length: 1000 }, (_, i) => ({
      ...first,
      id: i + 1,
      url: `https://example.com/${i + 1}`,
      title: `Entry ${i + 1}`,
      tags: [],
      is_favorite: false,
      collection_id: null,
      triaged_at: "2026-01-01T00:00:00.000Z",
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }));
    localStorage.setItem("koonapin.demo.v4", JSON.stringify({ bookmarks, collections: await api.getCollections() }));
  });
  await page.reload();
  const list = page.locator("[data-loaded]");
  await expect(list).toHaveAttribute("data-loaded", "100");
  const scroll = page.locator('[data-scroll="main"]');
  await scroll.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(list).toHaveAttribute("data-loaded", "200");
  const top = await scroll.evaluate((el) => el.scrollTop);

  await page.keyboard.press("ControlOrMeta+a");
  const bar = page.getByRole("toolbar", { name: "Selected bookmarks" });
  await expect(bar.getByRole("status")).toHaveText("1000 selected");
  const started = Date.now();
  await bar.getByRole("button", { name: "Move to…" }).click();
  await page.getByRole("menuitem", { name: "To read" }).click();
  await expect(notice(page, "1000 bookmarks moved to «To read»")).toBeVisible();
  expect(Date.now() - started).toBeLessThan(2000);
  await expect(page.getByRole("button", { name: /^To read/ })).toContainText("1000");
  // Merged in place: no page was read again, the list did not jump.
  await expect(list).toHaveAttribute("data-loaded", "200");
  expect(Math.abs((await scroll.evaluate((el) => el.scrollTop)) - top)).toBeLessThan(2);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(notice(page, "Undone for 1000 bookmarks")).toBeVisible();
  await expect(page.getByRole("button", { name: /^To read/ })).toContainText("0");
  await expect(list).toHaveAttribute("data-loaded", "200");
});

test("a click on a domain filters by site; Esc clears the search; nothing found offers the whole library", async ({ page }) => {
  await page.locator('[data-bookmark-id="1"]').getByRole("button", { name: "Only bookmarks from vitsoe.com" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("1 of 6");
  await page.getByRole("button", { name: "Remove site filter vitsoe.com" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);

  const search = page.getByRole("textbox", { name: "Search the library" });
  await page.getByRole("button", { name: /^Inspiration/ }).click();
  await search.fill("typography");
  await expect(page.getByRole("heading", { name: "Nothing in “Inspiration” matches “typography”" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("0 of 2");
  await expect(page.locator("label kbd")).toHaveText("Esc");
  await page.getByRole("button", { name: "Search the whole library" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  await expect(search).toHaveValue("typography");
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
  // The first Esc clears, the field keeps the keys; the next one lets it go: it rests, its hint back.
  await expect(search).toBeFocused();
  await search.press("Escape");
  await expect(search).not.toBeFocused();
  await expect(page.locator("label kbd")).not.toHaveText("Esc");
  await expect(page.locator("label kbd")).toHaveCSS("opacity", "1");
});

test("editor: empty title is marked, tags are chips, Ctrl Enter saves, Cancel keeps the bookmark", async ({ page }) => {
  const card = page.locator('[data-bookmark-id="1"]');
  await card.hover();
  await card.getByRole("button", { name: /^Actions:/ }).click();
  await page.getByRole("menuitem", { name: "Edit…" }).click();
  const title = page.getByLabel("Title", { exact: true });
  await title.fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Title can’t be empty")).toBeVisible();
  await expect(title).toBeFocused();

  await title.fill("Ten principles");
  const tags = page.getByLabel("Tags", { exact: true });
  await page.getByRole("button", { name: "Remove tag principles" }).click();
  await tags.fill("Rams");
  await tags.press("Enter");
  await tags.fill("braun");
  // Ctrl Enter saves from any field and keeps the tag still being typed.
  await tags.press("ControlOrMeta+Enter");
  await expect(page.getByRole("status")).toContainText("Changes saved");
  await page.getByRole("button", { name: "List", exact: true }).click();
  const row = page.locator('[data-bookmark-id="1"]');
  await expect(row).toContainText("Ten principles");
  await expect(row.getByRole("button", { name: "rams" })).toBeVisible();
  await expect(row.getByRole("button", { name: "braun" })).toBeVisible();
  await expect(row.getByRole("button", { name: "principles", exact: true })).toHaveCount(0);

  await row.hover();
  // The card itself takes focus (NP-123); Shift F10 opens its menu.
  await row.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Edit…" }).click();
  await page.getByLabel("Title", { exact: true }).fill("Won't be saved");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(row).toContainText("Ten principles");
  await row.hover();
  // The card itself takes focus (NP-123); Shift F10 opens its menu.
  await row.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Edit…" }).click();
  // No confirmation: the bookmark goes to the trash and the editor closes.
  const editor = page.getByRole("complementary", { name: "Edit bookmark" });
  await editor.getByRole("button", { name: "Move to trash" }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Moved to Trash");
  await expect(page.locator('[data-bookmark-id="1"]')).toHaveCount(0);
});

test("editor: a failed save shows the reason and keeps everything typed", async ({ page }) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const { CommandError } = await import("/src/services/errors.ts");
    const original = api.updateBookmark;
    let failed = false;
    api.updateBookmark = async (id, data) => {
      if (!failed) {
        failed = true;
        throw new CommandError("database_busy", "busy");
      }
      return original(id, data);
    };
  });
  const card = page.locator('[data-bookmark-id="2"]');
  await card.hover();
  await card.getByRole("button", { name: /^Actions:/ }).click();
  await page.getByRole("menuitem", { name: "Edit…" }).click();
  await page.getByLabel("Title", { exact: true }).fill("Silence and light");
  await page.getByLabel("Note", { exact: true }).fill("Reread in winter");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Couldn’t save — your changes are still in the form.");
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Silence and light");
  await expect(page.getByLabel("Note", { exact: true })).toHaveValue("Reread in winter");
  await page.getByRole("button", { name: "Save again", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Changes saved");
  await expect(page.locator('[data-bookmark-id="2"]')).toContainText("Silence and light");
});
test("the heart: one per card and row, seen without hover, one click, Ctrl Z, keyboard, Ctrl click selects (NP-086)", async ({ page, browserName }) => {
  const favorites = page.getByRole("button", { name: /^Favorites \d/ });
  const heart = (id: number) => page.locator(`[data-bookmark-id="${id}"] [data-favorite]`);
  // Grid, no hover: one heart in each card, its state on it.
  await page.mouse.move(0, 0);
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
  for (const id of [1, 2, 3, 4, 5, 6]) {
    await expect(page.locator(`[data-bookmark-id="${id}"]`).getByRole("button", { name: /favorites/ })).toHaveCount(1);
    await expect(heart(id)).toBeVisible();
  }
  await expect(heart(1)).toHaveAttribute("aria-pressed", "true");
  await expect(heart(4)).toHaveAttribute("aria-pressed", "false");
  await expect(heart(4)).toHaveAccessibleName("Add to favorites");
  await expect(favorites).toHaveText(/2$/);

  // One click on and off; the count follows at once; Ctrl Z takes the last one back.
  await heart(4).click();
  await expect(heart(4)).toHaveAttribute("aria-pressed", "true");
  await expect(heart(4)).toHaveAccessibleName("Remove from favorites");
  await expect(favorites).toHaveText(/3$/);
  await heart(4).click();
  await expect(favorites).toHaveText(/2$/);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(heart(4)).toHaveAttribute("aria-pressed", "true");
  await expect(favorites).toHaveText(/3$/);
  // The click opened nothing and selected nothing.
  await expect(page.getByRole("toolbar", { name: "Selected bookmarks" })).toHaveCount(0);

  // Ctrl click on the heart selects the card, as anywhere else on it.
  await heart(5).click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByRole("toolbar", { name: "Selected bookmarks" }).getByRole("status")).toHaveText("1 selected");
  await expect(heart(5)).toHaveAttribute("aria-pressed", "false");
  // A click on the heart keeps the selection, and on a selected card it is no drag, even with a shaky hand.
  await heart(6).click({ modifiers: ["ControlOrMeta"] });
  const selection = page.getByRole("toolbar", { name: "Selected bookmarks" }).getByRole("status");
  await expect(selection).toHaveText("2 selected");
  await heart(4).click();
  await expect(heart(4)).toHaveAttribute("aria-pressed", "false");
  await expect(selection).toHaveText("2 selected");
  const box = (await heart(5).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2 + 3, { steps: 3 });
  await expect(page.locator("[data-drag-stack]")).toHaveCount(0);
  await page.mouse.up();
  await expect(heart(5)).toHaveAttribute("aria-pressed", "true");
  await expect(selection).toHaveText("2 selected");
  await heart(5).click();
  await heart(4).click();
  await expect(favorites).toHaveText(/3$/);
  await page.keyboard.press("Escape");

  // From the keyboard: Tab reaches it, Enter and Space toggle.
  await heart(6).focus();
  await page.keyboard.press("Enter");
  await expect(heart(6)).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press(" ");
  await expect(heart(6)).toHaveAttribute("aria-pressed", "false");
  await page.locator('[data-bookmark-id="6"]').getByRole("button", { name: "Only bookmarks from are.na" }).focus();
  // «Save offline» stands left of the heart (NP-126): Tab passes it first.
  await page.keyboard.press(tabKey(browserName));
  await expect(page.locator('[data-bookmark-id="6"] [data-offline-save]')).toBeFocused();
  await page.keyboard.press(tabKey(browserName));
  await expect(heart(6)).toBeFocused();

  // The list: the same heart in its own column, always there; not among the hover actions.
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(heart(2)).toBeVisible();
  await heart(2).click();
  await expect(heart(2)).toHaveAttribute("aria-pressed", "true");
  await expect(favorites).toHaveText(/4$/);
  await page.locator('[data-bookmark-id="3"]').hover();
  await expect(page.locator('[data-bookmark-id="3"]').getByRole("button", { name: /favorites/ })).toHaveCount(1);

  // Kept after a restart; in the trash there is no heart.
  await page.reload();
  await expect(favorites).toHaveText(/4$/);
  await page.locator('[data-bookmark-id="5"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await page.getByRole("button", { name: "Trash 1", exact: true }).click();
  await expect(page.locator('[data-bookmark-id="5"]')).toBeVisible();
  await expect(heart(5)).toHaveCount(0);
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await expect(heart(5)).toHaveCount(0);
  await expect(page.locator('[data-bookmark-id="5"]')).toContainText("30 days left");
});
test("covers: no empty plates; a site keeps its colour; a fresh link shimmers; hover lives; Refresh preview (NP-087)", async ({ page }) => {
  const cover = (id: number) => page.locator(`[data-bookmark-id="${id}"] [data-cover]`);
  // The demo's pages without a picture get covers; no grey plate anywhere.
  await expect(cover(4)).toBeVisible();
  await expect(cover(6)).toBeVisible();
  await expect(page.locator("[data-bookmark-id] [data-preview-fallback]:not([data-cover])")).toHaveCount(0);
  await expect(cover(6).locator(".cover-letter")).toHaveText("A");
  const style = (id: number) =>
    cover(id).evaluate((el) => ({ from: el.style.getPropertyValue("--from"), to: el.style.getPropertyValue("--to"), pattern: el.dataset.cover }));

  // Two more pages of linear.app: the colour of the site, patterns of their own.
  const ids = await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const data = { bookmarks: (await api.getBookmarks()).items, collections: await api.getCollections() };
    const at = new Date(Date.now() - 60_000).toISOString();
    const next = (n: number, url: string, created = at) => ({ ...data.bookmarks[0], id: n, url, domain: new URL(url).hostname, title: url, image_url: null, favicon_url: null, site_name: null, created_at: created, source: "chrome" });
    data.bookmarks.unshift(
      next(7, "https://linear.app/method"),
      next(8, "https://linear.app/changelog/2026-10-01"),
      // Saved a moment ago: its metadata is still on its way.
      next(9, "https://example.com/just-saved", new Date(Date.now() - 9_000).toISOString()),
      { ...next(10, "https://mail.google.com/mail/u/0/"), revision: 2 },
    );
    localStorage.setItem("koonapin.demo.v4", JSON.stringify(data));
    return [7, 8];
  });
  await page.reload();
  await expect(page.locator('[data-bookmark-id="9"] [data-preview-pending]')).toBeVisible();
  const [four, seven, eight] = [await style(4), await style(ids[0]), await style(ids[1])];
  expect([seven.from, seven.to]).toEqual([four.from, four.to]);
  expect([eight.from, eight.to]).toEqual([four.from, four.to]);
  // When the wait is over without a picture, the cover takes its place.
  await expect(cover(9)).toBeVisible({ timeout: 8_000 });
  await expect(page.locator("[data-preview-pending]")).toHaveCount(0);
  // One site, one letter: on the cover and beside the domain.
  await expect(cover(10).locator(".cover-letter")).toHaveText("G");
  await expect(page.locator('[data-bookmark-id="10"] > div').nth(1).locator("span").first()).toHaveText("G");

  // A live grid cover answers the pointer; a list thumbnail does not.
  await expect(cover(4)).toHaveAttribute("data-live");
  await cover(4).scrollIntoViewIfNeeded();
  const box = (await cover(4).boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.5);
  await page.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.5);
  await expect.poll(() => cover(4).evaluate((el) => Number(el.style.getPropertyValue("--cx")))).toBeGreaterThan(0.5);
  await page.mouse.move(0, 0);
  await expect.poll(() => cover(4).evaluate((el) => el.style.getPropertyValue("--cx"))).toBe("");
  // Without motion: no drift.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  expect(await cover(4).evaluate((el) => getComputedStyle(el).animationDuration)).toBe("0s");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(cover(4)).toBeVisible();
  await expect(cover(4)).not.toHaveAttribute("data-live");

  // «Refresh preview» reads the page again; the demo reads none and says so.
  await page.locator('[data-bookmark-id="6"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Refresh preview" }).click();
  await expect(page.getByRole("status")).toContainText("The page offers no picture — the cover stays");
  await page.locator('[data-bookmark-id="1"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Refresh preview" }).click();
  await expect(page.getByRole("status")).toContainText("Nothing new on the page — the preview stays");

  // A link added in the demo waits a moment, as the app would, then shows its cover.
  // At the top of the list: further down a new link waits behind «New bookmarks».
  await page.locator('[data-scroll="main"]').evaluate((el) => el.scrollTo({ top: 0 }));
  await page.getByRole("button", { name: "Add link", exact: true }).click();
  await page.getByLabel("Link", { exact: true }).fill("https://example.net/added");
  await page.getByRole("button", { name: "Save link" }).click();
  const added = page.locator("[data-bookmark-id]", { hasText: "example.net" });
  await expect(added.locator("[data-cover]")).toBeVisible({ timeout: 3_000 });
  await expect(page.locator("[data-preview-pending]")).toHaveCount(0);

  // A picture that does not load gives way to the cover too.
  await page.evaluate(async () => {
    const data = JSON.parse(localStorage.getItem("koonapin.demo.v4")!);
    data.bookmarks.find((b: { id: number }) => b.id === 1).image_url = "/missing-picture.png";
    localStorage.setItem("koonapin.demo.v4", JSON.stringify(data));
  });
  await page.reload();
  await expect(cover(1)).toBeVisible();
});
test("connect dialog: steps for each browser, no token and no bookmarklet", async ({ page }) => {
  await page.getByRole("button", { name: "No browser yet" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect browser" });
  // Every tab is laid out at once (fixed height); its text is read in the one shown.
  const shown = dialog.locator("[data-tab-panel][data-active]");
  await expect(dialog.locator('[data-capture="none"]')).toContainText("No browser yet");
  // Chrome installs from the Chrome Web Store, Edge from Edge Add-ons.
  await expect(shown).toContainText("Open the Koona Pin page in the Chrome Web Store");
  await expect(dialog.getByRole("button", { name: "Open Chrome Web Store" })).toBeVisible();
  await dialog.getByRole("radio", { name: "Edge" }).click();
  await expect(shown).toContainText("Open the Koona Pin page in Edge Add-ons");
  await expect(dialog.getByRole("button", { name: "Open Edge Add-ons" })).toBeVisible();
  await expect(shown).toContainText("edge://extensions");
  // Firefox takes the signed add-on from koona.app's downloads page (NP-018).
  await dialog.getByRole("radio", { name: "Firefox" }).click();
  await expect(shown).toContainText("Open the downloads page on koona.app in Firefox");
  await expect(dialog.getByRole("button", { name: "Open koona.app" })).toBeVisible();
  await expect(shown).toContainText("Firefox checks koona.app for a new version");
  await expect(shown).toContainText("about:addons");
  await expect(dialog).not.toContainText(/token|bookmarklet/i);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const block = page.locator('[data-capture="none"]');
  await expect(block).toContainText("The extension saves a page in one click");
  await block.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Connect browser" })).toBeVisible();
});

test("Linux without a tray: round window buttons, Chromium, Firefox from Snap and sandboxed browsers, «in the background» (NP-053, NP-054)", async ({ page }) => {
  await page.evaluate(() =>
    localStorage.setItem("koonapin.demo.desktop", JSON.stringify({ linux: true, left: [], right: ["close"], tray: false })),
  );
  await page.reload();
  // GNOME's layout: «×» only, round.
  await expect(page.locator("[data-window-button]")).toHaveCount(1);
  await expect(page.locator('[data-window-button="close"]')).toHaveAttribute("aria-label", "Close window");
  await page.getByRole("button", { name: "No browser yet" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect browser" });
  const shown = dialog.locator("[data-tab-panel][data-active]");
  await expect(dialog.getByRole("radio")).toHaveText(["Chrome", "Edge", "Chromium", "Firefox"]);
  // Chromium takes Chrome's steps; a closed app starts in the background without a tray.
  await dialog.getByRole("radio", { name: "Chromium" }).click();
  await expect(shown).toContainText("Open the Koona Pin page in the Chrome Web Store");
  await expect(shown).toContainText("chrome://extensions");
  await expect(shown).toContainText("it starts in the background and saves the link");
  await expect(shown).not.toContainText("Firefox from Snap, Ubuntu's default");
  await dialog.getByRole("radio", { name: "Firefox" }).click();
  await expect(shown).toContainText("Firefox from Snap, Ubuntu's default, asks on the first save");
  await expect(shown.locator("[data-sandboxed]")).toContainText("Browsers from Flatpak and Chromium from Snap");
  await page.keyboard.press("Escape");
  // Settings say «in the background» and offer the way out.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Keep running in the background when the window is closed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Quit", exact: true })).toBeVisible();
});

test("macOS: Safari first in «Connect browser», turned on in Safari's settings; the menu bar, not a tray (NP-119)", async ({ page }) => {
  await page.evaluate(() =>
    localStorage.setItem("koonapin.demo.desktop", JSON.stringify({ native_frame: true, linux: false, left: [], right: [], tray: true, appimage: false })),
  );
  await page.reload();
  await page.getByRole("button", { name: "No browser yet" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect browser" });
  const shown = dialog.locator("[data-tab-panel][data-active]");
  await expect(dialog.getByRole("radio")).toHaveText(["Safari", "Chrome", "Edge", "Chromium", "Firefox"]);
  await expect(dialog.getByRole("radio", { name: "Safari" })).toBeChecked();
  // Nothing to install: the extension is inside the app.
  await expect(shown).toContainText("Turn on the extension");
  await expect(shown).toContainText("In Safari, open Settings → Extensions and turn on Koona Pin.");
  await expect(shown).toContainText("Allow it on websites");
  await expect(shown.getByRole("button")).toHaveCount(0);
  await expect(shown).toContainText("it starts in the menu bar and saves the link");
  await expect(shown).toContainText("The extension updates with Koona Pin");
  await dialog.getByRole("radio", { name: "Chrome" }).click();
  await expect(shown).toContainText("Open the Koona Pin page in the Chrome Web Store");
  await expect(shown).toContainText("it starts in the menu bar and saves the link");
});

test("app update: a row only with a new version, the dialog on demand, the download, cancel, a failure in ochre, Settings (NP-038)", async ({ page }) => {
  // Up to date: no row, Settings say so.
  await expect(page.locator("button[data-update]")).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator("section[data-update]")).toContainText("Up to date · checked today at");
  // The changelog of the running version, left of the button (NP-040).
  await expect(page.locator("section[data-update]").getByRole("button", { name: "Changelog ↗" })).toBeVisible();
  await page.evaluate(() => localStorage.setItem("koonapin.demo.update", "failing"));
  await page.reload();
  const row = page.locator("button[data-update]");
  await expect(row).toHaveAttribute("data-update", "available");
  await expect(row).toHaveText("Update available0.3.0");
  // The dialog opens only from the row.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await row.click();
  const offer = page.getByRole("dialog", { name: "Koona Pin 0.3.0 is available" });
  await expect(offer).toContainText("Your library, settings and browser connection stay as they are.");
  await expect(offer).toContainText("Koona Pin closes for a few seconds");
  // What changed, from latest.json, and the way to the whole changelog (NP-040, sheet 42a).
  const notes = offer.getByRole("region", { name: "What's new in 0.3.0" });
  await expect(notes.getByRole("listitem")).toHaveCount(3);
  await expect(notes.getByRole("listitem").first()).toHaveText(/checks koona\.app once a day/);
  await expect(offer.getByRole("button", { name: "Full changelog ↗" })).toBeVisible();
  await offer.getByRole("button", { name: "Later" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toHaveAttribute("data-update", "available");
  // Download, then cancel: the version is offered again.
  await row.click();
  await page.getByRole("button", { name: "Update", exact: true }).click();
  const downloading = page.getByRole("dialog", { name: "Downloading Koona Pin 0.3.0" });
  await expect(downloading.getByRole("progressbar")).toBeVisible();
  await expect(row).toHaveAttribute("data-update", "downloading");
  await downloading.getByRole("button", { name: "Cancel download" }).click();
  await expect(page.getByRole("dialog", { name: "Koona Pin 0.3.0 is available" })).toBeVisible();
  await expect(row).toHaveAttribute("data-update", "available");
  // Again; the preview's download stops at 40 %: «Couldn't update», the row in ochre with «Retry».
  await page.getByRole("button", { name: "Update", exact: true }).click();
  const failed = page.getByRole("dialog", { name: "Couldn't update" });
  await expect(failed.getByRole("alert")).toContainText("The download stopped: no connection to koona.app.");
  await expect(row).toHaveAttribute("data-update", "failed");
  await expect(row).toHaveText("Update failedRetry");
  await failed.getByRole("button", { name: "Close", exact: true }).last().click();
  // Settings → Updates offers the same dialog; what changed is in it, not a link beside.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator("section[data-update]")).toContainText("Version 0.3.0 wasn't installed");
  await expect(page.locator("section[data-update]").getByText("What's new")).toHaveCount(0);
  await page.locator("section[data-update]").getByRole("button", { name: "Update…" }).click();
  await expect(page.getByRole("dialog", { name: "Couldn't update" })).toBeVisible();
  await page.keyboard.press("Escape");
  // A narrow window: an icon above the browser in the strip, the whole text in its hint.
  await page.setViewportSize({ width: 900, height: 600 });
  await expect(page.getByRole("button", { name: "Update failed", exact: true })).toBeVisible();
});

test("Supporter: nothing in a build that does not sell it; the row, the plan, the payment in the browser, the badge and its dialog (NP-066, sheet 45)", async ({ page }) => {
  // A build without the account service: no row; Settings never has a plan.
  await expect(page.locator("[data-plan-row]")).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "free"));
  await page.reload();
  const row = page.locator("[data-plan-row]");
  await expect(row).toHaveAttribute("data-plan-row", "free");
  await expect(row).toHaveText("Support Koona Pin");
  await row.click();
  const plans = page.getByRole("dialog", { name: "Support Koona Pin" });
  await expect(plans).toContainText("Test payments");
  // Sync, backups to a folder, the reading themes (NP-124), the badge.
  await expect(plans.getByRole("listitem")).toHaveCount(4);
  // The yearly plan is chosen first; whole prices without cents.
  await expect(plans.getByRole("radio", { name: /Yearly/ })).toHaveAttribute("aria-checked", "true");
  await expect(plans.getByRole("radio", { name: /Yearly/ })).toContainText("$20 a year");
  // Five years paid once, under the two subscriptions.
  await expect(plans.getByRole("radio", { name: /5 years/ })).toContainText("$50 once");
  await expect(plans.getByRole("radio", { name: /5 years/ })).toContainText("Save 50%");
  await plans.getByRole("radio", { name: /Monthly/ }).click();
  await expect(plans.getByRole("radio", { name: /Monthly/ })).toHaveAttribute("aria-checked", "true");
  // «Continue» opens the payment in the browser; the dialog waits and sees it paid by itself.
  await plans.getByRole("button", { name: "Continue" }).click();
  const waiting = page.getByRole("dialog", { name: "Finish in your browser" });
  await expect(waiting.getByRole("status")).toHaveText("Waiting for the payment…");
  await expect(page.getByRole("dialog", { name: "Thank you for supporting Koona Pin" })).toContainText("anna@example.com", { timeout: 15_000 });
  await page.getByRole("button", { name: "Done" }).click();
  // The row becomes the badge; it opens the plan and the perks, apart from Settings.
  await expect(row).toHaveAttribute("data-plan-row", "supporter");
  await row.click();
  const plan = page.getByRole("dialog", { name: "Supporter" });
  await expect(plan.locator("[data-plan-dialog]")).toHaveAttribute("data-plan-dialog", "active");
  await expect(plan).toContainText("anna@example.com");
  await expect(plan).toContainText("Renews on");
  // Every perk works already: sync (tests/ui/sync.spec.ts), backups to a folder, the reading themes and the badge.
  await expect(plan.getByText("Soon")).toHaveCount(0);
  await expect(plan.getByRole("listitem")).toHaveCount(4);
  await expect(plan.getByRole("button", { name: "Set up…" })).toBeVisible();
  await expect(plan.getByRole("button", { name: "Choose folder…" })).toBeVisible();
  // The badge is a perk: turned off, the row keeps a plain heart and still opens the dialog.
  const badge = plan.getByRole("switch", { name: "Supporter badge" });
  await expect(badge).toHaveAttribute("aria-checked", "true");
  await badge.click();
  await expect(badge).toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate(() => localStorage.getItem("koonapin.supporterBadge"))).toBe("off");
  await plan.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toHaveAttribute("data-plan-row", "free");
  // Another computer: «I'm already a Supporter» in the dialog, the email, then the code.
  await row.click();
  await page.getByRole("dialog", { name: "Support Koona Pin" }).getByRole("button", { name: "I'm already a Supporter" }).click();
  const signIn = page.getByRole("dialog", { name: "Sign in as a Supporter" });
  await signIn.getByLabel("Email").fill("anna@example.com");
  await signIn.getByRole("button", { name: "Send code" }).click();
  const code = page.getByRole("dialog", { name: "Check your email" });
  await expect(code).toContainText("We sent a 6-digit code to anna@example.com.");
  await code.getByLabel("Code").fill("000000");
  await code.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(code).toContainText("This code didn't work.");
  await code.getByLabel("Code").fill("482913");
  await code.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toHaveAttribute("data-plan-row", "supporter");
});

test("Supporter: the dialog of the plan says when it does not renew, a payment failed, or it could not be checked, at one height (NP-066)", async ({ page }) => {
  const heights: number[] = [];
  for (const [kind, state, text] of [
    ["supporter", "active", "Renews on"],
    ["canceling", "canceling", "Doesn't renew · Supporter until"],
    ["past_due", "past_due", "The renewal didn't go through — update the card"],
    ["offline", "unchecked", "Couldn't check the plan — it stays on until"],
    // Supporter · 5 years: nothing to manage, unless a subscription still renews too.
    ["five_years", "active", "Paid once · Supporter until"],
    ["five_years_renewing", "active", "Your subscription still renews — cancel it in Manage"],
  ] as const) {
    await page.evaluate((k) => localStorage.setItem("koonapin.demo.supporter", k), kind);
    await page.reload();
    await page.locator("[data-plan-row]").click();
    const plan = page.getByRole("dialog", { name: "Supporter" });
    await expect(plan.locator("[data-plan-dialog]")).toHaveAttribute("data-plan-dialog", state);
    await expect(plan).toContainText(text);
    if (kind.startsWith("five_years")) {
      await expect(plan).toContainText("Supporter · 5 years");
      await expect(plan.getByRole("button", { name: "Manage ↗" })).toHaveCount(kind === "five_years" ? 0 : 1);
    }
    heights.push(Math.round((await plan.boundingBox())!.height));
  }
  expect(new Set(heights).size, `heights ${heights.join(", ")}`).toBe(1);
  // «Try again» asks the server and the plan is checked again.
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "offline"));
  await page.reload();
  await page.locator("[data-plan-row]").click();
  await page.getByRole("dialog", { name: "Supporter" }).getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("[data-plan-dialog]")).toHaveAttribute("data-plan-dialog", "active");
});

test("Supporter: a subscription switches to five years from the end of its paid period (NP-066, sheet 45)", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "supporter"));
  await page.reload();
  await page.locator("[data-plan-row]").click();
  const plan = page.getByRole("dialog", { name: "Supporter" });
  await expect(plan).toContainText("Supporter · yearly");
  await plan.getByRole("button", { name: "Switch to 5 years" }).click();
  const upgrade = page.getByRole("dialog", { name: "Switch to 5 years" });
  await expect(upgrade).toContainText("Pay $50 once instead of renewing. Your yearly plan stays until");
  await expect(upgrade).toContainText("$50 once");
  await expect(upgrade).toContainText("Supporter then lasts until");
  // Nothing to choose, and no «I'm already a Supporter»: the account is signed in.
  await expect(upgrade.getByRole("radio")).toHaveCount(0);
  await expect(upgrade.getByRole("button", { name: "I'm already a Supporter" })).toHaveCount(0);
  await upgrade.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("dialog", { name: "Thank you for supporting Koona Pin" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator("[data-plan-row]").click();
  await expect(page.getByRole("dialog", { name: "Supporter" })).toContainText("Supporter · 5 years");
  // Five years and a plan that does not renew offer no switch.
  await expect(page.getByRole("dialog", { name: "Supporter" }).getByRole("button", { name: "Switch to 5 years" })).toHaveCount(0);
});

test("Supporter: a server that does not sell five years offers neither the card nor the switch (NP-066)", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem("koonapin.demo.supporter", "free");
    localStorage.setItem("koonapin.demo.fiveYears", "off");
  });
  await page.reload();
  await page.locator("[data-plan-row]").click();
  const plans = page.getByRole("dialog", { name: "Support Koona Pin" });
  await expect(plans.getByRole("radio", { name: /Yearly/ })).toContainText("$20 a year");
  await expect(plans.getByRole("radio", { name: /5 years/ })).toHaveCount(0);
  await expect(plans.getByRole("radio", { name: /Yearly/ })).toHaveAttribute("aria-checked", "true");
  await plans.getByRole("button", { name: "Not now" }).click();
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "supporter"));
  await page.reload();
  await page.locator("[data-plan-row]").click();
  const plan = page.getByRole("dialog", { name: "Supporter" });
  await expect(plan.getByRole("button", { name: "Manage ↗" })).toBeVisible();
  await expect(plan.getByRole("button", { name: "Switch to 5 years" })).toHaveCount(0);
});

test("Supporter: the dialog asks for the plan when it opens and when the window comes back — a change in the portal shows (NP-066)", async ({ page }) => {
  // The server has the plan cancelled at the end of its period, as after «Manage».
  await page.evaluate(() => {
    localStorage.setItem("koonapin.demo.supporter", "supporter");
    localStorage.setItem("koonapin.demo.serverPlan", "canceling");
  });
  await page.reload();
  const row = page.locator("[data-plan-row]");
  await row.click();
  const plan = page.getByRole("dialog", { name: "Supporter" });
  await expect(plan.locator("[data-plan-dialog]")).toHaveAttribute("data-plan-dialog", "canceling");
  await expect(plan).toContainText("Doesn't renew · Supporter until");
  // Cancelled at once, then back to the app: the dialog closes and the row is Free again.
  await page.evaluate(() => {
    localStorage.setItem("koonapin.demo.serverPlan", "none");
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toHaveAttribute("data-plan-row", "free");
  await row.click();
  await expect(page.getByRole("dialog", { name: "Support Koona Pin" })).toBeVisible();
});

test("Supporter: backups to a folder — choose, change, stop, and a folder out of reach, at one height (NP-066)", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "supporter"));
  await page.reload();
  await page.locator("[data-plan-row]").click();
  const plan = page.getByRole("dialog", { name: "Supporter" });
  const row = plan.locator("[data-backup-folder]");
  const heights: number[] = [];
  const height = async () => heights.push(Math.round((await plan.boundingBox())!.height));

  await expect(row).toHaveAttribute("data-backup-folder", "none");
  await expect(row).toContainText("Like Dropbox or Google Drive");
  await height();
  await plan.getByRole("button", { name: "Choose folder…" }).click();
  await expect(row).toHaveAttribute("data-backup-folder", "chosen");
  await expect(row).toContainText("D:\\Dropbox\\Koona Pin · last copy today,");
  await expect(row.locator("[title]")).toHaveAttribute("title", "D:\\Dropbox\\Koona Pin");
  await expect(plan.getByRole("button", { name: "Open folder" })).toBeVisible();
  await expect(plan.getByRole("button", { name: "Change…" })).toBeVisible();
  await height();
  await plan.getByRole("button", { name: "Stop copying here" }).click();
  await expect(row).toHaveAttribute("data-backup-folder", "none");

  await page.evaluate(() => localStorage.setItem("koonapin.demo.backupFolder", "unreachable"));
  await page.reload();
  await page.locator("[data-plan-row]").click();
  await expect(row).toHaveAttribute("data-backup-folder", "unreachable");
  await expect(row).toContainText("Can't reach D:\\Dropbox\\Koona Pin");
  await height();
  await plan.getByRole("button", { name: "Choose…", exact: true }).click();
  await expect(row).toHaveAttribute("data-backup-folder", "chosen");
  expect(new Set(heights).size, `heights ${heights.join(", ")}`).toBe(1);
});

test("Supporter: a payment with the email of an existing account signs in only with the code (NP-066)", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "existing"));
  await page.reload();
  const row = page.locator("[data-plan-row]");
  await row.click();
  const plans = page.getByRole("dialog", { name: "Support Koona Pin" });
  const height = Math.round((await plans.boundingBox())!.height);
  await plans.getByRole("button", { name: "Continue" }).click();
  const paid = page.getByRole("dialog", { name: "Payment received" });
  await expect(paid).toContainText("already has a Koona Pin account", { timeout: 15_000 });
  expect(Math.round((await paid.boundingBox())!.height)).toBe(height);
  await expect(row).toHaveAttribute("data-plan-row", "free");
  // Closed with «Not now», the payment is not forgotten: Support opens on it again.
  await paid.getByRole("button", { name: "Not now" }).click();
  await row.click();
  const again = page.getByRole("dialog", { name: "Payment received" });
  await expect(again).toContainText("already has a Koona Pin account");
  await again.getByRole("button", { name: "Sign in", exact: true }).click();
  const signIn = page.getByRole("dialog", { name: "Sign in as a Supporter" });
  await signIn.getByLabel("Email").fill("anna@example.com");
  await signIn.getByRole("button", { name: "Send code" }).click();
  const code = page.getByRole("dialog", { name: "Check your email" });
  await code.getByLabel("Code").fill("482913");
  await code.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(row).toHaveAttribute("data-plan-row", "supporter");
});

test("Supporter: a payment the app saw first in the background still ends in thanks (NP-066)", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "background"));
  await page.reload();
  await page.locator("[data-plan-row]").click();
  await page.getByRole("dialog", { name: "Support Koona Pin" }).getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("dialog", { name: "Thank you for supporting Koona Pin" })).toContainText("anna@example.com", { timeout: 15_000 });
  await expect(page.locator("[data-plan-row]")).toHaveAttribute("data-plan-row", "supporter");
});

test("Supporter: what the app finds by itself moves an open dialog on (NP-066)", async ({ page }) => {
  for (const [kind, title] of [
    ["later_sign_in", "Payment received"],
    ["later_paid", "Thank you for supporting Koona Pin"],
  ] as const) {
    await page.evaluate((k) => localStorage.setItem("koonapin.demo.supporter", k), kind);
    await page.reload();
    await page.locator("[data-plan-row]").click();
    await expect(page.getByRole("dialog", { name: "Support Koona Pin" })).toBeVisible();
    // No click: the background's finding arrives as a status event.
    await expect(page.getByRole("dialog", { name: title })).toBeVisible();
  }
});

test("Supporter: the server cannot be reached — the dialog says so and keeps the plan chosen (NP-066)", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "no_server"));
  await page.reload();
  await page.locator("[data-plan-row]").click();
  const plans = page.getByRole("dialog", { name: "Support Koona Pin" });
  await plans.getByRole("button", { name: "Continue" }).click();
  await expect(plans.getByRole("alert")).toHaveText("Couldn't reach the Koona Pin server. Check the connection and try again.");
  await expect(plans.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("Supporter: signed in to an account with no active plan, the dialog says so instead of closing (NP-066)", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "free"));
  await page.reload();
  const row = page.locator("[data-plan-row]");
  await row.click();
  await page.getByRole("dialog", { name: "Support Koona Pin" }).getByRole("button", { name: "I'm already a Supporter" }).click();
  const signIn = page.getByRole("dialog", { name: "Sign in as a Supporter" });
  const height = Math.round((await signIn.boundingBox())!.height);
  await signIn.getByLabel("Email").fill("free@example.com");
  await signIn.getByRole("button", { name: "Send code" }).click();
  const code = page.getByRole("dialog", { name: "Check your email" });
  await code.getByLabel("Code").fill("482913");
  await code.getByRole("button", { name: "Sign in", exact: true }).click();
  const signedIn = page.getByRole("dialog", { name: "Signed in" });
  await expect(signedIn).toContainText("You're signed in as free@example.com, but this account has no active Supporter plan.");
  expect(Math.round((await signedIn.boundingBox())!.height), "one height through the steps").toBe(height);
  await expect(row).toHaveAttribute("data-plan-row", "free");
  // «See plans» goes to buying.
  await signedIn.getByRole("button", { name: "See plans" }).click();
  await expect(page.getByRole("dialog", { name: "Support Koona Pin" })).toBeVisible();
});

test("Supporter: from «Signed in» without a plan, Sign out leaves the account (NP-066)", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "free"));
  await page.reload();
  await page.locator("[data-plan-row]").click();
  await page.getByRole("dialog", { name: "Support Koona Pin" }).getByRole("button", { name: "I'm already a Supporter" }).click();
  const signIn = page.getByRole("dialog", { name: "Sign in as a Supporter" });
  await signIn.getByLabel("Email").fill("free@example.com");
  await signIn.getByRole("button", { name: "Send code" }).click();
  const code = page.getByRole("dialog", { name: "Check your email" });
  await code.getByLabel("Code").fill("482913");
  await code.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("dialog", { name: "Signed in" }).getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(async () => (await import("/src/services/api.ts")).api.getSupporterStatus().then((s) => s.email))).toBeNull();
});

test("Supporter: signed in while the server did not answer about the plan — not «no plan», Try again (NP-066)", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "free"));
  await page.reload();
  const row = page.locator("[data-plan-row]");
  await row.click();
  await page.getByRole("dialog", { name: "Support Koona Pin" }).getByRole("button", { name: "I'm already a Supporter" }).click();
  const signIn = page.getByRole("dialog", { name: "Sign in as a Supporter" });
  await signIn.getByLabel("Email").fill("unknown@example.com");
  await signIn.getByRole("button", { name: "Send code" }).click();
  const code = page.getByRole("dialog", { name: "Check your email" });
  await code.getByLabel("Code").fill("482913");
  await code.getByRole("button", { name: "Sign in", exact: true }).click();
  const signedIn = page.getByRole("dialog", { name: "Signed in" });
  await expect(signedIn).toContainText("but your plan couldn't be checked right now.");
  await expect(signedIn.getByRole("button", { name: "See plans" })).toHaveCount(0);
  // Closed meanwhile: the plans warn before a second purchase, at the dialog's usual height.
  await signedIn.locator("footer").getByRole("button", { name: "Close" }).click();
  await row.click();
  const plans = page.getByRole("dialog", { name: "Support Koona Pin" });
  await expect(plans.getByRole("status")).toHaveText(
    "The plan of unknown@example.com couldn't be checked yet. Already a Supporter? Wait before buying again — the app tries again within the hour.",
  );
  const warned = Math.round((await plans.boundingBox())!.height);
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "free"));
  await page.reload();
  await row.click();
  expect(Math.round((await page.getByRole("dialog", { name: "Support Koona Pin" }).boundingBox())!.height), "the notice fits the usual height").toBe(warned);
  await page.getByRole("dialog", { name: "Support Koona Pin" }).getByRole("button", { name: "I'm already a Supporter" }).click();
  await page.getByRole("dialog", { name: "Sign in as a Supporter" }).getByLabel("Email").fill("unknown@example.com");
  await page.getByRole("dialog", { name: "Sign in as a Supporter" }).getByRole("button", { name: "Send code" }).click();
  await code.getByLabel("Code").fill("482913");
  await code.getByRole("button", { name: "Sign in", exact: true }).click();
  await signedIn.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toHaveAttribute("data-plan-row", "supporter");
});

test("Supporter: the plans opened while the plan is not known ask again and close when it is found (NP-066)", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "free"));
  await page.reload();
  const row = page.locator("[data-plan-row]");
  await row.click();
  await page.getByRole("dialog", { name: "Support Koona Pin" }).getByRole("button", { name: "I'm already a Supporter" }).click();
  const signIn = page.getByRole("dialog", { name: "Sign in as a Supporter" });
  await signIn.getByLabel("Email").fill("unknown@example.com");
  await signIn.getByRole("button", { name: "Send code" }).click();
  const code = page.getByRole("dialog", { name: "Check your email" });
  await code.getByLabel("Code").fill("482913");
  await code.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("dialog", { name: "Signed in" }).locator("footer").getByRole("button", { name: "Close" }).click();
  // The server has the plan now: opening the plans asks, finds it and closes, no «thank you».
  await page.evaluate(() => localStorage.setItem("koonapin.demo.serverPlan", "supporter"));
  await row.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toHaveAttribute("data-plan-row", "supporter");
});

test("Supporter: the plans show the prices Paddle gave last time at once, not dollars first (NP-066)", async ({ page }) => {
  // First time: Paddle's prices are remembered.
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "free"));
  await page.reload();
  await page.locator("[data-plan-row]").click();
  await expect(page.getByRole("dialog", { name: "Support Koona Pin" })).toContainText("$20 a year");
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem("koonapin.supporterPrices")))!).prices.year.total).toBe("$20.00");
  // Euros last time and no answer now: euros, not the dollars kept for when nothing is known.
  const remember = (daysAgo: number, fiveYears: boolean | "unknown" = true) =>
    page.evaluate(
      ([days, five]) => {
        localStorage.setItem("koonapin.demo.supporter", "no_server");
        const prices: Record<string, unknown> = { month: { price_id: "m", total: "€2.00", currency: "EUR" }, year: { price_id: "y", total: "€20.00", currency: "EUR" } };
        if (five !== "unknown") prices.five_years = five ? { price_id: "f", total: "€50.00", currency: "EUR" } : null;
        localStorage.setItem("koonapin.supporterPrices", JSON.stringify({ at: Date.now() - (days as number) * 86_400_000, prices }));
      },
      [daysAgo, fiveYears] as const,
    );
  await remember(1);
  await page.reload();
  await page.locator("[data-plan-row]").click();
  const plans = page.getByRole("dialog", { name: "Support Koona Pin" });
  await expect(plans).toContainText("€20 a year");
  await expect(plans).toContainText("€2 a month");
  await expect(plans).toContainText("€50 once");
  // Remembered more than a week ago: not shown first; with no answer, the prices nothing depends on.
  await remember(8);
  await page.reload();
  await page.locator("[data-plan-row]").click();
  await expect(plans).toContainText("$20 a year");
  // Remembered by 0.10, which knew nothing of five years: not shown first either, so the five-year
  // card never appears only after Paddle's answer.
  await remember(1, "unknown");
  await page.reload();
  await page.locator("[data-plan-row]").click();
  await expect(plans.getByRole("radio", { name: /5 years/ })).toBeVisible();
  await expect(plans).toContainText("$20 a year");
});

test("feedback: from Settings, checked before sending, a failure keeps the draft, Try again sends it (NP-088)", async ({ page }) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("Report a problem")).toHaveCount(0);
  await page.getByRole("button", { name: "Send feedback…" }).click();
  const dialog = page.getByRole("dialog", { name: "Send feedback" });
  const send = dialog.getByRole("button", { name: "Send", exact: true });
  const message = dialog.getByRole("textbox", { name: "Message" });
  await expect(dialog.getByRole("radio", { name: "Bug" })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("checkbox", { name: "Attach report" })).toBeChecked();
  await expect(send).toBeDisabled();

  // The report is shown in full before anything is sent.
  await dialog.getByRole("button", { name: "Show report" }).click();
  await expect(dialog.getByLabel("Report", { exact: true })).toContainText("Language: en");
  await expect(dialog.getByLabel("Report", { exact: true })).not.toContainText("http");
  await dialog.getByRole("button", { name: "Hide report" }).click();

  await dialog.getByRole("radio", { name: "Idea" }).click();
  await message.fill("Let me sort the inbox by site.");
  await expect(dialog).toContainText("30 / 5000");
  await dialog.getByRole("textbox", { name: "Email for a reply (optional)" }).fill("anna@example");
  await send.click();
  await expect(dialog).toContainText("This doesn't look like an email address");
  await expect(dialog.getByRole("textbox", { name: "Email for a reply (optional)" })).toBeFocused();
  await dialog.getByRole("textbox", { name: "Email for a reply (optional)" }).fill("anna@example.com");

  // No connection, then the hourly limit: the text stays, the reason is said.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const { CommandError } = await import("/src/services/errors.ts");
    const w = window as unknown as { sent: unknown[] };
    w.sent = [];
    const answers = [
      new CommandError("network", "error sending request", "no_connection"),
      new CommandError("network", "Too many messages in the last hour", "too_many_messages"),
    ];
    api.sendFeedback = async (feedback) => {
      const answer = answers.shift();
      if (answer) throw answer;
      w.sent.push(feedback);
    };
  });
  await message.press("ControlOrMeta+Enter");
  await expect(dialog.getByRole("alert")).toContainText("Couldn't send: no internet connection. Your text is kept");
  await expect(message).toHaveValue("Let me sort the inbox by site.");
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Too many messages from this network in the last hour");

  // Closing keeps the draft; the dialog opens with it.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Send feedback…" }).click();
  await expect(message).toHaveValue("Let me sort the inbox by site.");
  await expect(dialog.getByRole("radio", { name: "Idea" })).toHaveAttribute("aria-checked", "true");
  await send.click();
  await expect(dialog.getByRole("status")).toContainText("Sent. Thank you!");
  await expect(dialog.getByRole("button", { name: "Done" })).toBeFocused();
  const sent = await page.evaluate(() => (window as unknown as { sent: unknown[] }).sent);
  expect(sent).toEqual([
    {
      kind: "idea",
      message: "Let me sort the inbox by site.",
      email: "anna@example.com",
      report: expect.stringContaining("Koona Pin demo"),
      language: "en",
    },
  ]);
  await dialog.getByRole("button", { name: "Done" }).click();

  // Sent: the next message starts empty; without the box there is no report.
  await page.getByRole("button", { name: "Send feedback…" }).click();
  await expect(message).toHaveValue("");
  await message.fill("Thanks!");
  await dialog.getByRole("checkbox", { name: "Attach report" }).uncheck();
  await send.click();
  await expect(dialog.getByRole("status")).toContainText("Sent. Thank you!");
  expect(await page.evaluate(() => (window as unknown as { sent: { report: unknown }[] }).sent[1].report)).toBeNull();
});
test("dialogs open with focus on their field, not on «×»; the editor drawer too", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+n");
  const add = page.getByRole("dialog", { name: "Add link" });
  await expect(add.getByRole("textbox", { name: "Link" })).toBeFocused();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New collection", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New collection" }).getByRole("textbox", { name: "Name" })).toBeFocused();
  await page.keyboard.press("Escape");
  // The narrow window shows the editor as a drawer over the content.
  await page.setViewportSize({ width: 800, height: 550 });
  await page.locator("[data-bookmark-id]").first().focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Edit…" }).click();
  await expect(page.locator("dialog[open][data-drawer]").getByRole("textbox", { name: "Title" })).toBeFocused();
});

test("feedback: a report still being prepared is waited for; one that failed is not promised (NP-088)", async ({ page }) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const w = window as unknown as { sent: { report: unknown }[]; release: () => void };
    w.sent = [];
    api.feedbackReport = () => new Promise((resolve) => (w.release = () => resolve("Slow report")));
    api.sendFeedback = async (feedback) => void w.sent.push(feedback);
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Send feedback…" }).click();
  const dialog = page.getByRole("dialog", { name: "Send feedback" });
  await dialog.getByRole("textbox", { name: "Message" }).fill("Sent at once");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Sending…" })).toBeVisible();
  await page.evaluate(() => (window as unknown as { release: () => void }).release());
  await expect(dialog.getByRole("status")).toContainText("Sent. Thank you!");
  expect(await page.evaluate(() => (window as unknown as { sent: { report: unknown }[] }).sent[0].report)).toBe("Slow report");
  await dialog.getByRole("button", { name: "Done" }).click();

  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    api.feedbackReport = async () => {
      throw new Error("no report");
    };
  });
  await page.getByRole("button", { name: "Send feedback…" }).click();
  await expect(dialog.getByRole("checkbox", { name: "Attach report" })).not.toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "Attach report" })).toBeDisabled();
  await expect(dialog).toContainText("The report couldn't be prepared — the message goes without it.");
  await dialog.getByRole("textbox", { name: "Message" }).fill("Without a report");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Sent. Thank you!");
  expect(await page.evaluate(() => (window as unknown as { sent: { report: unknown }[] }).sent[1].report)).toBeNull();
});

test("feedback: a report that never comes does not lock the dialog — it goes without it (NP-088)", async ({ page }) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const w = window as unknown as { sent: { report: unknown }[] };
    w.sent = [];
    api.feedbackReport = () => new Promise(() => {});
    api.sendFeedback = async (feedback) => void w.sent.push(feedback);
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Send feedback…" }).click();
  const dialog = page.getByRole("dialog", { name: "Send feedback" });
  await dialog.getByRole("textbox", { name: "Message" }).fill("Report never comes");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Sent. Thank you!", { timeout: 6000 });
  expect(await page.evaluate(() => (window as unknown as { sent: { report: unknown }[] }).sent[0].report)).toBeNull();
});
test("AI assistants: off by default, read only or read and add, the dialog for each assistant (NP-091, sheet 44)", async ({ page, context, browserName }) => {
  // WebKit has no clipboard permissions to grant; it copies on the click, but only Chromium reads it back.
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const section = page.locator("section", { has: page.getByRole("heading", { name: "AI assistants" }) });
  await expect(section.locator("[data-mcp]")).toHaveAttribute("data-mcp", "off");
  await expect(section).toContainText("Claude, Cursor and other MCP apps on this computer can search your bookmarks");
  await expect(section.getByRole("radiogroup")).toHaveCount(0);
  // On: read only first, nothing asked yet.
  await section.getByRole("switch", { name: "Let AI assistants use your library" }).click();
  await expect(section.locator("[data-mcp]")).toHaveAttribute("data-mcp", "read");
  await expect(section).toContainText("On · no requests yet");
  await expect(section.getByRole("radio", { name: "Read only" })).toHaveAttribute("aria-checked", "true");
  await expect(section).toContainText("Search and read bookmarks, collections and tags; nothing changes");
  await section.getByRole("radio", { name: "Read and add" }).click();
  await expect(section.locator("[data-mcp]")).toHaveAttribute("data-mcp", "read_and_add");
  await expect(section).toContainText(/(Ctrl Z|⌘Z) undoes each change; nothing is deleted/);

  await section.getByRole("button", { name: "How to connect…" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect an AI assistant" });
  const shown = dialog.locator("[data-tab-panel][data-active]");
  await expect(dialog.locator("[data-mcp]")).toHaveText("On · read and add");
  // The package is saved where the person picks, then opened in Claude Desktop by hand (0.7.1).
  await shown.getByRole("button", { name: "Save for Claude Desktop…" }).click();
  await expect(page.getByText("koona-pin.mcpb is saved: open it in Claude Desktop")).toBeVisible();
  await expect(shown).toContainText("Settings → Extensions → Advanced settings → Install Extension…");
  await expect(shown.locator("pre")).toContainText('"mcpServers"');
  await dialog.getByRole("radio", { name: "Claude Code" }).click();
  await expect(shown.locator("pre")).toHaveText(/^claude mcp add --scope user koona-pin -- ".+koonapin-mcp\.exe"$/);
  await shown.getByRole("button", { name: "Copy" }).click();
  await expect(page.getByText("Copied", { exact: true })).toBeVisible();
  if (browserName === "chromium") expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^claude mcp add/);
  // ChatGPT: the path for its form, or the Codex command (they share the list).
  await dialog.getByRole("radio", { name: "ChatGPT" }).click();
  await expect(shown.locator("pre")).toHaveCount(2);
  await expect(shown.locator("pre").first()).toHaveText(/^.+koonapin-mcp\.exe$/);
  await expect(shown.locator("pre").last()).toHaveText(/^codex mcp add koona-pin -- ".+koonapin-mcp\.exe"$/);
  await expect(shown).toContainText("ChatGPT in the browser connects only to remote servers.");
  await dialog.getByRole("radio", { name: "Custom" }).click();
  await expect(shown).toContainText("Some apps name the top key «servers».");
  await expect(shown.locator("pre")).toContainText('"koona-pin"');
  await page.keyboard.press("Escape");
  // Off again: the modes go; on again: the mode chosen before comes back.
  await section.getByRole("switch", { name: "Let AI assistants use your library" }).click();
  await expect(section.getByRole("radiogroup")).toHaveCount(0);
  await section.getByRole("switch", { name: "Let AI assistants use your library" }).click();
  await expect(section.locator("[data-mcp]")).toHaveAttribute("data-mcp", "read_and_add");
  await expect(section.getByRole("radio", { name: "Read and add" })).toHaveAttribute("aria-checked", "true");
});
test("dialogs with tabs keep their size and place when the tab changes", async ({ page }) => {
  const box = async (dialog: ReturnType<typeof page.getByRole>) => {
    const b = await dialog.boundingBox();
    return b && { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
  };
  const steady = async (name: string, tabs: string[]) => {
    const dialog = page.getByRole("dialog", { name });
    // After the 200 ms appearance, which moves it by 5 px.
    await page.waitForTimeout(300);
    const first = await box(dialog);
    for (const tab of tabs) {
      await dialog.getByRole("radio", { name: tab }).click();
      await expect(dialog.locator("[data-tab-panel][data-active]")).toBeVisible();
      expect(await box(dialog), `${name} → ${tab}`).toEqual(first);
    }
    await page.keyboard.press("Escape");
  };
  await page.getByRole("button", { name: "No browser yet" }).click();
  await steady("Connect browser", ["Edge", "Firefox", "Chrome"]);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Let AI assistants use your library" }).click();
  await page.getByRole("button", { name: "How to connect…" }).click();
  await steady("Connect an AI assistant", ["Claude Code", "ChatGPT", "Custom", "Claude Desktop"]);
});
test("the webview's own menu and keys stay closed, a text field keeps its menu", async ({ page }) => {
  // dispatchEvent returns false when a listener cancelled the event: the webview then shows nothing.
  const shown = (selector: string, type: "contextmenu" | "keydown", init: KeyboardEventInit = {}) =>
    page.evaluate(
      ([selector, type, init]) => {
        const target = document.querySelector(selector as string)!;
        const event =
          type === "keydown"
            ? new KeyboardEvent("keydown", { ...(init as KeyboardEventInit), bubbles: true, cancelable: true })
            : new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
        return target.dispatchEvent(event);
      },
      [selector, type, init] as const,
    );
  expect(await shown("main", "contextmenu")).toBe(false);
  expect(await shown('[data-bookmark-id="1"]', "contextmenu")).toBe(false);
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await shown('input[aria-label="Search the library"]', "contextmenu")).toBe(true);
  expect(await shown("body", "keydown", { key: "F5", code: "F5" })).toBe(false);
  expect(await shown("body", "keydown", { key: "r", code: "KeyR", ctrlKey: true })).toBe(false);
  expect(await shown("body", "keydown", { key: "p", code: "KeyP", ctrlKey: true })).toBe(false);
  expect(await shown('input[aria-label="Search the library"]', "keydown", { key: "c", code: "KeyC", ctrlKey: true })).toBe(true);
});
