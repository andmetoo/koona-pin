import { test, expect, type Page } from "@playwright/test";
import { openApp, settingsGroup } from "../fixtures/app";

// Settings → Storage → «Cleaned tag names»: what the cleaning of stored tag names did on this
// device (db::cleaned_tags), read only, newest first, the invisible characters shown by their code.
const row = (page: Page) => page.locator("[data-settings-cleaned-tags]");
const storage = async (page: Page) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  return settingsGroup(page, "storage");
};

const text = (text: string) => ({ text, unseen: false });
const code = (text: string) => ({ text, unseen: true });
// As db::cleaned_tags gives it: the old name in parts, what the cleaning took out by its code.
const record = [
  { at: "2026-11-02T09:30:00Z", action: "removed", parts: [code("U+200B")], now_named: null, bookmarks: 1 },
  { at: "2026-11-01T14:05:00Z", action: "merged", parts: [text("co"), code("U+00AD"), text("op")], now_named: "coop", bookmarks: 3 },
  { at: "", action: "renamed", parts: [code("U+0020"), text("to "), code("U+0020"), text("read")], now_named: "to read", bookmarks: 0 },
];

test("nothing cleaned: no row in Storage", async ({ page }) => {
  await openApp(page, { settings: { "demo.tagCleanups": null } });
  const group = await storage(page);
  await expect(group.getByText("Search index")).toBeVisible();
  await expect(row(page)).toHaveCount(0);
});

test("the record: folded with its count, then each entry with its old name, what it became and its bookmarks", async ({ page }) => {
  await openApp(page, { settings: { "demo.tagCleanups": JSON.stringify(record) } });
  await storage(page);
  await expect(row(page)).toHaveAttribute("data-settings-cleaned-tags", "folded");
  await expect(row(page)).toContainText("Cleaned tag names");
  await expect(row(page)).toContainText("3 tag names were tidied the way new tags are: characters nobody sees and extra spaces taken out, capitals lowered. The list stays on this device.");
  const show = row(page).getByRole("button", { name: "Show", exact: true });
  await expect(show).toHaveAttribute("aria-expanded", "false");
  await show.click();

  await expect(row(page)).toHaveAttribute("data-settings-cleaned-tags", "shown");
  const list = row(page).getByRole("list", { name: "Cleaned tag names" });
  const entries = list.getByRole("listitem");
  await expect(entries).toHaveCount(3);

  // Newest first, as the command gives them; a name with nothing visible left says so.
  const removed = entries.nth(0);
  await expect(removed).toHaveAttribute("data-cleaned", "removed");
  await expect(removed.locator("[data-cleaned-name]")).toHaveText("U+200B");
  await expect(removed.locator("[data-cleaned-now]")).toHaveText("no visible name");
  await expect(removed).toContainText(/Removed · 1 bookmark · November 2 at [0-9]/);

  const merged = entries.nth(1);
  await expect(merged.locator("[data-cleaned-name]")).toHaveText("coU+00ADop");
  await expect(merged.locator("[data-cleaned-now]")).toHaveText("coop");
  await expect(merged).toContainText(/Merged · 3 bookmarks · /);

  // A rename keeps its tag and its bookmarks: no count; an entry without a time that reads goes without one.
  // Spaces show as they were, the extra ones by their code.
  const renamed = entries.nth(2);
  await expect(renamed.locator("[data-cleaned-name]")).toHaveText("U+0020to U+0020read");
  await expect(renamed.locator("[data-cleaned-now]")).toHaveText("to read");
  await expect(renamed.locator("div").last()).toHaveText("Renamed");
  // Read as one sentence: the old name, then what it became.
  await expect(renamed).toContainText("became");

  // Read only: nothing in the list to press.
  await expect(list.getByRole("button")).toHaveCount(0);

  const hide = row(page).getByRole("button", { name: "Hide", exact: true });
  await expect(hide).toHaveAttribute("aria-expanded", "true");
  await hide.click();
  await expect(list).toHaveCount(0);
  await expect(row(page)).toHaveAttribute("data-settings-cleaned-tags", "folded");
});

test("a long record scrolls in its place, the page does not grow with it", async ({ page }) => {
  const many = Array.from({ length: 200 }, (_, n) => ({ ...record[1], at: `2026-10-${String((n % 28) + 1).padStart(2, "0")}T10:00:00Z` }));
  await openApp(page, { settings: { "demo.tagCleanups": JSON.stringify(many) } });
  await storage(page);
  await row(page).getByRole("button", { name: "Show", exact: true }).click();
  const list = row(page).getByRole("list", { name: "Cleaned tag names" });
  await expect(list.getByRole("listitem")).toHaveCount(200);
  const box = await list.boundingBox();
  expect(box?.height).toBeLessThanOrEqual(320);
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
});
