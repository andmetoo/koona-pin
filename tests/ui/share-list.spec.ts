// «Share as list…» (NP-140, NP-141, frame K2): from a collection's menu, a selection and the feeds,
// against the browser preview; the system Save dialog is mocked.
import { test, expect } from "@playwright/test";
import { openApp } from "../fixtures/app";

type Page = import("@playwright/test").Page;
const dialog = (page: Page) => page.getByRole("dialog", { name: "Make a list others can import" });
const collectionRow = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Collections" }).locator("[data-collection-row]").filter({ hasText: name });

/** Save answers as the desktop app would, and keeps what it was given. */
async function mockSave(page: Page) {
  await page.evaluate(async () => {
    const { lists } = await import("/src/services/shareList.ts");
    const calls: { text: string; id: string }[] = [];
    (window as unknown as { saveCalls: typeof calls }).saveCalls = calls;
    lists.saveList = async (text, id) => {
      calls.push({ text, id });
      return { outcome: "saved", file_name: `${id}.kpin`, count: 1 };
    };
  });
}
const saveCalls = (page: Page) => page.evaluate(() => (window as unknown as { saveCalls: { text: string; id: string }[] }).saveCalls);

test.beforeEach(({ page }) => openApp(page));

test("a collection's menu opens the builder; Save writes what the preview shows (NP-140)", async ({ page }) => {
  await mockSave(page);
  await collectionRow(page, "Development").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share as list…" }).click();
  const share = dialog(page);
  await expect(share).toBeVisible();
  // 720 × 640 in a window of 1200 × 800 (K2).
  const box = (await share.boundingBox())!;
  expect([Math.round(box.width), Math.round(box.height)]).toEqual([720, 640]);
  await expect(share.getByText("Share as list", { exact: true })).toBeVisible();
  await expect(share.getByLabel("Title", { exact: true })).toHaveValue("Development");
  await expect(share.locator("[data-share-chip]")).toHaveText([/^Development · \d+ links?/]);
  const stats = share.locator("[data-share-stats]");
  await expect(stats).toHaveText(/^\d+ links? · 0 feeds · .*kB$/);
  await expect(share.getByText("development.kpin")).toBeVisible();
  await expect(share.getByText("The file holds only what you see.")).toBeVisible();
  // Notes are off until asked for, with the warning beside them.
  await expect(share.getByLabel("My notes")).not.toBeChecked();
  await expect(share.getByText("Notes may be private: check the preview.")).toBeVisible();

  // The details are folded; the id follows the title until it is typed.
  await share.getByRole("button", { name: "More details: id, language, date" }).click();
  await expect(share.getByLabel("List id")).toHaveValue("development");
  await share.getByLabel("Title", { exact: true }).fill("Dev reading 2026");
  await expect(share.getByLabel("List id")).toHaveValue("dev-reading-2026");
  await expect(share.getByLabel("Language")).toHaveValue(/^en/);

  await share.getByRole("radio", { name: "By tag" }).click();
  await expect(stats).toContainText(/section/);
  await share.getByRole("button", { name: "Save .kpin…" }).click();
  await expect(share).toBeHidden();
  const toast = page.locator("[role=status]").filter({ hasText: "List saved to dev-reading-2026.kpin" });
  await expect(toast).toBeVisible();
  await expect(toast.getByRole("button", { name: "Show" })).toBeVisible();
  const [call] = await saveCalls(page);
  expect(call.id).toBe("dev-reading-2026");
  const file = JSON.parse(call.text);
  expect(file).toMatchObject({ format: "koona", app: "pin", kind: "list", version: "1.0", title: "Dev reading 2026", license: "CC0-1.0" });
  // Save hands over the previewed text as it is. This runs the browser preview's stand-in builder:
  // what a list may never hold is tested on the Rust writer (lists/export.rs).
  expect(JSON.stringify(file)).not.toMatch(/"(uid|created_at|triaged_at|deleted_at|notes|is_favorite)"/);
});

/** The first bookmark of a collection, given a note and an address with a key in its query. */
async function seedCollectionLink(page: Page, collection: string, note: string, url?: string) {
  await page.evaluate(
    async ([name, note, url]) => {
      const { api } = await import("/src/services/api.ts");
      const id = (await api.getCollections()).find((c) => c.name === name)!.id;
      const [first] = (await api.getBookmarks({ collectionId: id })).items;
      await api.updateBookmark(first.id, { notes: note });
      if (url) {
        const stored = JSON.parse(localStorage.getItem("koonapin.demo.v4") ?? "null");
        if (stored) {
          stored.bookmarks = stored.bookmarks.map((b: { id: number; url: string }) => (b.id === first.id ? { ...b, url } : b));
          localStorage.setItem("koonapin.demo.v4", JSON.stringify(stored));
        }
      }
    },
    [collection, note, url ?? ""] as const,
  );
  if (url) await page.reload();
}

test("Save and Copy wait for the build of the choices on screen; the rows show what goes in", async ({ page }) => {
  await seedCollectionLink(page, "Development", "My private thought");
  await mockSave(page);
  // Each build takes a while, as a big library's would.
  await page.evaluate(async () => {
    const { lists } = await import("/src/services/shareList.ts");
    const build = lists.buildList;
    lists.buildList = async (options) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return build(options);
    };
  });
  await collectionRow(page, "Development").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share as list…" }).click();
  const share = dialog(page);
  const save = share.getByRole("button", { name: "Save .kpin…" });
  const copy = share.getByRole("button", { name: "Copy as Markdown" });
  await expect(save).toBeEnabled();
  const row = share.locator("[data-share-row]").first();
  await expect(row.locator("[data-share-description]")).not.toHaveText("My private thought");

  await share.getByLabel("My notes").check();
  await expect(save).toBeDisabled();
  await expect(copy).toBeDisabled();
  await expect(row.locator("[data-share-description]")).toHaveText("My private thought");
  await expect(save).toBeEnabled();

  await share.getByLabel("My notes").uncheck();
  await expect(save).toBeDisabled();
  await save.click({ force: true });
  expect(await saveCalls(page)).toHaveLength(0);
  await expect(save).toBeEnabled();
  await expect(row.locator("[data-share-description]")).not.toHaveText("My private thought");
  await save.click();
  await expect(share).toBeHidden();
  const [call] = await saveCalls(page);
  expect(call.text).not.toContain("My private thought");
});

test("an address whose query looks like a key is marked and counted, and still goes in", async ({ page }) => {
  await seedCollectionLink(page, "Development", "", "https://user:pw@example.com/feed?token=abc");
  await collectionRow(page, "Development").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share as list…" }).click();
  const share = dialog(page);
  await expect(share.locator("[data-share-key]")).toHaveText(["May contain a private key"]);
  await expect(share.locator("[data-share-keys]")).toHaveText("1 address may contain a private key: check before you share.");
  await expect(share.locator("[data-share-row]").first()).toContainText("example.com");
  await expect(share.getByText("user:pw")).toHaveCount(0);
});

test("a selection needs a title; Copy as Markdown copies the list; the author is remembered", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "clipboard permissions");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockSave(page);
  const cards = page.locator("article[data-bookmark-id]");
  await cards.nth(0).locator("h2").first().click();
  await cards.nth(1).locator("h2").first().click({ modifiers: ["ControlOrMeta"] });
  const bar = page.getByRole("toolbar", { name: "Selected bookmarks" });
  await bar.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "Share as list…" }).click();
  const share = dialog(page);
  await expect(share.locator("[data-share-chip]")).toHaveText(["Selected · 2 links"]);
  await expect(share.getByLabel("Title", { exact: true })).toHaveValue("");
  await expect(share.getByText("Untitled list")).toBeVisible();
  await expect(share.getByRole("button", { name: "Save .kpin…" })).toBeDisabled();
  await expect(share.getByRole("button", { name: "Copy as Markdown" })).toBeDisabled();

  await share.getByLabel("Title", { exact: true }).fill("Two [good] links");
  await share.getByLabel("Your name").fill("Someone");
  await share.getByRole("button", { name: "Copy as Markdown" }).click();
  await expect(share.getByRole("button", { name: "Copied" })).toBeVisible();
  const markdown = await page.evaluate(() => navigator.clipboard.readText());
  expect(markdown).toMatch(/^# Two \\\[good\\\] links\n\n- \[.+\]\(https?:\/\/.+\)/);
  expect(markdown.match(/^- /gm)).toHaveLength(2);

  // «+ Add links or feeds»: the feeds join in their own section.
  await share.getByRole("button", { name: "Add links or feeds" }).click();
  await page.getByRole("menuitem", { name: /^All feeds/ }).click();
  await expect(share.locator("[data-share-chip]")).toHaveCount(2);
  await expect(share.locator("[data-share-preview]").getByRole("heading", { name: "Feeds" })).toBeVisible();
  await expect(share.locator("[data-share-preview]").getByText("Feed", { exact: true }).first()).toBeVisible();

  await share.getByRole("button", { name: "Cancel" }).click();
  await expect(share).toBeHidden();
  // The author's name stays on this computer for the next list.
  await collectionRow(page, "Development").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share as list…" }).click();
  await expect(dialog(page).getByLabel("Your name")).toHaveValue("Someone");
});

test("a feed's menu and All feeds start a list of feeds", async ({ page }) => {
  const feeds = page.locator("[data-sidebar-feeds]");
  await feeds.getByRole("button", { name: "All feeds" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share as list…" }).click();
  const share = dialog(page);
  await expect(share.locator("[data-share-chip]")).toHaveText([/^\d+ feeds$/]);
  await expect(share.locator("[data-share-stats]")).toHaveText(/^0 links · \d+ feeds · 1 section · /);
  await share.press("Escape");
  await expect(share).toBeHidden();

  const row = feeds.locator("[data-feed-row]").first();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share as list…" }).click();
  await expect(dialog(page).locator("[data-share-chip]")).toHaveText([/^Feed /]);
  await expect(dialog(page).locator("[data-share-stats]")).toHaveText(/^0 links · 1 feed · 1 section · /);
});
