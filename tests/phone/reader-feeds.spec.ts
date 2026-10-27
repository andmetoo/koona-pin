import { test, expect, type Page } from "@playwright/test";
import { navPill, openPhone, systemBack, topScreen } from "./fixtures";

// NP-072b wave 1, part D: the reader (R1), Feeds (F1) and a feed's post.

async function openFirstBookmark(page: Page) {
  const row = topScreen(page).locator("[data-bookmark-id]").first();
  await row.click();
  const reader = topScreen(page);
  await expect(reader).toHaveAttribute("data-route");
  return reader;
}

test.describe("the reader", () => {
  test("shows the article under glass circles, with the action pill and its progress", async ({ page }) => {
    await openPhone(page);
    const reader = await openFirstBookmark(page);
    await expect(reader.locator(".rd-hero")).toBeVisible();
    await expect(reader.locator(".reader-body")).toBeVisible();
    await expect(reader.locator(".rd-source")).toContainText("min read");
    const pill = reader.getByRole("toolbar", { name: "Reader actions" });
    await expect(pill).toBeVisible();
    await expect(pill.getByRole("progressbar")).toHaveAttribute("aria-valuenow", /\d+/);
    // The pill floats over the bottom of the screen, clear of the home indicator.
    const box = (await pill.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(852 - 32);
    // Scrolling to the end reads it all.
    await reader.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(pill.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    await expect(navPill(page)).toHaveAttribute("data-hidden");
  });

  test("the heart favours the bookmark; open original goes to the page", async ({ page }) => {
    await openPhone(page);
    const reader = await openFirstBookmark(page);
    const heart = reader.getByRole("button", { name: /favorites/ });
    const before = await heart.getAttribute("aria-pressed");
    await heart.click();
    await expect(heart).toHaveAttribute("aria-pressed", before === "true" ? "false" : "true");
    const popup = page.waitForEvent("popup");
    await reader.getByRole("button", { name: "Open original" }).click();
    expect((await popup).url()).toMatch(/^https?:/);
  });

  test("Aa opens the reading look as a sheet; the font and size apply to the text", async ({ page }) => {
    await openPhone(page);
    const reader = await openFirstBookmark(page);
    const body = reader.locator(".reader-body");
    await expect(body).toBeVisible();
    const size = await body.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBe(19);
    await reader.getByRole("button", { name: "Text and theme" }).click();
    const sheet = page.locator('[data-sheet-kind="readerLook"]');
    await expect(sheet.getByRole("dialog", { name: "Text and theme" })).toBeVisible();
    await sheet.getByRole("button", { name: "Larger text" }).click();
    await sheet.getByRole("radio", { name: "Sans" }).click();
    await expect.poll(() => body.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(20);
    expect(await body.evaluate((el) => getComputedStyle(el).fontFamily)).not.toContain("Literata");
    // A chosen theme paints the page; Supporter's are locked without the plan.
    await sheet.getByRole("radio", { name: "Dark" }).click();
    await expect(reader).toHaveCSS("background-color", "rgb(30, 29, 26)");
    await expect(sheet.getByRole("radio", { name: "Sepia, with Supporter" })).toBeVisible();
    expect(await systemBack(page)).toBe(true);
    await expect(sheet).toHaveCount(0);
    await expect(reader).toHaveAttribute("data-route");
  });

  /** Pulls the reader's progress up out of the pill by `dy`, in small steps, as a finger. */
  async function pull(page: Page, dy: number) {
    const pie = (await page.locator("[data-screen]:not([hidden]) [data-reading-progress]").boundingBox())!;
    const x = pie.x + pie.width / 2;
    const y = pie.y + pie.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - dy, { steps: 12 });
    await page.mouse.up();
  }

  test("no Done: the progress is a pie; pulling it up finishes the reading, with Undo; a short pull changes nothing", async ({ page }) => {
    await openPhone(page);
    await navPill(page).getByRole("button", { name: "Reading" }).click();
    await expect(topScreen(page).getByRole("heading", { level: 1 })).toHaveText("Reading");
    const reader = await openFirstBookmark(page);
    const title = (await reader.getAttribute("aria-label"))!;
    await expect(reader.getByRole("button", { name: "Done" })).toHaveCount(0);
    const progress = reader.getByRole("progressbar", { name: "Read so far" });
    await expect(progress).toHaveAttribute("aria-valuetext", /% read/);
    // The screen reader's way: a "Mark as finished" button beside it.
    await expect(reader.getByRole("button", { name: "Mark as finished" })).toHaveCount(1);

    await pull(page, 40);
    await expect(page.locator("[data-snackbar]")).toHaveCount(0);
    await expect(reader.locator(".lq[data-finished]")).toHaveCount(0);

    await pull(page, 120);
    const snackbar = page.locator("[data-snackbar]");
    await expect(snackbar).toContainText(`Finished · ${title}`);
    // The reader stays, the pie shows the check.
    await expect(topScreen(page)).toHaveAttribute("aria-label", title);
    await expect(reader.locator(".lq[data-finished]")).toHaveCount(1);
    await expect(progress).toHaveAttribute("aria-valuetext", "Finished");
    await snackbar.getByRole("button", { name: "Undo" }).click();
    await expect(reader.locator(".lq[data-finished]")).toHaveCount(0);
    expect(await systemBack(page)).toBe(true);
    await expect(topScreen(page).locator("[data-bookmark-id]", { hasText: title })).toHaveCount(1);
  });

  test("a tap on the pie asks first; the article's end has no button", async ({ page }) => {
    await openPhone(page);
    await navPill(page).getByRole("button", { name: "Reading" }).click();
    const reader = await openFirstBookmark(page);
    await reader.locator("[data-reading-progress]").click();
    const sheet = page.locator('[data-sheet-kind="finishReading"]');
    await expect(sheet.getByRole("dialog", { name: "Mark as finished?" })).toBeVisible();
    await expect(sheet).toContainText("It moves to Read.");
    await sheet.getByRole("button", { name: "Mark as finished" }).click();
    await expect(page.locator("[data-snackbar]")).toContainText("Finished · ");
    await page.locator("[data-snackbar]").getByRole("button", { name: "Undo" }).click();
    await expect(reader.locator(".lq[data-finished]")).toHaveCount(0);
    // Read to the end, it is finished by itself (owner, 20 October 2026): no row to tap there.
    await reader.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(reader.locator(".lq[data-finished]")).toHaveCount(1);
    await expect(reader.locator("[data-reader-end]")).toHaveCount(0);
  });

  test("finishing marks it read and moves it to Reading's Read page; one Undo puts it back", async ({ page }) => {
    await openPhone(page);
    await navPill(page).getByRole("button", { name: "Reading" }).click();
    const reader = await openFirstBookmark(page);
    const title = (await reader.getAttribute("aria-label"))!;
    const menu = page.locator('[data-sheet-kind="bookmarkMenu"]');
    // From the reader, the menu's "Mark as read" is the reader's own finish: the pie shows it.
    await reader.getByRole("button", { name: "More" }).click();
    await menu.getByRole("button", { name: "Mark as read" }).click();
    await expect(page.locator("[data-snackbar]")).toContainText(`Finished · ${title}`);
    await expect(page.locator("[data-snackbar]")).toHaveCount(1);
    await expect(reader.locator(".lq[data-finished]")).toHaveCount(1);
    await expect(reader.getByRole("button", { name: "Mark as finished" })).toHaveCount(0);
    await expect(menu).toHaveCount(0);
    // Still in Reading, read now.
    await reader.getByRole("button", { name: "More" }).click();
    await expect(menu.getByRole("button", { name: "Remove from Reading" })).toBeVisible();
    await expect(menu.getByRole("button", { name: "Mark as unread" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    // On the Read page, not on To read.
    expect(await systemBack(page)).toBe(true);
    const screen = topScreen(page);
    await expect(screen.locator("[data-bookmark-id]", { hasText: title })).toHaveCount(0);
    await screen.getByRole("radio", { name: /^Read \d+$/ }).click();
    await expect(screen.locator("[data-bookmark-id]", { hasText: title })).toHaveCount(1);
    // Undo puts it back unread, on To read.
    await page.locator("[data-snackbar]").getByRole("button", { name: "Undo" }).click();
    await expect(screen.locator("[data-bookmark-id]", { hasText: title })).toHaveCount(0);
    await screen.getByRole("radio", { name: /^To read \d+$/ }).click();
    await expect(screen.locator("[data-bookmark-id]", { hasText: title })).toHaveCount(1);
  });

  test("the book next to the heart puts the bookmark into Reading with Undo; then the pie can finish it", async ({ page }) => {
    await openPhone(page);
    const reader = await openFirstBookmark(page);
    const book = reader.locator(".rd-actions").getByRole("button", { name: /Send to Reading|Remove from Reading/ });
    // Start outside Reading.
    if ((await book.getAttribute("aria-pressed")) === "true") {
      await book.click();
      await expect(book).toHaveAttribute("aria-pressed", "false");
    }
    await expect(book).toHaveAccessibleName("Send to Reading");
    await expect(reader.getByRole("button", { name: "Mark as finished" })).toHaveCount(0);
    await book.click();
    await expect(book).toHaveAttribute("aria-pressed", "true");
    await expect(book).toHaveAccessibleName("Remove from Reading");
    const snackbar = page.locator("[data-snackbar]");
    await expect(snackbar).toContainText("Sent to Reading");
    await expect(reader.getByRole("button", { name: "Mark as finished" })).toHaveCount(1);
    await snackbar.getByRole("button", { name: "Undo" }).click();
    await expect(book).toHaveAttribute("aria-pressed", "false");
    await expect(reader.getByRole("button", { name: "Mark as finished" })).toHaveCount(0);
  });

  test("outside Reading the pie only shows the progress", async ({ page }) => {
    await openPhone(page);
    const reader = await openFirstBookmark(page);
    await expect(reader.getByRole("progressbar", { name: "Read so far" })).toBeVisible();
    // Out of Reading first, through the ⋯ menu's own item.
    await reader.getByRole("button", { name: "More" }).click();
    const menu = page.locator('[data-sheet-kind="bookmarkMenu"]');
    const remove = menu.getByRole("button", { name: "Remove from Reading" });
    if (await remove.count()) await remove.click();
    else await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(reader.getByRole("button", { name: "Mark as finished" })).toHaveCount(0);
    await reader.locator("[data-reading-progress]").click();
    await expect(page.locator('[data-sheet-kind="finishReading"]')).toHaveCount(0);
  });
});

test.describe("Feeds", () => {
  async function openFeeds(page: Page) {
    await openPhone(page);
    await navPill(page).getByRole("button", { name: "Feeds" }).click();
    const feeds = topScreen(page);
    await expect(feeds.getByRole("heading", { level: 1 })).toHaveText("Feeds");
    await expect(feeds.locator("[data-feed-item-id]").first()).toBeVisible();
    return feeds;
  }

  test("shows feed chips, the Unread | All switch and the posts by day", async ({ page }) => {
    const feeds = await openFeeds(page);
    const chips = feeds.getByRole("toolbar", { name: "Feeds to show" });
    await expect(chips.getByRole("button", { name: /^All feeds/ })).toHaveAttribute("aria-pressed", "true");
    await expect(feeds.getByRole("radio", { name: "Unread" })).toHaveAttribute("aria-checked", "true");
    await expect(feeds.locator(".ph-meta").first()).toContainText("new");
    const unread = await feeds.locator("[data-feed-item-id]").count();
    await expect(feeds.locator("[data-feed-item-id][data-read]")).toHaveCount(0);
    await feeds.getByRole("radio", { name: "All" }).click();
    await expect.poll(() => feeds.locator("[data-feed-item-id]").count()).toBeGreaterThanOrEqual(unread);

    // A feed's chip shows that feed only.
    const chip = chips.locator(".fd-chip[data-feed-uid]").first();
    const uid = await chip.getAttribute("data-feed-uid");
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(feeds.locator(`[data-feed-item-id]:not([data-feed-uid="${uid}"])`)).toHaveCount(0);
    await expect(feeds.locator(`[data-feed-item-id][data-feed-uid="${uid}"]`).first()).toBeVisible();
  });

  test("a long press on a feed chip opens the feed's menu as a sheet", async ({ page }) => {
    const feeds = await openFeeds(page);
    const chip = feeds.locator(".fd-chip[data-feed-uid]").first();
    const box = (await chip.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(650);
    await page.mouse.up();
    const menu = page.locator('[data-sheet-kind="feedMenu"]');
    await expect(menu.getByRole("dialog")).toBeVisible();
    await expect(menu.getByRole("button", { name: "Unfollow…" })).toBeVisible();
    // The press did not also open the feed.
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    await menu.getByRole("button", { name: "Unfollow…" }).click();
    await expect(page.getByRole("dialog", { name: /^Unfollow/ })).toBeVisible();
  });

  test("a post opens over the list, saves as a bookmark, and Back returns with it kept", async ({ page }) => {
    const feeds = await openFeeds(page);
    const row = feeds.locator("[data-feed-item-id]").first();
    const id = await row.getAttribute("data-feed-item-id");
    const title = (await row.locator(".fd-title").textContent())!;
    await row.click();
    const post = topScreen(page);
    await expect(post).toHaveAttribute("data-route");
    await expect(post.locator(".reader-title")).toHaveText(title);
    await expect(post.locator(".reader-body")).toBeVisible();
    await expect(navPill(page)).toHaveAttribute("data-hidden");

    const save = post.getByRole("button", { name: "Save as bookmark" });
    await save.click();
    await expect(post.getByRole("button", { name: "Saved as a bookmark" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-snackbar]")).toContainText("Saved to");

    // Read after a second; on Unread it stays where it was until the list changes.
    await page.waitForTimeout(1300);
    expect(await systemBack(page)).toBe(true);
    const back = topScreen(page).locator(`[data-feed-item-id="${id}"]`);
    await expect(back).toBeVisible();
    await expect(back).toHaveAttribute("data-read");
    await expect(back.locator(".fd-saved")).toBeVisible();
  });

  test("the refresh circle checks the feeds", async ({ page }) => {
    const feeds = await openFeeds(page);
    await feeds.getByRole("button", { name: "Check for new posts" }).click();
    await expect(feeds.locator(".ph-meta").first()).toContainText(/updated|Checking/);
  });
});
