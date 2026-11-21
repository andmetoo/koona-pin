import { test, expect, type Page } from "@playwright/test";
import { openApp, opened, settingsGroup, stubBrowser } from "../fixtures/app";

// The Feeds page (NP-132) on the preview's five sample feeds (NP-128): the sidebar section, the
// list column, the article sheet and its keys. `koonapin.demo.feeds` switches the preview to no
// feeds (`empty`), no connection (`offline`) or Ars Technica not updating (`failing`).
/** The app in the Feeds mode (2.24.0), or in Bookmarks with `{ feeds: false }`. */
const open = async (page: Page, settings: Record<string, string> = {}, { feeds = true } = {}) => {
  await openApp(page, { clear: true, settings });
  if (feeds) await page.getByRole("tab", { name: "Feeds" }).click();
};
const section = (page: Page) => page.getByRole("navigation", { name: "Feeds" });
/** A row of the sidebar: «All feeds» (the mode's «All»), or the feed's own button (not its «…»). */
const row = (page: Page, name: string) =>
  name === "All feeds"
    ? page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: /^All/ })
    : section(page).locator("[data-feed-row]").filter({ has: page.getByText(name, { exact: true }) }).locator("button").first();
/** A feed's row menu, from its «…»: the sidebar has no right-click menus (share-bundle.md, M6). */
async function rowMenu(page: Page, name: string) {
  await row(page, name).hover();
  await page.getByRole("button", { name: `${name}: more` }).click();
}
const posts = (page: Page) => page.locator("[data-feed-item]");
const sheet = (page: Page) => page.locator("[data-feed-article]");
const openFeeds = async (page: Page) => {
  await row(page, "All feeds").click();
  await expect(posts(page).first()).toBeVisible();
};

test("the Feeds mode lists the feeds with their counts, folds and stays folded, and is remembered", async ({ page }) => {
  await open(page, {}, { feeds: false });
  // Bookmarks: no feeds in the sidebar, a dot on the Feeds tab for what is new.
  await expect(section(page)).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Feeds" }).locator("[data-mode-new]")).toBeVisible();
  await page.getByRole("tab", { name: "Feeds" }).click();
  await expect(page.getByRole("tab", { name: "Feeds" })).toHaveAttribute("aria-selected", "true");
  await expect(section(page).locator("[data-feed-row]")).toHaveCount(5);
  await expect(row(page, "All feeds")).toContainText("11");
  await expect(row(page, "Serious Eats")).toContainText("3");
  // Collections belong to Bookmarks.
  await expect(page.getByRole("button", { name: /^Collections/ })).toHaveCount(0);
  await page.getByRole("button", { name: /^Feeds/ }).click();
  await expect(page.getByRole("button", { name: /^Feeds/ })).toHaveAttribute("aria-expanded", "false");
  // Folded, the header says how many are new.
  await expect(page.getByRole("button", { name: /^Feeds/ })).toContainText("11");
  await page.reload();
  await expect(page.getByRole("button", { name: /^Feeds/ })).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: /^Feeds/ }).click();
  await expect(row(page, "All feeds")).toBeVisible();
});

test("J and K move through the posts; a post opened is read after a second, U takes it back", async ({ page }) => {
  await open(page);
  await openFeeds(page);
  await expect(page.getByRole("heading", { level: 1, name: "All feeds" })).toBeVisible();
  await expect(page.locator("[data-feed-status]")).toContainText("11 new · updated");
  await page.keyboard.press("j");
  const first = posts(page).first();
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(sheet(page).getByRole("heading", { level: 1 })).toHaveText("The quiet return of the dedicated music player");
  await expect(first).toHaveAttribute("data-read", "true", { timeout: 3000 });
  await expect(row(page, "All feeds")).toContainText("10");
  await page.keyboard.press("j");
  await expect(posts(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("k");
  await expect(first).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("u");
  await expect(first).not.toHaveAttribute("data-read", "true");
  await expect(row(page, "All feeds")).toContainText("11");
  // The open post is remembered.
  await page.reload();
  await openFeeds(page);
  await expect(posts(page).first()).toHaveAttribute("aria-selected", "true");
});

test("S, R, F, O and Save Undo work from the keys and the toolbar", async ({ page }) => {
  await open(page);
  await stubBrowser(page);
  await openFeeds(page);
  // Save + Undo takes the post back out of Bookmarks.
  await posts(page).first().click();
  await sheet(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(posts(page).first().locator("[data-feed-saved]")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(posts(page).first().locator("[data-feed-saved]")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: /^Saved from feeds/ })).toContainText("0");

  await posts(page).nth(2).click();
  await expect(sheet(page).getByRole("heading", { level: 1 })).toHaveText("Weeknight braised beans that taste like they took all day");
  // Beside the list there is nothing to go back to: no ← (2.1.3).
  await expect(sheet(page).getByRole("button", { name: "Back to the list" })).toHaveCount(0);
  await page.keyboard.press("s");
  await expect(page.getByText("Saved to Bookmarks")).toBeVisible();
  await expect(sheet(page).getByRole("button", { name: "Saved", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(posts(page).nth(2).locator("[data-feed-saved]")).toBeVisible();
  // In Feeds, «Saved from feeds» counts it.
  await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: /^Saved from feeds/ })).toContainText("1");
  // R puts the saved post into Reading; again takes it out.
  await page.keyboard.press("r");
  await expect(sheet(page).getByRole("button", { name: "Send to Reading" })).toHaveAttribute("aria-pressed", "true");
  // Reading is a Bookmarks section: counted from the library while Feeds is shown.
  await expect
    .poll(() => page.evaluate(async () => (await (await import("/src/services/api.ts")).api.getCounts()).reading_unread))
    .toBe(4);
  await sheet(page).getByRole("button", { name: "Send to Reading" }).click();
  await expect(sheet(page).getByRole("button", { name: "Send to Reading" })).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("f");
  await expect(sheet(page).getByRole("button", { name: "Favorite" })).toHaveAttribute("aria-pressed", "true");
  // F on another post saves it as a favourite at once.
  await posts(page).nth(3).click();
  await sheet(page).getByRole("button", { name: "Favorite" }).click();
  await expect(sheet(page).getByRole("button", { name: "Favorite" })).toHaveAttribute("aria-pressed", "true");
  await expect(posts(page).nth(3).locator("[data-feed-saved]")).toBeVisible();
  await page.keyboard.press("o");
  await sheet(page).getByRole("button", { name: "Open in browser" }).click();
  expect(await opened(page)).toEqual([expect.stringContaining("kottke.org/demo/"), expect.stringContaining("kottke.org/demo/")]);
});

test("⇧A marks all read; a feed's menu marks its own", async ({ page }) => {
  await open(page);
  await row(page, "The Verge").click();
  await expect(page.getByRole("heading", { level: 1, name: "The Verge" })).toBeVisible();
  await expect(posts(page)).toHaveCount(4);
  await rowMenu(page, "Ars Technica");
  await page.getByRole("menuitem", { name: "Mark all read" }).click();
  await expect(row(page, "Ars Technica")).toContainText("0");
  await expect(row(page, "All feeds")).toContainText("9");
  await row(page, "All feeds").click();
  await page.keyboard.press("Shift+A");
  await expect(page.getByText("Marked as read: 9")).toBeVisible();
  await expect(row(page, "All feeds")).toContainText("0");
  await expect(page.locator("[data-feed-status]")).toContainText("0 new");
});

test("unfollowing is confirmed and takes the feed and its posts away", async ({ page }) => {
  await open(page);
  await row(page, "kottke.org").click();
  await row(page, "kottke.org").hover();
  await page.getByRole("button", { name: "kottke.org: more" }).click();
  await page.getByRole("menuitem", { name: "Unfollow…" }).click();
  const dialog = page.getByRole("dialog", { name: "Unfollow kottke.org?" });
  await dialog.getByRole("button", { name: "Keep" }).click();
  await expect(section(page).locator("[data-feed-row]")).toHaveCount(5);
  await rowMenu(page, "kottke.org");
  await page.getByRole("menuitem", { name: "Unfollow…" }).click();
  await dialog.getByRole("button", { name: "Unfollow" }).click();
  await expect(section(page).locator("[data-feed-row]")).toHaveCount(4);
  await expect(page.getByRole("heading", { level: 1, name: "All feeds" })).toBeVisible();
  await expect(posts(page).filter({ hasText: "kottke.org" })).toHaveCount(0);
});

test("rename and where new posts go, from the row menu", async ({ page }) => {
  await open(page);
  await rowMenu(page, "Serious Eats");
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Eats");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(row(page, "Eats")).toBeVisible();
  await rowMenu(page, "Eats");
  await page.getByRole("menuitem", { name: "Where new posts go" }).click();
  await expect(page.getByRole("menuitemradio", { name: "Also notify me" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Feeds only" }).click();
  await expect(page.getByText("Eats: Feeds only")).toBeVisible();
});

test("offline, failing and no feeds", async ({ page }) => {
  await open(page, { "demo.feeds": "offline" });
  await openFeeds(page);
  await expect(page.locator("[data-feed-status]")).toHaveText(/^Offline · updated/);

  await open(page, { "demo.feeds": "failing" });
  await expect(row(page, "Ars Technica").locator("[data-feed-problem]")).toBeVisible();
  await expect(row(page, "Ars Technica")).toHaveAttribute("title", /^Not updating since /);
  await row(page, "Ars Technica").click();
  await expect(page.locator("[data-feed-status]")).toHaveText(/^Not updating since /);

  await open(page, { "demo.feeds": "empty" });
  await expect(section(page).getByRole("button", { name: "Follow a site…" })).toBeVisible();
  await section(page).getByRole("button", { name: "Follow a site…" }).click();
  await expect(page.locator("dialog[open]")).toBeVisible();
});

test("the strip of a narrow window has one button to Feeds, with a dot for new posts, and back", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await open(page, {}, { feeds: false });
  // In the strip, one button goes to the other mode, with a dot for new posts.
  const button = page.getByRole("button", { name: "Feeds", exact: true });
  await expect(button.locator("[data-mode-new]")).toBeVisible();
  await button.click();
  await expect(posts(page).first()).toBeVisible();
  // One column: the post replaces the list, ← brings it back.
  await posts(page).first().click();
  await expect(page.locator("[data-feed-list]")).toHaveCount(0);
  await sheet(page).getByRole("button", { name: "Back to the list" }).click();
  await expect(page.locator("[data-feed-list]")).toBeVisible();
  await page.getByRole("button", { name: "Bookmarks", exact: true }).click();
  await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
});

test("the mode tabs hold still: neither the chosen label nor the dot moves them; ← → Home End move as tabs do (2.25.0)", async ({ page }) => {
  await open(page, {}, { feeds: false });
  const bookmarks = page.getByRole("tab", { name: "Bookmarks" });
  const feeds = page.getByRole("tab", { name: "Feeds" });
  /** Each tab's box and the centre of its visible words (not the hidden semibold copy). */
  const places = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')].map((tab) => {
        const range = document.createRange();
        range.selectNodeContents(tab.querySelector("span > span:not([aria-hidden]):not([data-mode-new])")!);
        const box = tab.getBoundingClientRect();
        const words = range.getBoundingClientRect();
        return { left: box.left, width: box.width, centre: words.left + words.width / 2 };
      }),
    );
  await expect(feeds.locator("[data-mode-new]")).toBeVisible();
  const before = await places();
  // One tab in the Tab order; → chooses Feeds and takes the focus with it, and the dot goes.
  await expect(bookmarks).toHaveAttribute("tabindex", "0");
  await expect(feeds).toHaveAttribute("tabindex", "-1");
  await bookmarks.focus();
  await page.keyboard.press("ArrowRight");
  await expect(feeds).toHaveAttribute("aria-selected", "true");
  await expect(feeds).toBeFocused();
  await expect(feeds.locator("[data-mode-new]")).toHaveCount(0);
  const after = await places();
  for (const [i, place] of before.entries()) {
    expect(Math.abs(after[i].left - place.left)).toBeLessThan(0.1);
    expect(Math.abs(after[i].width - place.width)).toBeLessThan(0.1);
    expect(Math.abs(after[i].centre - place.centre)).toBeLessThan(0.5);
  }
  await page.keyboard.press("Home");
  await expect(bookmarks).toHaveAttribute("aria-selected", "true");
  await expect(bookmarks).toBeFocused();
  await page.keyboard.press("End");
  await expect(feeds).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(bookmarks).toHaveAttribute("aria-selected", "true");
  // Chords keep their own meaning: no mode change.
  await page.keyboard.press("Alt+ArrowRight");
  await page.keyboard.press("ControlOrMeta+ArrowRight");
  await expect(bookmarks).toHaveAttribute("aria-selected", "true");
  // The tabs control the mode's sections.
  const panel = page.getByRole("tabpanel");
  await expect(panel).toHaveAttribute("id", (await bookmarks.getAttribute("aria-controls"))!);
  await expect(panel.getByRole("navigation", { name: "Sections" })).toBeVisible();
  // Home on the chosen tab chooses nothing: Settings stays open.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator("section[data-settings-group]").first()).toBeVisible();
  await bookmarks.focus();
  await page.keyboard.press("Home");
  await expect(bookmarks).toBeFocused();
  await expect(page.locator("section[data-settings-group]").first()).toBeVisible();
});

test("the card spreads over the list with E; at the end of a post Next story and Previous story move on and back", async ({ page }) => {
  await open(page);
  await openFeeds(page);
  await posts(page).nth(1).click();
  const slot = page.locator("[data-feed-slot]");
  await expect(slot).toHaveCSS("width", "380px");
  await sheet(page).getByRole("button", { name: "Expand" }).click();
  await expect(slot).toHaveCSS("width", "0px");
  await expect(sheet(page).getByRole("button", { name: "Show the list" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("e");
  await expect(slot).toHaveCSS("width", "380px");

  // The end: the next post's card peeks below; Next story makes it the open one.
  const title = (await posts(page).nth(2).locator("h3").textContent()) ?? "";
  const end = sheet(page).locator("[data-feed-next]");
  await end.scrollIntoViewIfNeeded();
  await expect(sheet(page).locator("[data-feed-peek]")).toContainText(title.trim().slice(0, 20));
  await end.getByRole("button", { name: "Next story" }).click();
  await expect(sheet(page).last().getByRole("heading", { level: 1 })).toContainText(title.trim().slice(0, 20));
  await expect(posts(page).nth(2)).toHaveAttribute("aria-selected", "true");
  await sheet(page).last().locator("[data-feed-next]").scrollIntoViewIfNeeded();
  await sheet(page).last().locator("[data-feed-next]").getByRole("button", { name: "Previous story" }).click();
  await expect(posts(page).nth(1)).toHaveAttribute("aria-selected", "true");
  // The first post has nothing before it.
  await posts(page).first().click();
  await expect(sheet(page).last().locator("[data-feed-previous]")).toHaveCount(0);

  // Toolbar ⌃ and ⌄ move like K and J and dim at the ends of a feed's list (2.17.0).
  await row(page, "The Verge").click();
  await expect(posts(page)).toHaveCount(4);
  await posts(page).first().click();
  const previous = () => sheet(page).last().getByRole("button", { name: "Previous story", exact: true });
  const next = () => sheet(page).last().getByRole("button", { name: "Next story", exact: true });
  await expect(previous()).toBeDisabled();
  await expect(next()).toHaveAttribute("aria-keyshortcuts", "J");
  await next().click();
  await expect(posts(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(previous()).toBeEnabled();
  await previous().click();
  await expect(posts(page).first()).toHaveAttribute("aria-selected", "true");
  await posts(page).nth(3).click();
  await expect(next()).toBeDisabled();
});

test("Unread | All: Unread keeps the open post until another opens, and is remembered (2.17.0)", async ({ page }) => {
  await open(page);
  await row(page, "The Verge").click();
  await expect(posts(page)).toHaveCount(4);
  const show = page.getByRole("group", { name: "Show posts" });
  await expect(show.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  await show.getByRole("button", { name: "Unread" }).click();
  const unread = await posts(page).count();
  expect(unread).toBeLessThan(4);
  expect(await page.locator("[data-feed-item][data-read]").count()).toBe(0);
  await posts(page).first().click();
  // Read after a second, and still in the list while it is open.
  await expect(posts(page).first()).toHaveAttribute("data-read", "true", { timeout: 3000 });
  await expect(posts(page)).toHaveCount(unread);
  // Kept by the query itself, so a save shows on it like on any other row.
  await page.keyboard.press("s");
  await expect(posts(page).first().locator("[data-feed-saved]")).toBeVisible();
  await expect(sheet(page).getByRole("button", { name: "Saved", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("j");
  await expect(posts(page).nth(1)).toHaveAttribute("aria-selected", "true");
  // Once the next one is read, the one left goes.
  await expect(posts(page)).toHaveCount(unread - 1, { timeout: 3000 });
  await page.reload();
  await row(page, "The Verge").click();
  await expect(page.getByRole("group", { name: "Show posts" }).getByRole("button", { name: "Unread" })).toHaveAttribute("aria-pressed", "true");
});

test("Mark all read in the list header; Unread then says everything is read and offers all posts (2.17.0)", async ({ page }) => {
  await open(page);
  await openFeeds(page);
  const markAll = page.locator("[data-feed-list]").getByRole("button", { name: "Mark all read" });
  // A search narrows the list, not what is marked: the button waits until it is cleared.
  await page.locator("[data-feed-list]").getByRole("button", { name: "Search posts" }).click();
  await page.keyboard.type("potatoes");
  await expect(markAll).toBeDisabled();
  // ⇧A from outside the field waits too.
  await page.locator("[data-feed-list] h1").click();
  await page.keyboard.press("Shift+A");
  await expect(page.getByText(/^Marked as read/)).toHaveCount(0);
  await expect(row(page, "All feeds")).toContainText("11");
  await page.locator("[data-feed-list]").getByRole("button", { name: "Search posts" }).click();
  await expect(markAll).toBeEnabled();
  await page.getByRole("group", { name: "Show posts" }).getByRole("button", { name: "Unread" }).click();
  await markAll.click();
  await expect(page.getByText("Marked as read: 11")).toBeVisible();
  await expect(row(page, "All feeds")).toContainText("0");
  await expect(page.locator("[data-feed-status]")).toContainText("0 new");
  await expect(markAll).toBeDisabled();
  const empty = page.locator("[data-feed-all-read]");
  await expect(empty).toContainText("Everything is read");
  await empty.getByRole("button", { name: "Show all posts" }).click();
  await expect(page.getByRole("group", { name: "Show posts" }).getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  await expect(posts(page).first()).toBeVisible();
});

test("Settings → Feeds: how often to check, OPML import and export", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settingsGroup(page, "feeds");
  await page.getByRole("radio", { name: "3 hr" }).click();
  await expect(page.getByRole("radio", { name: "3 hr" })).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => localStorage.getItem("koonapin.demo.feedsRefreshMinutes"))).toBe("180");
  // Import… opens the import dialog for feeds.
  await page.getByRole("button", { name: "Import…" }).click();
  const dialog = page.locator("dialog[open]");
  await dialog.locator("input[type=file]").setInputFiles({
    name: "feeds.opml",
    mimeType: "text/x-opml",
    buffer: Buffer.from('<opml version="2.0"><body><outline text="Notes" xmlUrl="https://notes.example.org/atom.xml"/></body></opml>'),
  });
  await page.getByRole("dialog", { name: "Import feeds" }).getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Import finished" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(section(page).locator("[data-feed-row]")).toHaveCount(7);
  // Export… is the desktop's Save dialog: the preview answers without one.
  await page.getByRole("button", { name: "Export…" }).click();
  await expect(page.getByText(/^Feeds exported: \d+ · /)).toBeVisible();
});

test("a post's own scripts, frames and handlers never reach the sheet", async ({ page }) => {
  await open(page);
  await openFeeds(page);
  await page.evaluate(async () => {
    // Any change keeps the preview's feeds in localStorage, where the post is then rewritten.
    const { api } = await import("/src/services/api.ts");
    await api.setFeedItemsRead([20], true);
    const state = JSON.parse(localStorage.getItem("koonapin.demo.feeds.v1")!);
    state.items[0].html =
      '<p>Safe text</p><script>window.owned = 1</script><img src="x" onerror="window.owned = 2"><iframe src="https://evil.example/"></iframe>' +
      '<a href="javascript:window.owned = 3">link</a><form><input></form><svg onload="window.owned = 4"></svg>';
    localStorage.setItem("koonapin.demo.feeds.v1", JSON.stringify(state));
  });
  await page.reload();
  await openFeeds(page);
  await posts(page).first().click();
  const body = sheet(page).locator(".reader-body");
  await expect(body).toContainText("Safe text");
  await expect(body.locator("script, iframe, form, input, svg, [onerror], [onload]")).toHaveCount(0);
  await expect(body.locator("a")).not.toHaveAttribute("href", /javascript/);
  await body.getByText("link").click();
  expect(await page.evaluate(() => (window as unknown as { owned?: number }).owned)).toBeUndefined();
});

test("a post is never read from its site until “Load the full article” (NP-120)", async ({ page }) => {
  await open(page);
  await openFeeds(page);
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const w = window as unknown as { fetched: string[] };
    w.fetched = [];
    const original = api.fetchReaderPage;
    api.fetchReaderPage = async (url: string) => (w.fetched.push(url), original(url));
    // The cached post takes a moment, as a large one does from the database.
    const article = api.getFeedArticle;
    api.getFeedArticle = async (id: number) => (await new Promise((resolve) => setTimeout(resolve, 150)), article(id));
  });
  const fetched = () => page.evaluate(() => (window as unknown as { fetched: string[] }).fetched);
  const loadFull = sheet(page).getByRole("button", { name: "Load the full article" });
  const count = await posts(page).count();
  for (let i = 0; i < count; i++) {
    await posts(page).nth(i).click();
    await expect(sheet(page).locator(".reader-body")).toBeVisible();
    if (await loadFull.isVisible()) break;
  }
  await expect(loadFull).toBeVisible();
  expect(await fetched()).toEqual([]);
  await loadFull.click();
  await expect.poll(fetched).toHaveLength(1);
});

test("R and F act on the open post's bookmark, not on the one of the post before", async ({ page }) => {
  await open(page);
  await openFeeds(page);
  // Favorites is a Bookmarks section: counted from the library, not from the Feeds sidebar.
  const favoriteCount = () =>
    page.evaluate(async () => {
      const { api } = await import("/src/services/api.ts");
      return (await api.getCounts()).favorites;
    });
  const base = await favoriteCount();
  const favorites = (more: number) => ({ toBeVisible: () => expect.poll(favoriteCount).toBe(base + more) });
  await posts(page).nth(0).click();
  await page.keyboard.press("f");
  await favorites(1).toBeVisible();
  await posts(page).nth(1).click();
  await page.keyboard.press("s");
  await expect(posts(page).nth(1).locator("[data-feed-saved]")).toBeVisible();
  // From now on the bookmark lookup of an opened post waits on a manual gate.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const w = window as unknown as { releaseLookups: (() => void)[] };
    w.releaseLookups = [];
    const original = api.getBookmarks;
    api.getBookmarks = async (filters, request = {}) => {
      if (request.id !== undefined) await new Promise<void>((resolve) => w.releaseLookups.push(resolve));
      return original(filters, request);
    };
  });
  const releaseAll = () =>
    page.evaluate(() => {
      const w = window as unknown as { releaseLookups: (() => void)[] };
      while (w.releaseLookups.length) w.releaseLookups.shift()!();
    });
  await posts(page).nth(0).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { releaseLookups: unknown[] }).releaseLookups.length)).toBeGreaterThan(0);
  await releaseAll();
  await expect(sheet(page).getByRole("button", { name: "Favorite" })).toHaveAttribute("aria-pressed", "true");
  await posts(page).nth(1).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { releaseLookups: unknown[] }).releaseLookups.length)).toBeGreaterThan(0);
  // Before it arrives, F favourites this post; the first one stays a favourite.
  await page.keyboard.press("f");
  await releaseAll();
  await favorites(2).toBeVisible();
});

test("F finishing on a post left behind does not lose the bookmark of the post open now", async ({ page }) => {
  await open(page);
  await openFeeds(page);
  const favorite = sheet(page).getByRole("button", { name: "Favorite" });
  await posts(page).nth(0).click();
  await page.keyboard.press("f");
  await expect(favorite).toHaveAttribute("aria-pressed", "true");
  await posts(page).nth(1).click();
  await page.keyboard.press("f");
  await expect(favorite).toHaveAttribute("aria-pressed", "true");
  // Hold bookmark lookups and bulk updates behind manual gates so we deterministically interleave them.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const w = window as unknown as { releaseLookups: (() => void)[]; releaseBulk: (() => void)[] };
    w.releaseLookups = [];
    w.releaseBulk = [];
    const getBookmarks = api.getBookmarks;
    api.getBookmarks = async (filters, request = {}) => {
      if (request.id !== undefined) await new Promise<void>((resolve) => w.releaseLookups.push(resolve));
      return getBookmarks(filters, request);
    };
    const bulkUpdate = api.bulkUpdate;
    api.bulkUpdate = async (...args) => {
      await new Promise<void>((resolve) => w.releaseBulk.push(resolve));
      return bulkUpdate(...args);
    };
  });
  await posts(page).nth(0).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { releaseLookups: unknown[] }).releaseLookups.length)).toBeGreaterThan(0);
  await page.evaluate(() => (window as unknown as { releaseLookups: (() => void)[] }).releaseLookups.shift()!());
  await expect(favorite).toHaveAttribute("aria-pressed", "true");
  // F takes the first post out of Favorites; the second opens while that is still on its way.
  await page.keyboard.press("f");
  await expect.poll(() => page.evaluate(() => (window as unknown as { releaseBulk: unknown[] }).releaseBulk.length)).toBeGreaterThan(0);
  await posts(page).nth(1).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { releaseLookups: unknown[] }).releaseLookups.length)).toBeGreaterThan(0);
  // Bulk update finishes first, then the second post's lookup finishes.
  await page.evaluate(() => {
    const w = window as unknown as { releaseLookups: (() => void)[]; releaseBulk: (() => void)[] };
    while (w.releaseBulk.length) w.releaseBulk.shift()!();
  });
  await page.evaluate(() => {
    const w = window as unknown as { releaseLookups: (() => void)[] };
    while (w.releaseLookups.length) w.releaseLookups.shift()!();
  });
  await expect(favorite).toHaveAttribute("aria-pressed", "true");
});

// The page against the Lunacy frame «RSS · Three columns · Light», light and dark, at 1200 and 1600.
for (const width of [1200, 1600]) {
  for (const theme of ["light", "dark"]) {
    test(`feeds ${theme} ${width}`, { tag: "@visual" }, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.clock.install({ time: new Date(2026, 9, 16, 12, 0) });
      await page.addInitScript((theme) => {
        if (sessionStorage.getItem("feeds-visual")) return;
        sessionStorage.setItem("feeds-visual", "1");
        localStorage.clear();
        localStorage.setItem("koonapin.theme", theme);
        localStorage.setItem("koonapin.feeds.last", JSON.stringify({ feed: null, item: 2 }));
        localStorage.setItem("koonapin.mode", "feeds");
      }, theme);
      await page.goto("/");
      await openFeeds(page);
      await expect(sheet(page).getByRole("heading", { level: 1 })).toHaveText(/battery report/);
      // Opened a second ago: read, so nothing changes under the screenshot.
      await expect(page.locator('[data-feed-item="2"]')).toHaveAttribute("data-read", "true", { timeout: 3000 });
      await page.evaluate(() => document.fonts.ready);
      await page.mouse.move(0, 0);
      await expect(page).toHaveScreenshot(`feeds-${theme}-${width}.png`, { animations: "disabled", maxDiffPixelRatio: 0.002 });
    });
  }
}

test("the mode switch: Ctrl 1 and Ctrl 2, each mode back where it was, the last one remembered, Ctrl N follows the mode", async ({ page }) => {
  await open(page, {}, { feeds: false });
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  // Bookmarks on a collection, then Feeds on a feed.
  await page.getByRole("treeitem", { name: /^Design/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^Design/ })).toBeVisible();
  await page.keyboard.press(`${mod}+2`);
  await expect(page.getByRole("tab", { name: "Feeds" })).toHaveAttribute("aria-selected", "true");
  await row(page, "Serious Eats").click();
  await expect(page.getByRole("heading", { level: 1, name: "Serious Eats" })).toBeVisible();
  // Each mode comes back where it was left.
  await page.keyboard.press(`${mod}+1`);
  await expect(page.getByRole("heading", { level: 1, name: /^Design/ })).toBeVisible();
  await page.keyboard.press(`${mod}+2`);
  await expect(page.getByRole("heading", { level: 1, name: "Serious Eats" })).toBeVisible();
  // Ctrl N in Feeds is «Follow a site».
  await page.keyboard.press(`${mod}+n`);
  await expect(page.getByRole("dialog", { name: "Follow a site" })).toBeVisible();
  await page.keyboard.press("Escape");
  // The app opens in the last mode.
  await page.reload();
  await expect(page.getByRole("tab", { name: "Feeds" })).toHaveAttribute("aria-selected", "true");
  await expect(section(page).locator("[data-feed-row]")).toHaveCount(5);
  await page.keyboard.press(`${mod}+1`);
  await page.keyboard.press(`${mod}+n`);
  await expect(page.getByRole("dialog", { name: "Add link" })).toBeVisible();
});

test("Today lists the posts of the day; Saved from feeds lists the saved posts, and «Show it» opens one in Bookmarks", async ({ page }) => {
  await open(page);
  const sections = page.getByRole("navigation", { name: "Sections" });
  await sections.getByRole("button", { name: "Today" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  const today = await posts(page).count();
  expect(today).toBeGreaterThan(0);
  expect(today).toBeLessThan(11);
  // Nothing saved yet: the section says how to save one.
  await sections.getByRole("button", { name: /^Saved from feeds/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^Saved from feeds/ })).toBeVisible();
  await expect(page.getByText("Nothing saved from feeds yet")).toBeVisible();
  await page.getByRole("button", { name: "Open the feeds" }).click();
  await posts(page).first().click();
  await page.keyboard.press("s");
  await expect(sections.getByRole("button", { name: /^Saved from feeds/ })).toContainText("1");
  await sections.getByRole("button", { name: /^Saved from feeds/ }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  // Saved again from a post: «Show it» takes it to Bookmarks, in the editor.
  await row(page, "All feeds").click();
  await posts(page).nth(1).click();
  await page.keyboard.press("s");
  await page.getByRole("button", { name: "Show it", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Bookmarks" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue(/battery report/);
});

test("the mode's own tab keeps an open editor; Ctrl 2 in a field types; the Bookmarks tab leaves Settings; Today counts its own posts", async ({ page }) => {
  await open(page, {}, { feeds: false });
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  // The editor open in Bookmarks: its tab and Ctrl 1 change nothing.
  await page.locator("[data-bookmark-id]").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Edit/ }).click();
  const title = page.getByRole("textbox", { name: "Title" });
  await expect(title).toBeVisible();
  await page.getByRole("tab", { name: "Bookmarks" }).click();
  await expect(title).toBeVisible();
  // In a field, Ctrl 2 is the field's.
  await title.focus();
  await page.keyboard.press(`${mod}+2`);
  await expect(page.getByRole("tab", { name: "Bookmarks" })).toHaveAttribute("aria-selected", "true");
  await expect(title).toBeVisible();
  await page.keyboard.press("Escape");
  // From Settings, the Bookmarks tab goes back to the library.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Bookmarks" }).click();
  await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
  // Today's header counts what is new among its own posts.
  await page.getByRole("tab", { name: "Feeds" }).click();
  await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Today" }).click();
  await expect(posts(page).first()).toBeVisible();
  // All feeds have 11 new; Today shows fewer posts, and its count is within them.
  const shown = await posts(page).count();
  await expect(page.locator("[data-feed-status]")).toContainText(/^\d+ new/);
  const counted = Number((await page.locator("[data-feed-status]").textContent())!.match(/^(\d+)/)![1]);
  expect(counted).toBeLessThanOrEqual(shown);
  expect(counted).toBeLessThan(11);
});
