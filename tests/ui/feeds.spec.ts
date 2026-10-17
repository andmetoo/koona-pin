import { test, expect, type Page } from "@playwright/test";
import { openApp, opened, stubBrowser } from "../fixtures/app";

// The Feeds page (NP-132) on the preview's five sample feeds (NP-128): the sidebar section, the
// list column, the article sheet and its keys. `koonapin.demo.feeds` switches the preview to no
// feeds (`empty`), no connection (`offline`) or Ars Technica not updating (`failing`).
const open = (page: Page, settings: Record<string, string> = {}) => openApp(page, { clear: true, settings });
const section = (page: Page) => page.getByRole("navigation", { name: "Feeds" });
/** A row of the section: «All feeds», or the feed's own button (not its «…»). */
const row = (page: Page, name: string) =>
  name === "All feeds"
    ? section(page).getByRole("button", { name: /^All feeds/ })
    : section(page).locator("[data-feed-row]").filter({ has: page.getByText(name, { exact: true }) }).locator("button").first();
const posts = (page: Page) => page.locator("[data-feed-item]");
const sheet = (page: Page) => page.locator("[data-feed-article]");
const openFeeds = async (page: Page) => {
  await row(page, "All feeds").click();
  await expect(posts(page).first()).toBeVisible();
};

test("the section lists the feeds with their counts, folds and stays folded", async ({ page }) => {
  await open(page);
  await expect(section(page).locator("[data-feed-row]")).toHaveCount(5);
  await expect(row(page, "All feeds")).toContainText("11");
  await expect(row(page, "Serious Eats")).toContainText("3");
  // Above Collections.
  const feedsTop = (await section(page).boundingBox())!.y;
  const collectionsTop = (await page.getByRole("button", { name: /^Collections/ }).boundingBox())!.y;
  expect(feedsTop).toBeLessThan(collectionsTop);
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

test("S, R, F and O work from the keys and the toolbar", async ({ page }) => {
  await open(page);
  await stubBrowser(page);
  await openFeeds(page);
  await posts(page).nth(2).click();
  await expect(sheet(page).getByRole("heading", { level: 1 })).toHaveText("Weeknight braised beans that taste like they took all day");
  // Beside the list there is nothing to go back to: no ← (2.1.3).
  await expect(sheet(page).getByRole("button", { name: "Back to the list" })).toHaveCount(0);
  await page.keyboard.press("s");
  await expect(page.getByText("Saved to Library")).toBeVisible();
  await expect(sheet(page).getByRole("button", { name: "Saved", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(posts(page).nth(2).locator("[data-feed-saved]")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: /All bookmarks/ })).toContainText("7");
  // R puts the saved post into Reading; again takes it out.
  await page.keyboard.press("r");
  await expect(sheet(page).getByRole("button", { name: "Read later" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: /Reading/ })).toContainText("4");
  await sheet(page).getByRole("button", { name: "Read later" }).click();
  await expect(sheet(page).getByRole("button", { name: "Read later" })).toHaveAttribute("aria-pressed", "false");
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

test("a post saved by S goes again with Undo", async ({ page }) => {
  await open(page);
  await openFeeds(page);
  await posts(page).first().click();
  await sheet(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(posts(page).first().locator("[data-feed-saved]")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(posts(page).first().locator("[data-feed-saved]")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: /All bookmarks/ })).toContainText("6");
});

test("⇧A marks all read; a feed's menu marks its own", async ({ page }) => {
  await open(page);
  await row(page, "The Verge").click();
  await expect(page.getByRole("heading", { level: 1, name: "The Verge" })).toBeVisible();
  await expect(posts(page)).toHaveCount(4);
  await row(page, "Ars Technica").click({ button: "right" });
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
  await row(page, "kottke.org").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unfollow…" }).click();
  await dialog.getByRole("button", { name: "Unfollow" }).click();
  await expect(section(page).locator("[data-feed-row]")).toHaveCount(4);
  await expect(page.getByRole("heading", { level: 1, name: "All feeds" })).toBeVisible();
  await expect(posts(page).filter({ hasText: "kottke.org" })).toHaveCount(0);
});

test("rename and where new posts go, from the row menu", async ({ page }) => {
  await open(page);
  await row(page, "Serious Eats").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Eats");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(row(page, "Eats")).toBeVisible();
  await row(page, "Eats").click({ button: "right" });
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

test("the strip of a narrow window has one Feeds button, with a dot for new posts", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await open(page);
  const button = page.getByRole("button", { name: /^Feeds/ });
  await expect(button.locator("span.bg-ink")).toBeVisible();
  await button.click();
  await expect(posts(page).first()).toBeVisible();
  // One column: the post replaces the list, ← brings it back.
  await posts(page).first().click();
  await expect(page.locator("[data-feed-list]")).toHaveCount(0);
  await sheet(page).getByRole("button", { name: "Back to the list" }).click();
  await expect(page.locator("[data-feed-list]")).toBeVisible();
});

test("Settings → Feeds: how often to check, OPML import and export", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: "3 hr" }).click();
  await expect(page.getByRole("radio", { name: "3 hr" })).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => localStorage.getItem("koonapin.demo.feedsRefreshMinutes"))).toBe("180");
  // Import… opens the import dialog for feeds, as More → «Import feeds (OPML)…» does.
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
