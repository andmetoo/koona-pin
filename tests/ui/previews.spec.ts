import { test, expect, type Page } from "@playwright/test";
import { bell, centre, openApp, settingsGroup } from "../fixtures/app";

// «Refresh previews» for many bookmarks: Settings → Data, the selection bar, after an import; its
// progress and result in the notification centre, and the link check of the pages it couldn't open.
const row = (page: Page) => page.locator("[data-settings-previews]");
const counts = (page: Page) =>
  page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    return api.getPreviewCounts();
  });
const settings = async (page: Page) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await settingsGroup(page, "storage");
};

test("Settings → Data: the choice with its counts, progress with Stop, the result in the centre", async ({ page }) => {
  await openApp(page, { settings: { "demo.refreshStep": "400" }, cards: 6 });
  const { missing, all } = await counts(page);
  expect(all).toBe(6);
  await settings(page);
  const badge = await bell(page).locator(".notify-badge").textContent().catch(() => null);
  await expect(row(page)).toContainText("Refresh previews");
  await expect(row(page)).toContainText("Read each page again for its picture, icon and site name. Your titles, notes and tags stay.");
  await row(page).getByRole("button", { name: "Refresh…" }).click();
  const menu = page.getByRole("menu", { name: "Which previews to refresh" });
  const only = menu.getByRole("menuitem", { name: /Only without a picture or site name/ });
  await expect(only).toContainText(String(missing));
  await expect(menu.getByRole("menuitem", { name: /All bookmarks/ })).toContainText("6");
  // The default: the first, focused.
  await expect(only).toBeFocused();
  await menu.getByRole("menuitem", { name: /All bookmarks/ }).click();

  await expect(row(page)).toHaveAttribute("data-settings-previews", "running");
  await expect(row(page).getByRole("status")).toHaveText(/^\d of 6$/);
  // Under way: in the centre with a bar and Stop; not counted as unread.
  if (badge === null) await expect(bell(page).locator(".notify-badge")).toHaveCount(0);
  else await expect(bell(page).locator(".notify-badge")).toHaveText(badge);
  await bell(page).click();
  const task = centre(page).locator('[data-notification="task"]');
  await expect(task).toContainText(/Refreshing previews · \d of 6/);
  await expect(task.getByRole("progressbar")).toBeVisible();
  // Stop from the centre: the centre stays, the row is idle again.
  await task.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(centre(page)).toBeVisible();
  await expect(task).toContainText("Refreshing previews stopped");
  await expect(task).toContainText(/Updated \d · unchanged \d · couldn't open \d/);
  await page.keyboard.press("Escape");
  await expect(row(page)).toHaveAttribute("data-settings-previews", "idle");

  // Stop in the row.
  await row(page).getByRole("button", { name: "Refresh…" }).click();
  await page.getByRole("menuitem", { name: /All bookmarks/ }).click();
  await row(page).getByRole("button", { name: "Stop", exact: true }).click();
  await expect(row(page)).toHaveAttribute("data-settings-previews", "idle");
  // The result is unread, and dismissable; it stays dismissed after a reload.
  await expect(bell(page).locator(".notify-badge")).toHaveText(/\d/);
  await bell(page).click();
  await centre(page).locator('[data-notification="task"]').hover();
  await centre(page).getByRole("button", { name: "Hide", exact: true }).click();
  await expect(centre(page).locator('[data-notification="task"]')).toHaveCount(0);
});

test("a whole run ends with its numbers; a refresh's failures are link-checked, and «Show them» opens the Links page", async ({ page }) => {
  await openApp(page, { settings: { "demo.refreshStep": "20" }, cards: 6 });
  const refresh = () =>
    page.evaluate(async () => {
      const { api } = await import("/src/services/api.ts");
      return api.getPreviewRefresh();
    });
  // A whole run of the sample library from Settings: every page of it opens.
  await settings(page);
  await row(page).getByRole("button", { name: "Refresh…" }).click();
  await page.getByRole("menuitem", { name: /All bookmarks/ }).click();
  await expect(row(page)).toHaveAttribute("data-settings-previews", "idle");
  const whole = await refresh();
  expect(whole.state).toBe("done");
  expect(whole.updated + whole.unchanged + whole.failed).toBe(6);
  expect(whole.check_ids).toEqual([]);
  await bell(page).click();
  const result = centre(page).locator('[data-notification="task"]').first();
  await expect(result).toContainText("Previews refreshed");
  await expect(result).toContainText(`Updated ${whole.updated} · unchanged ${whole.unchanged} · couldn't open 0`);
  await page.keyboard.press("Escape");

  // The hand-off: pages that fail in the demo's refresh and do not open in its link check.
  const ids = await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const { demoAnswer } = await import("/src/services/demo.ts");
    for (let i = 0; i < 60; i++) await api.addBookmark({ url: `https://dead${i}.example/page`, title: `Dead ${i}` });
    const page = await api.getBookmarks({}, { limit: 200 });
    return page.items.filter((b) => demoAnswer(b.url).outcome === "gone").map((b) => b.id);
  });
  expect(ids.length).toBeGreaterThan(0);
  await page.evaluate(async (ids) => {
    const { api } = await import("/src/services/api.ts");
    await api.startPreviewRefresh({ ids });
  }, ids);
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { api } = await import("/src/services/api.ts");
        return (await api.getLinkCheck()).gone.length;
      }),
    )
    .toBeGreaterThan(0);
  const failing = await refresh();
  expect(failing.check_ids.length).toBe(failing.failed);
  await bell(page).click();
  await expect(centre(page).locator('[data-notification="task"]').first()).toContainText(`${failing.failed} couldn't be opened — checking them`);
  // The link check of exactly those, and its finding as a notification of its own.
  const found = centre(page).locator("li", { hasText: "Link check finished" });
  await expect(found).toContainText(/Don't open: \d+/);
  await found.getByRole("button", { name: "Show them" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Link check");
});

test("no network: the run stops as such and marks nothing as failed", async ({ page }) => {
  await openApp(page, { settings: { "demo.refreshStep": "20", "demo.offline": "1" }, cards: 6 });
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    for (let i = 0; i < 6; i++) await api.addBookmark({ url: `https://more${i}.example/`, title: `More ${i}` });
    await api.startPreviewRefresh({ scope: "all" });
  });
  await bell(page).click();
  const task = centre(page).locator('[data-notification="task"]');
  await expect(task).toContainText("Stopped: no network");
  await expect(task).toContainText(/It stopped at 5 of 12\. Try again once you're online\./);
  const state = await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    return api.getPreviewRefresh();
  });
  expect(state).toMatchObject({ state: "offline", failed: 0, check_ids: [] });
});

test("the selection bar refreshes the selected; a second start says the run under way", async ({ page }) => {
  await openApp(page, { settings: { "demo.refreshStep": "500" }, cards: 6 });
  await page.locator('[data-bookmark-id="1"]').click({ modifiers: ["ControlOrMeta"] });
  await page.locator('[data-bookmark-id="2"]').click({ modifiers: ["ControlOrMeta"] });
  const bar = page.getByRole("toolbar", { name: "Selected bookmarks" });
  const refresh = bar.getByRole("button", { name: "Refresh previews" });
  await refresh.hover();
  await expect(bar.getByRole("tooltip", { name: "Refresh previews" })).toHaveCount(1);
  await refresh.click();
  await expect(page.getByRole("status").filter({ hasText: "Refreshing previews. The progress is in Notifications." })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { api } = await import("/src/services/api.ts");
        return (await api.getPreviewRefresh()).total;
      }),
    )
    .toBe(2);
  await refresh.click();
  await expect(page.getByText(/Previews are already being refreshed: \d of 2/)).toBeVisible();
});

test("an import refreshes the bookmarks it created, joining a run under way, and says so in its report", async ({ page }) => {
  await openApp(page, { settings: { "demo.refreshStep": "300" }, cards: 6 });
  // A run of the library under way: the import's bookmarks join it.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    await api.startPreviewRefresh({ scope: "all" });
  });
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Import a file…/ }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("[data-import-file]").click();
  await (await chooser).setFiles(new URL("../fixtures/bookmarks/chrome.html", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  await page.getByRole("dialog").getByRole("button", { name: "Import", exact: true }).click();
  const report = page.getByRole("dialog", { name: "Import finished" });
  await expect(report.getByRole("status")).toHaveText("7 bookmarks added to Library");
  await expect(report).toContainText("Pictures, icons and site names are being fetched in the background.");
  await report.getByRole("button", { name: "Done" }).click();
  const state = await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    return api.getPreviewRefresh();
  });
  expect(state).toMatchObject({ state: "running", total: 13 });
  await bell(page).click();
  await expect(centre(page).locator('[data-notification="task"]')).toContainText(/Refreshing previews · \d+ of 13/);
});

test("an import with nothing new refreshes nothing", async ({ page }) => {
  await openApp(page, { cards: 6 });
  // Nothing new from an import: no run starts.
  const state = await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    await api.importHtmlBookmarks('<DL><DT><A HREF="https://www.archdaily.com/">Vitsoe</A></DL>');
    return api.getPreviewRefresh();
  });
  expect(state.state).toBe("idle");
});
