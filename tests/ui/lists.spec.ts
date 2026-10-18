import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openApp } from "../fixtures/app";

// The list dialog (NP-138, frames K1a, K1b and K3) in the browser preview: a list request goes
// through openRequests as the entry points send it; the demo previews and imports, and tests
// replace the download, which the preview cannot do.
const here = path.dirname(fileURLToPath(import.meta.url));
const kpin = (name: string) => readFileSync(path.join(here, "..", "..", "src-tauri", "tests", "fixtures", "kpin", name), "utf8");
const dialog = (page: Page) => page.getByRole("dialog", { name: "Import list" });

/** Hands the dialog a request, as a drop, a file the system opened or a link would; whether it was taken. */
const push = (page: Page, request: Record<string, string>) =>
  page.evaluate(async (request) => {
    const { openRequests } = await import("/src/services/openRequests.ts");
    return openRequests.push(request as never);
  }, request);

/** The dialog's box, which must not change through its states (NP-118). */
const box = async (page: Page) => {
  const b = (await page.locator("dialog[open]").boundingBox())!;
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
};

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test("a list: the preview, choices, the import and its report, then «Show collection»", async ({ page }) => {
  expect(await push(page, { kind: "kpin", name: "rust-blogs.kpin", text: kpin("valid.kpin") })).toBe(true);
  const d = dialog(page);
  await expect(d).toContainText("Rust blogs worth following");
  await expect(d).toContainText("Personal and team blogs about Rust");
  await expect(d).toContainText("Koona · CC0-1.0 · October 18, 2026 · rust-blogs.kpin");
  await expect(d.locator("[data-list-counts]")).toContainText("3 links · 2 feeds · 2 sections");
  await expect(d.getByLabel("Put links into")).toHaveValue("list");
  await expect(d).toContainText("New collection: Rust blogs worth following");
  await expect(d).toContainText("A collection with this name is reused.");
  await expect(d).toContainText("Collections are flat: sections become tags.");
  await expect(d).toContainText("Follow 2 new feeds");
  await expect(d).toContainText("Nothing is saved until you import.");
  await expect(d.getByRole("switch", { name: "Keep new links in Inbox" })).toHaveAttribute("aria-checked", "false");
  // 600 wide and 640 high at 1200×800: one box for every state.
  await page.waitForTimeout(300);
  const first = await box(page);
  expect([first.width, first.height]).toEqual([600, 640]);

  // The footer counts what will be imported: an unchecked feed is not followed.
  const run = d.getByRole("button", { name: "Import 3 links · 2 feeds" });
  await expect(run).toBeVisible();
  await d.locator("[data-list-feeds]").getByText("Without boats").click();
  await expect(d.getByRole("button", { name: "Import 3 links · 1 feed" })).toBeVisible();
  await d.getByRole("radio", { name: "Ignore" }).click();
  await d.getByRole("button", { name: "Import 3 links · 1 feed" }).click();

  await expect(d.getByRole("status")).toHaveText("List imported");
  await expect(d).toContainText("3 bookmarks added to Library");
  await expect(d.locator("[data-list-report]")).toContainText("Added3");
  await expect(d.locator("[data-list-report]")).toContainText("Feeds followed1");
  expect(await box(page)).toEqual(first);
  await d.getByRole("button", { name: "Show collection" }).click();
  await expect(d).toHaveCount(0);
  // The new collection is the section shown, with the list's links, which triage would name.
  await expect(page.getByRole("complementary").getByRole("button", { name: "Rust blogs worth following 3", exact: true })).toBeVisible();
  await expect(page.locator("[data-bookmark-id]", { hasText: "The Rustonomicon" })).toBeVisible();
  const imported = await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const page = await api.getBookmarks({ search: "Rustonomicon" });
    return page.items.map((b) => ({ source: b.source, name: b.source_name, tags: b.tags }));
  });
  expect(imported).toEqual([{ source: "list", name: "Rust blogs worth following", tags: ["unsafe", "book"] }]);

  // The same list again (the request was let go, so a new one is taken): only the unchecked feed is new.
  expect(await push(page, { kind: "kpin", name: "rust-blogs.kpin", text: kpin("valid.kpin") })).toBe(true);
  await expect(d.locator("[data-list-counts]")).toContainText("3 links already saved · 1 feed already followed");
  await expect(d).toContainText("Follow 1 new feed");
  await expect(d).toContainText("Collection: Rust blogs worth following (exists)");
  await d.getByRole("button", { name: "Import 1 feed" }).click();
  await expect(d.locator("[data-list-report]")).toContainText("Feeds followed1");
  await d.getByRole("button", { name: "Done" }).click();
  await expect(d).toHaveCount(0);
  // And once more: nothing new.
  expect(await push(page, { kind: "kpin", name: "rust-blogs.kpin", text: kpin("valid.kpin") })).toBe(true);
  await expect(d.getByRole("status")).toHaveText("Nothing new in this list");
  await expect(d).toContainText("Every link and feed of «Rust blogs worth following» is here already.");
  await expect(d).toContainText("3 links already saved");
  await d.locator("footer").getByRole("button", { name: "Close" }).click();
  await expect(d).toHaveCount(0);
});

test("a koonapin:// link asks first; Download fails with its reason, Try again shows the list", async ({ page }) => {
  await page.evaluate(async (text) => {
    const { api } = await import("/src/services/api.ts");
    const w = window as unknown as { downloads: string[] };
    w.downloads = [];
    let attempt = 0;
    api.downloadList = async (url: string) => {
      w.downloads.push(url);
      return attempt++ === 0 ? { outcome: "status", status: 404 } : { outcome: "done", text, url };
    };
  }, kpin("valid.kpin"));
  const url = "https://koona.app/pin/lists/rust-blogs.kpin";
  expect(await push(page, { kind: "kpin-url", url })).toBe(true);
  const d = dialog(page);
  await expect(d.getByRole("status")).toHaveText("Download a list from koona.app?");
  await expect(d.locator("[data-list-address]")).toHaveText(url);
  // Nothing went over the network before Download, and a second link is refused meanwhile.
  expect(await page.evaluate(() => (window as unknown as { downloads: string[] }).downloads)).toEqual([]);
  expect(await push(page, { kind: "kpin-url", url: "https://example.com/other.kpin" })).toBe(false);
  await page.waitForTimeout(300);
  const first = await box(page);

  await d.getByRole("button", { name: "Download" }).click();
  await expect(d.getByRole("status")).toHaveText("Couldn't download the list");
  await expect(d).toContainText("The server answered with error 404.");
  expect(await box(page)).toEqual(first);
  await d.getByRole("button", { name: "Try again" }).click();
  await expect(d).toContainText("Rust blogs worth following");
  await expect(d).toContainText("· koona.app");
  expect(await page.evaluate(() => (window as unknown as { downloads: string[] }).downloads)).toEqual([url, url]);
  // Escape lets the request go.
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
  expect(await push(page, { kind: "kpin-url", url })).toBe(true);
  await expect(d.getByRole("status")).toHaveText("Download a list from koona.app?");
  await d.getByRole("button", { name: "Cancel" }).click();
  await expect(d).toHaveCount(0);
});

test("a list from a newer format asks for an update; another app's list and a broken file are refused", async ({ page }) => {
  const d = dialog(page);
  await push(page, { kind: "kpin", name: "v2.kpin", text: kpin("version-2.kpin") });
  await expect(d.getByRole("status")).toHaveText("Update Koona Pin to open this list");
  await expect(d.locator("footer").getByRole("button", { name: "Close" })).toBeVisible();
  await d.getByRole("button", { name: "Check for updates" }).click();
  await expect(d).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();

  await push(page, { kind: "kpin", name: "other.kpin", text: kpin("other-app.kpin") });
  await expect(d.getByRole("status")).toHaveText("This list is for another Koona app");
  await expect(d.getByRole("button", { name: "Get it on koona.app" })).toBeVisible();
  await d.locator("footer").getByRole("button", { name: "Close" }).click();

  await push(page, { kind: "kpin", name: "cut.kpin", text: kpin("cut-off.kpin") });
  await expect(d.getByRole("status")).toHaveText("This file can't be imported");
  await expect(d).toContainText("It isn't a Koona list");
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
});

test("a newer 1.x list says what was skipped; «Import…» takes a .kpin to the list dialog", async ({ page }) => {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: /Browser bookmarks/ }).click();
  await page.locator("dialog input[type=file]").setInputFiles({ name: "newer.kpin", mimeType: "application/json", buffer: Buffer.from(kpin("unknown-type.kpin")) });
  const d = dialog(page);
  await expect(d).toContainText("From a newer writer");
  await expect(page.getByRole("dialog", { name: "Import bookmarks" })).toHaveCount(0);
  await expect(d.locator("[data-list-newer]")).toContainText("Made in a newer Koona Pin (list 1.1)");
  await expect(d.locator("[data-list-newer]")).toContainText("Skipped as unknown to this version: 1 item.");
  await d.getByRole("button", { name: "Cancel" }).click();
  await expect(d).toHaveCount(0);
});
