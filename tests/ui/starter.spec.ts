import { test, expect } from "@playwright/test";

// NP-117, sheet 43: the import offer of a new library and the starter links in triage.
// The preview makes no starter set of its own; the tests put its marks into localStorage.
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.removeItem("koonapin.demo.v4");
    localStorage.setItem("koonapin.importBanner", "show");
  });
  await page.reload();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
});

test("the import offer opens the import and goes away for good with ×", async ({ page }) => {
  const bell = page.locator("[data-notification-bell]");
  const centre = page.getByRole("dialog", { name: "Notifications" });
  const offer = centre.locator('[data-notification="offer"]');
  // No banner over the list: the offer waits in the notification centre, after the inbox.
  await expect(page.getByRole("region", { name: "Import bookmarks" })).toHaveCount(0);
  await expect(bell).toHaveAccessibleName("Notifications, 2 new");
  await bell.click();
  await expect(offer).toContainText("Import bookmarks");
  await expect(offer).toContainText("Bring your bookmarks from Chrome, Edge or Firefox");
  const inbox = centre.locator('[data-notification="inbox"]');
  expect((await inbox.boundingBox())!.y).toBeLessThan((await offer.boundingBox())!.y);
  await offer.getByRole("button", { name: "Import bookmarks…" }).click();
  await expect(centre).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Import bookmarks" })).toBeVisible();
  await page.keyboard.press("Escape");
  await bell.click();
  await offer.getByRole("button", { name: "Hide" }).click();
  await expect(offer).toHaveCount(0);
  await expect(inbox).toHaveCount(1);
  await page.reload();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
  await bell.click();
  await expect(inbox).toHaveCount(1);
  await expect(offer).toHaveCount(0);
});

test("triage says a starter link was added by Koona Pin", async ({ page }) => {
  const ids = await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    return (await api.getBookmarks({ onlyInbox: true } as never)).items.map((b) => b.id);
  });
  await page.evaluate((list) => localStorage.setItem("koonapin.demo.starter", JSON.stringify(list)), ids);
  await page.reload();
  await page.locator("[data-notification-bell]").click();
  await page.getByRole("dialog", { name: "Notifications" }).getByRole("button", { name: "Sort", exact: true }).click();
  await expect(page.locator("[data-triage-card]")).toContainText(/added by Koona Pin /);
});
