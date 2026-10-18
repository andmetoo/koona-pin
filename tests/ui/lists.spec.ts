import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dropPoint, openApp } from "../fixtures/app";

// The list dialog (NP-138, frames K10a, K10b and K3) in the browser preview: a list request goes
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

/** The groups' names as their headers show them, and the rows' badges. */
const groupNames = (d: ReturnType<typeof dialog>) => d.locator("[data-list-group]").evaluateAll((all) => all.map((g) => g.getAttribute("data-list-group")));
const row = (d: ReturnType<typeof dialog>, text: string) => d.locator("[data-list-row]", { hasText: text });

/** `import_list` recorded instead of run: what each choice sends. */
const recordImports = (page: Page) =>
  page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const w = window as unknown as { imports: unknown[] };
    w.imports = [];
    api.importList = async (_text, options) => {
      w.imports.push(options);
      return { added: 0, already_saved: 0, in_trash: 0, repeated: 0, not_web: 0, invalid: 0, skipped_items: 0, feeds_followed: 0, feeds_already: 0, collection_id: null };
    };
  });
const imports = (page: Page) => page.evaluate(() => (window as unknown as { imports: Record<string, unknown>[] }).imports);

test("a list: the preview (K10), Accept, the report, then «Show collection»", async ({ page }) => {
  expect(await push(page, { kind: "kpin", name: "rust-blogs.kpin", text: kpin("valid.kpin") })).toBe(true);
  const d = dialog(page);
  const head = d.locator("[data-list-head]");
  await expect(head).toContainText("Rust blogs worth following");
  await expect(head).toContainText("Personal and team blogs about Rust");
  await expect(head).toContainText("by Koona · Oct 18, 2026 · rust-blogs.kpin");
  await expect(d.locator("[data-list-counts]")).toHaveText("3 links · 2 feeds · 2 sections — 3 new");
  // The header is at most 110 px at 1200×800 in English. As decided, that is the frame's header
  // block, `[data-list-head]`: the Dialog's «IMPORT LIST» and «×» row above it is not counted.
  expect((await head.boundingBox())!.height).toBeLessThanOrEqual(110);
  // The top level and each section, with the tag a section becomes; new rows have no badge.
  expect(await groupNames(d)).toEqual(["Links", "Compiler and language", "Async"]);
  await expect(d.locator("[data-list-group='Compiler and language']")).toContainText("→ tag compiler and language");
  await expect(d.locator("[data-list-group='Async']")).toContainText("→ tag async");
  await expect(d.locator("[data-list-group='Links'] [data-list-tag]")).toHaveCount(0);
  await expect(d.locator("[data-list-badge]")).toHaveCount(0);
  await expect(d.getByLabel("Put links into")).toHaveValue("list");
  const options = await d.getByLabel("Put links into").locator("option").allTextContents();
  expect(options[0]).toBe("New collection: Rust blogs worth following");
  expect(options).toContain("Design");
  expect(options.slice(-2)).toEqual(["No collection", "No collection, no section tags"]);
  await expect(d.getByRole("checkbox", { name: "Keep new in Inbox" })).not.toBeChecked();
  await expect(d.locator("footer")).toContainText("3 links and 2 feeds will be added.");
  // 600 wide and 640 high at 1200×800: one box for every state.
  await page.waitForTimeout(300);
  const first = await box(page);
  expect([first.width, first.height]).toEqual([600, 640]);

  // An unchecked feed is not followed.
  await row(d, "Without boats").getByRole("checkbox").uncheck();
  await expect(d.locator("footer")).toContainText("3 links and 1 feed will be added.");
  await d.getByRole("button", { name: "Accept" }).click();

  await expect(d.getByRole("status")).toHaveText("List imported");
  await expect(d).toContainText("3 bookmarks added to Library");
  await expect(d.locator("[data-list-report]")).toContainText("Added3");
  await expect(d.locator("[data-list-report]")).toContainText("Feeds followed1");
  expect(await box(page)).toEqual(first);
  await d.getByRole("button", { name: "Show collection" }).click();
  await expect(d).toHaveCount(0);
  // The new collection is the section shown, with the list's links, tagged by their sections.
  await expect(page.getByRole("complementary").getByRole("button", { name: "Rust blogs worth following 3", exact: true })).toBeVisible();
  await expect(page.locator("[data-bookmark-id]", { hasText: "The Rustonomicon" })).toBeVisible();
  const imported = await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const page = await api.getBookmarks({ search: "Rustonomicon" });
    return page.items.map((b) => ({ source: b.source, name: b.source_name, tags: b.tags }));
  });
  expect(imported).toEqual([{ source: "list", name: "Rust blogs worth following", tags: ["unsafe", "book", "compiler and language"] }]);

  // The same list again: Saved on the links, Following on the followed feed, a checkbox on the other.
  expect(await push(page, { kind: "kpin", name: "rust-blogs.kpin", text: kpin("valid.kpin") })).toBe(true);
  await expect(d.locator("[data-list-counts]")).toHaveText("3 links · 2 feeds · 2 sections — 0 new, 3 saved");
  await expect(d.locator("[data-list-badge]")).toHaveText(["Saved", "Following", "Saved", "Saved"]);
  await expect(row(d, "Rust Blog").getByRole("checkbox")).toHaveCount(0);
  await expect(row(d, "Without boats").getByRole("checkbox")).toBeChecked();
  await expect(d.getByLabel("Put links into")).toContainText("Collection: Rust blogs worth following (exists)");
  await expect(d.locator("footer")).toContainText("1 feed will be added.");
  await d.getByRole("button", { name: "Accept" }).click();
  await expect(d.locator("[data-list-report]")).toContainText("Feeds followed1");
  await d.getByRole("button", { name: "Done" }).click();
  await expect(d).toHaveCount(0);

  // A link in the Trash says so; with nothing new the footer only closes.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const [tokio] = (await api.getBookmarks({ search: "Tokio" })).items;
    await api.trashBookmark(tokio.id);
  });
  expect(await push(page, { kind: "kpin", name: "rust-blogs.kpin", text: kpin("valid.kpin") })).toBe(true);
  await expect(d.locator("[data-list-counts]")).toHaveText("3 links · 2 feeds · 2 sections — 0 new, 2 saved, 1 in Trash");
  await expect(row(d, "Tokio").locator("[data-list-badge]")).toHaveText("In Trash");
  await expect(d.locator("[data-list-badge]")).toHaveText(["Saved", "Following", "Saved", "In Trash", "Following"]);
  await expect(d.locator("footer [role=status]")).toHaveText("Everything in this list is already here.");
  await expect(d.locator("footer").getByRole("button")).toHaveText(["Close"]);
  await expect(d.locator("[data-list-choices]")).toHaveCount(0);
  // A dialog of its own, after its 200 ms appearance: the same box.
  await page.waitForTimeout(300);
  expect(await box(page)).toEqual(first);
  await d.locator("footer").getByRole("button", { name: "Close" }).click();
  await expect(d).toHaveCount(0);
});

test("each «Put links into» option reaches import_list; saved links are always left", async ({ page }) => {
  await recordImports(page);
  const d = dialog(page);
  const choose = async (label: string | null) => {
    expect(await push(page, { kind: "kpin", name: "rust-blogs.kpin", text: kpin("valid.kpin") })).toBe(true);
    if (label) await d.getByLabel("Put links into").selectOption({ label });
    await d.getByRole("button", { name: "Accept" }).click();
    await d.getByRole("button", { name: "Done" }).click();
    await expect(d).toHaveCount(0);
  };
  await choose(null);
  await choose("Design");
  await choose("No collection");
  await choose("No collection, no section tags");
  const design = await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    return (await api.getCollections()).find((c) => c.name === "Design")!.id;
  });
  const options = await imports(page);
  expect(options.map((o) => [o.collection, o.sections_as_tags, o.existing_links])).toEqual([
    [{ kind: "new", name: "Rust blogs worth following" }, true, "leave"],
    [{ kind: "existing", id: design }, true, "leave"],
    [{ kind: "none" }, true, "leave"],
    [{ kind: "none" }, false, "leave"],
  ]);
  // «Keep new in Inbox» goes along.
  expect(await push(page, { kind: "kpin", name: "rust-blogs.kpin", text: kpin("valid.kpin") })).toBe(true);
  await d.getByRole("checkbox", { name: "Keep new in Inbox" }).check();
  await d.getByLabel("Put links into").selectOption({ label: "No collection, no section tags" });
  // Without section tags the headers no longer promise one.
  await expect(d.locator("[data-list-tag]")).toHaveCount(0);
  await d.getByRole("button", { name: "Accept" }).click();
  expect((await imports(page)).at(-1)).toMatchObject({ to_inbox: true, sections_as_tags: false });
});

test("«Follow all» is on, off or mixed; the feeds checked are the feeds followed", async ({ page }) => {
  await recordImports(page);
  const feeds = JSON.stringify({
    format: "koona",
    app: "pin",
    kind: "list",
    version: "1.0",
    title: "Rust feeds",
    sections: [
      {
        name: "Feeds",
        items: [
          { type: "feed", url: "https://blog.rust-lang.org/feed.xml", title: "Rust Blog" },
          { type: "feed", url: "https://without.boats/index.xml", title: "Without boats" },
          { type: "feed", url: "https://fasterthanli.me/index.xml", title: "fasterthanlime" },
        ],
      },
    ],
  });
  expect(await push(page, { kind: "kpin", name: "rust-feeds.kpin", text: feeds })).toBe(true);
  const d = dialog(page);
  const all = d.getByRole("checkbox", { name: "Follow all" });
  await expect(all).toBeChecked();
  await expect(d.locator("[data-list-group='Feeds'] [data-list-tag]")).toHaveCount(0);
  await expect(d.locator("footer")).toContainText("3 feeds will be added.");
  await row(d, "Without boats").getByRole("checkbox").uncheck();
  await expect(all).toBeChecked({ indeterminate: true });
  await expect(d.locator("footer")).toContainText("2 feeds will be added.");
  // Mixed → all.
  await all.click();
  await expect(all).toBeChecked();
  await expect(row(d, "Without boats").getByRole("checkbox")).toBeChecked();
  // All → none: nothing would be added, so Accept waits.
  await all.click();
  await expect(all).not.toBeChecked();
  await expect(d.locator("footer")).toContainText("Nothing is saved until you accept.");
  await expect(d.getByRole("button", { name: "Accept" })).toBeDisabled();
  await row(d, "fasterthanlime").getByRole("checkbox").check();
  await expect(all).toBeChecked({ indeterminate: true });
  await d.getByRole("button", { name: "Accept" }).click();
  expect((await imports(page)).at(-1)).toMatchObject({ follow_feeds: ["https://fasterthanli.me/index.xml"], existing_links: "leave" });
});

test("feeds outside any section are a «Feeds» group with «Follow all», alone or after links", async ({ page }) => {
  await recordImports(page);
  const d = dialog(page);
  const list = (items: unknown[]) => JSON.stringify({ format: "koona", app: "pin", kind: "list", version: "1.0", title: "Loose feeds", items });
  const feeds = [
    { type: "feed", url: "https://blog.rust-lang.org/feed.xml", title: "Rust Blog" },
    { type: "feed", url: "https://without.boats/index.xml", title: "Without boats" },
  ];
  expect(await push(page, { kind: "kpin", name: "loose.kpin", text: list(feeds) })).toBe(true);
  await expect(d.locator("[data-list-group=Feeds]")).toBeVisible();
  expect(await groupNames(d)).toEqual(["Feeds"]);
  const all = d.getByRole("checkbox", { name: "Follow all" });
  await expect(all).toBeChecked();
  await all.click();
  await expect(d.getByRole("button", { name: "Accept" })).toBeDisabled();
  await row(d, "Without boats").getByRole("checkbox").check();
  await expect(all).toBeChecked({ indeterminate: true });
  await d.getByRole("button", { name: "Accept" }).click();
  expect((await imports(page)).at(-1)).toMatchObject({ follow_feeds: ["https://without.boats/index.xml"] });
  await d.getByRole("button", { name: "Done" }).click();

  // With links at the top level: the links under «Links», the feeds apart under «Feeds».
  expect(await push(page, { kind: "kpin", name: "loose.kpin", text: list([feeds[0], { type: "link", url: "https://tokio.rs/", title: "Tokio" }, feeds[1]]) })).toBe(true);
  await expect(d.locator("[data-list-group=Links]")).toBeVisible();
  expect(await groupNames(d)).toEqual(["Links", "Feeds"]);
  await expect(d.locator("[data-list-group=Links]")).not.toContainText("Follow all");
  await expect(d.locator("[data-list-group=Feeds]").getByRole("checkbox", { name: "Follow all" })).toBeChecked();
  await d.getByRole("button", { name: "Cancel" }).click();
  await expect(d).toHaveCount(0);
});

test("a list of 5,000 items scrolls in one virtualised list: groups fold, few rows are drawn", async ({ page }) => {
  expect(await push(page, { kind: "kpin", name: "max-items.kpin", text: kpin("max-items.kpin") })).toBe(true);
  const d = dialog(page);
  await expect(d.locator("[data-list-counts]")).toContainText("4,900 links · 100 feeds · 13 sections");
  const rows = d.locator("[data-list-rows]");
  // Each group over 8 rows shows 5, then «Show N more».
  await d.getByRole("button", { name: "Show 95 more" }).first().click();
  // The button goes; focus moves to the first row it showed, not to the page.
  await expect(row(d, "A loose link, number 5")).toBeFocused();
  await expect(row(d, "A loose link, number 99")).toHaveCount(0);
  await rows.evaluate((list) => list.scrollBy(0, 2000));
  await expect(row(d, "A loose link, number 60")).toBeVisible();
  // To the end: the feeds, folded too, with «Follow all».
  await rows.evaluate((list) => (list.scrollTop = list.scrollHeight));
  await expect(d.getByRole("checkbox", { name: "Follow all" })).toBeVisible();
  expect(await d.locator("[data-list-row]").count()).toBeLessThan(100);
  // Only the rows scroll: the dialog and its footer stay.
  await expect(d.getByRole("button", { name: "Accept" })).toBeInViewport();
  await d.getByRole("button", { name: "Cancel" }).click();
  await expect(d).toHaveCount(0);
});

/** A `.kpin` dropped on the list area, as a webview delivers it. */
const dropList = async (page: Page) => {
  const at = await dropPoint(page);
  await page.evaluate((at) => {
    for (const type of ["dragenter", "drop"]) {
      const data = new DataTransfer();
      data.items.add(new File(["{}"], "other.kpin"));
      const event = new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true, clientX: at.x, clientY: at.y });
      (document.elementFromPoint(at.x, at.y) ?? document.body).dispatchEvent(event);
    }
  }, at);
};
const busyAlert = (page: Page) => page.locator("[role=alert]", { hasText: "Another import is open — finish it first" });

test("an open list dialog refuses another list in every state, aloud; an import cannot be stopped", async ({ page }) => {
  const d = dialog(page);
  // While the preview shows, another list is refused and the dialog keeps what was chosen.
  expect(await push(page, { kind: "kpin", name: "rust-blogs.kpin", text: kpin("valid.kpin") })).toBe(true);
  await expect(d).toContainText("Rust blogs worth following");
  await d.getByLabel("Put links into").selectOption({ label: "No collection" });
  expect(await push(page, { kind: "kpin", name: "v2.kpin", text: kpin("version-2.kpin") })).toBe(false);
  await dropList(page);
  await expect(busyAlert(page)).toHaveCount(1);
  await expect(d).toContainText("Rust blogs worth following");
  await expect(d.getByLabel("Put links into")).toHaveValue("none");

  // The import waits for the test to let it finish.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const w = window as unknown as { finish: () => void };
    const real = api.importList.bind(api);
    api.importList = (text, options) => new Promise((resolve, reject) => (w.finish = () => void real(text, options).then(resolve, reject)));
  });
  await d.getByRole("button", { name: "Accept" }).click();
  await expect(d.getByRole("status")).toHaveText("Importing the list…");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await expect(d.getByRole("status")).toHaveText("Importing the list…");
  await expect(d.getByRole("button", { name: "Close" })).toBeDisabled();
  // Another list meanwhile is refused, and a dropped one is refused aloud.
  expect(await push(page, { kind: "kpin-url", url: "https://example.com/other.kpin" })).toBe(false);
  await dropList(page);
  await expect(busyAlert(page)).toHaveCount(1);
  await page.evaluate(() => (window as unknown as { finish: () => void }).finish());
  await expect(d.getByRole("status")).toHaveText("List imported");
  // The report too: a list is refused until the dialog is closed.
  expect(await push(page, { kind: "kpin-url", url: "https://example.com/other.kpin" })).toBe(false);
  await expect(d.getByRole("status")).toHaveText("List imported");
  await page.keyboard.press("Escape");
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
  // Nothing went over the network before Download.
  expect(await page.evaluate(() => (window as unknown as { downloads: string[] }).downloads)).toEqual([]);
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

test("a newer 1.x list says what was skipped; «Import a file…» takes a list to the list dialog", async ({ page }) => {
  await page.getByRole("button", { name: "More", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: /^Import a file…/ }).click();
  // By content: a list named otherwise is a list.
  await (await chooser).setFiles({ name: "newer.json", mimeType: "application/json", buffer: Buffer.from(kpin("unknown-type.kpin")) });
  const d = dialog(page);
  await expect(d).toContainText("From a newer writer");
  await expect(page.getByRole("dialog", { name: "Import bookmarks" })).toHaveCount(0);
  await expect(d.locator("[data-list-newer]")).toContainText("Made in a newer Koona Pin (list 1.1)");
  await expect(d.locator("[data-list-newer]")).toContainText("Skipped as unknown to this version: 1 item.");
  // The counts name only what there is, and the unknown item is among the skipped.
  await expect(d.locator("[data-list-counts]")).toHaveText("1 link · 1 feed — 1 new, 1 skipped");
  await d.getByRole("button", { name: "Cancel" }).click();
  await expect(d).toHaveCount(0);

  // An item of an unknown type is skipped in a 1.0 list too.
  const list = (version: string, sections: unknown[], items: unknown[]) =>
    JSON.stringify({ format: "koona", app: "pin", kind: "list", version, title: "Mixed", sections, items });
  await push(page, { kind: "kpin", name: "older.kpin", text: list("1.0", [], [{ type: "link", url: "https://example.com/older" }, { type: "note", text: "x" }]) });
  await expect(d.locator("[data-list-counts]")).toHaveText("1 link — 1 new, 1 skipped");
  await expect(d.locator("[data-list-newer]")).toHaveCount(0);
  await d.getByRole("button", { name: "Cancel" }).click();

  // A section of feeds alone becomes no tag: its header promises none.
  await push(page, {
    kind: "kpin",
    name: "feeds-section.kpin",
    text: list("1.0", [{ name: "Feeds", items: [{ type: "feed", url: "https://example.com/feed.xml" }] }], [{ type: "link", url: "https://example.com/plain" }]),
  });
  await expect(d.locator("[data-list-counts]")).toHaveText("1 link · 1 feed · 1 section — 1 new");
  await expect(d.locator("[data-list-group=Feeds]")).toBeVisible();
  await expect(d.locator("[data-list-tag]")).toHaveCount(0);
  await d.getByRole("button", { name: "Cancel" }).click();
  await expect(d).toHaveCount(0);
});
