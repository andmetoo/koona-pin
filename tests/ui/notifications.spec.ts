import { test, expect, type Page } from "@playwright/test";
import { bell, centre, openApp, openTriage, opened, stubBrowser } from "../fixtures/app";

// The notification centre (2026-10-16): the inbox waiting, the import offer and a browser that
// can't send bookmarks wait behind the bell in the sidebar instead of banners over the library.
// The preview follows no feeds here: Serious Eats notifies of new posts (feeds-follow.spec.ts covers that).
const open = (page: Page, settings: Record<string, string> = {}) => openApp(page, { settings: { "demo.feeds": "empty", ...settings }, cards: 6 });

test("the badge counts the unread; opening reads them, a newer bookmark is unread again; the bell toggles the centre, a click outside closes it", async ({ page }) => {
  await open(page, { importBanner: "show" });
  await expect(bell(page).locator(".notify-badge")).toHaveText("2");
  await expect(bell(page)).toHaveAccessibleName("Notifications, 2 new");
  await bell(page).click();
  await expect(bell(page)).toHaveAttribute("aria-expanded", "true");
  // Both carry their unread dot while this opening lasts; focus is on the first action.
  await expect(centre(page).locator(".nt-unread")).toHaveCount(2);
  await expect(centre(page).getByRole("button", { name: "Sort", exact: true })).toBeFocused();
  // Arrows walk through the buttons, Tab stays inside.
  await page.keyboard.press("ArrowDown");
  await expect(centre(page).getByRole("button", { name: "Hide until new bookmarks arrive" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(centre(page).getByRole("button", { name: "Sort", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(centre(page)).toHaveCount(0);
  await expect(bell(page)).toBeFocused();
  // Read now, also after a restart.
  await expect(bell(page).locator(".notify-badge")).toHaveCount(0);
  await expect(bell(page)).toHaveAccessibleName("Notifications");
  await page.reload();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
  await expect(bell(page)).toHaveAccessibleName("Notifications");
  await bell(page).click();
  await expect(centre(page).locator(".nt-unread")).toHaveCount(0);
  await page.keyboard.press("Escape");
  // A newer bookmark makes the inbox notification unread again; the offer stays read.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    await api.addBookmark({ url: "https://example.com/newer", title: "Newer" });
  });
  await expect(bell(page).locator(".notify-badge")).toHaveText("1");
  await bell(page).click();
  await expect(centre(page).locator('[data-notification="inbox"]')).toContainText("3 new in Inbox");
  await expect(centre(page).locator('[data-notification="inbox"] .nt-unread')).toHaveCount(1);
  await expect(centre(page).locator('[data-notification="offer"] .nt-unread')).toHaveCount(0);

  // The bell toggles the centre; a click outside closes it.
  await bell(page).click();
  await expect(centre(page)).toHaveCount(0);
  await bell(page).click();
  await expect(centre(page)).toBeVisible();
  await page.mouse.click(1100, 700);
  await expect(centre(page)).toHaveCount(0);
  // Esc in the centre closes only the centre: a selection stays.
  await page.locator('[data-bookmark-id="1"]').click({ modifiers: ["ControlOrMeta"] });
  await bell(page).click();
  await page.keyboard.press("Escape");
  await expect(centre(page)).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: /selected/i })).toBeVisible();
});

test("triage from the centre: Sort opens it over the inbox, says a starter link was added by Koona Pin, keeps Space for the browser", async ({ page }) => {
  await open(page);
  // NP-117: the preview makes no starter set of its own; its marks go into localStorage.
  const ids = await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    return (await api.getBookmarks({ onlyInbox: true } as never)).items.map((b) => b.id);
  });
  await page.evaluate((list) => localStorage.setItem("koonapin.demo.starter", JSON.stringify(list)), ids);
  await page.reload();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
  await stubBrowser(page);
  await openTriage(page);
  await expect(centre(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Sort inbox\s*1 of 2/);
  await expect(page.locator("[data-triage-card]")).toContainText(/added by Koona Pin /);
  // NP-123: Space in triage opens the browser, not the reading sheet.
  await page.keyboard.press("Space");
  expect(await opened(page)).toHaveLength(1);
  await expect(page.locator("dialog[data-reading-sheet]")).toHaveCount(0);
});

test("the import offer opens the import and goes away for good with × (NP-117)", async ({ page }) => {
  await open(page, { importBanner: "show" });
  const offer = centre(page).locator('[data-notification="offer"]');
  // No banner over the list: the offer waits in the notification centre, after the inbox.
  await expect(page.getByRole("region", { name: "Import bookmarks" })).toHaveCount(0);
  await expect(bell(page)).toHaveAccessibleName("Notifications, 2 new");
  await bell(page).click();
  await expect(offer).toContainText("Import bookmarks");
  await expect(offer).toContainText("Bring your bookmarks from Chrome, Edge or Firefox");
  const inbox = centre(page).locator('[data-notification="inbox"]');
  expect((await inbox.boundingBox())!.y).toBeLessThan((await offer.boundingBox())!.y);
  await offer.getByRole("button", { name: "Import bookmarks…" }).click();
  await expect(centre(page)).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Import bookmarks" })).toBeVisible();
  await page.keyboard.press("Escape");
  await bell(page).click();
  await offer.getByRole("button", { name: "Hide" }).click();
  await expect(offer).toHaveCount(0);
  await expect(inbox).toHaveCount(1);
  await page.reload();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
  await bell(page).click();
  await expect(inbox).toHaveCount(1);
  await expect(offer).toHaveCount(0);
});

test("Clear all hides what can be hidden; the empty centre says so", async ({ page }) => {
  await open(page, { importBanner: "show" });
  await bell(page).click();
  await centre(page).getByRole("button", { name: "Clear all" }).click();
  await expect(centre(page).locator("[data-notification]")).toHaveCount(0);
  await expect(centre(page)).toContainText("Nothing new");
  await expect(centre(page).getByRole("button", { name: "Clear all" })).toHaveCount(0);
  await page.reload();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
  await bell(page).click();
  await expect(centre(page)).toContainText("Nothing new");
});

test("a browser that can't send bookmarks is a problem: amber, Details, no ×", async ({ page }) => {
  await open(page, { "demo.capture": "failing" });
  await expect(bell(page).locator(".notify-badge")).toHaveText("2");
  await expect(bell(page).locator(".notify-badge")).toHaveClass(/notify-badge-problem/);
  await bell(page).click();
  const problem = centre(page).locator('[data-notification="problem"]');
  await expect(problem).toContainText("Capture isn't working");
  await expect(problem).toContainText("The browser can't send bookmarks: Koona Pin couldn't open its capture channel.");
  await expect(problem.locator(".nt-x")).toHaveCount(0);
  // Clear all leaves it.
  await centre(page).getByRole("button", { name: "Clear all" }).click();
  await expect(problem).toHaveCount(1);
  await page.keyboard.press("Escape");
  // Read, it keeps an amber dot: it is still there.
  await expect(bell(page).locator(".notify-badge")).toHaveCount(0);
  await expect(bell(page).locator(".notify-dot")).toBeVisible();
  await expect(bell(page)).toHaveAccessibleName("Notifications, there is a problem");
  await bell(page).click();
  await problem.getByRole("button", { name: "Details" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
});

test("the narrow strip has the bell under the spirit; the centre opens beside the strip", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 550 });
  await open(page, { importBanner: "show" });
  const box = (await bell(page).boundingBox())!;
  expect(box.x + box.width).toBeLessThan(56);
  await bell(page).click();
  const panel = (await centre(page).boundingBox())!;
  expect(panel.x).toBeGreaterThanOrEqual(56);
  expect(panel.x + panel.width).toBeLessThanOrEqual(800);
  expect(panel.y + panel.height).toBeLessThanOrEqual(550);
});

// Nothing the page paints may cross the open centre: in a narrow window WKWebView drew a scroll
// container's scrollbar over it. Long, scrolling library and sidebar; the strip and the full sidebar.
for (const width of [800, 1200])
  test(`nothing paints over the open centre (${width} px, scrolling library and sidebar)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 600 });
    await open(page, { importBanner: "show" });
    await page.evaluate(async () => {
      const { api } = await import("/src/services/api.ts");
      for (let i = 0; i < 40; i++) await api.addBookmark({ url: `https://example.com/many/${i}`, title: `Bookmark ${i}` });
      for (let i = 0; i < 30; i++) await api.createCollection(`Collection ${i}`);
    });
    await page.reload();
    await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
    const scroller = page.locator('[data-scroll="main"]');
    await expect.poll(() => scroller.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
    await scroller.evaluate((e) => (e.scrollTop = 300));
    if (width > 999) expect(await page.locator("aside").evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
    await bell(page).click();
    await expect(centre(page)).toBeVisible();
    // In the top layer, where the browser has it.
    expect(await centre(page).evaluate((e) => (typeof e.showPopover === "function" ? e.matches(":popover-open") : true))).toBe(true);
    const outside = await centre(page).evaluate((panel) => {
      const r = panel.getBoundingClientRect();
      const misses: string[] = [];
      // 18 px in: the rounded corners are not the panel's.
      for (let x = r.left + 18; x <= r.right - 18; x += 4)
        for (let y = r.top + 18; y <= r.bottom - 18; y += 8) {
          const hit = document.elementFromPoint(x, y);
          if (!hit || !panel.contains(hit)) misses.push(`${Math.round(x)},${Math.round(y)} ${hit?.tagName}`);
        }
      return misses;
    });
    expect(outside).toEqual([]);
  });
