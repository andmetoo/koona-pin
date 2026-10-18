import { test, expect, type Page } from "@playwright/test";

// Adding a link (2026-10-16): «New link» in the sidebar and ⌘N open a glass sheet; ⌘V in the
// library and a link dropped on the window save at once; the sidebar's sections fold.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("fresh")) return;
    sessionStorage.setItem("fresh", "1");
    localStorage.removeItem("koonapin.demo.v4");
    localStorage.removeItem("koonapin.sidebar.collections");
    localStorage.removeItem("koonapin.sidebar.tags");
  });
  await page.goto("/");
  await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
});

const sidebar = (page: Page) => page.getByRole("complementary");
const nav = (page: Page, name: string) => sidebar(page).getByRole("button", { name, exact: true });
const sheet = (page: Page) => page.getByRole("dialog", { name: "Add link" });
const toast = (page: Page) => page.locator("[data-glass-toast]");
const card = (page: Page, text: string) => page.locator("[data-bookmark-id]", { hasText: text });

/** A paste on the page, as ⌘V with this text on the clipboard sends it. */
const paste = (page: Page, text: string) =>
  page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);

test("«New link» and ⌘N open the sheet; the toolbar has no Add", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
  await nav(page, "New link").click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByRole("textbox", { name: "Link" })).toBeFocused();
  await expect(sheet(page)).toContainText("Paste a link, or drop one on the window");
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  await expect(nav(page, "New link")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+n");
  await expect(sheet(page).getByRole("textbox", { name: "Link" })).toBeFocused();
  // The scrim closes it as Esc does.
  await page.mouse.click(1150, 700);
  await expect(sheet(page)).toHaveCount(0);

  // The strip of a narrow window: a round «+».
  await page.setViewportSize({ width: 800, height: 550 });
  const plus = sidebar(page).locator("[data-new-link]");
  await expect(plus).toHaveAttribute("aria-label", "New link");
  await plus.click();
  await expect(sheet(page)).toBeVisible();
});

test("the sheet saves to Library, Inbox and Reading, with a preview and the suggested collection", async ({ page }) => {
  // Two vitsoe.com pages in Design: a third is offered there.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const added = await api.addBookmark({ url: "https://vitsoe.com/rw/about/other" });
    await api.bulkUpdate([added.bookmark.id], { action: "move", collection_id: 1 });
  });
  await page.reload();
  await expect(nav(page, "Inbox 2")).toBeVisible();

  // Library: sorted at once, into the suggested collection.
  await nav(page, "New link").click();
  await sheet(page).getByRole("textbox", { name: "Link" }).fill("vitsoe.com/rw/about/third");
  const preview = sheet(page).locator("[data-add-preview=new]");
  await expect(preview).toContainText("vitsoe.com/rw/about/third");
  const design = sheet(page).getByRole("button", { name: "Design", exact: true });
  await expect(design).toHaveAttribute("aria-pressed", "true");
  await expect(design).toHaveAttribute("data-suggested", "true");
  await expect(sheet(page).getByRole("button", { name: "Library", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Enter");
  await expect(sheet(page)).toHaveCount(0);
  await expect(toast(page)).toContainText("Saved to Design");
  // It lands first, with the ink ring.
  await expect(page.locator("[data-bookmark-id]").first()).toContainText("vitsoe.com");
  await expect(page.locator("[data-bookmark-id]").first()).toHaveAttribute("data-fresh", "true");
  await expect(nav(page, "Inbox 2")).toBeVisible();
  await expect(nav(page, "Design 4")).toBeVisible();

  // Inbox: waiting there, without a collection.
  await nav(page, "New link").click();
  await sheet(page).getByRole("textbox", { name: "Link" }).fill("https://example.com/later");
  await sheet(page).getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(sheet(page).getByRole("button", { name: "Design", exact: true })).toBeDisabled();
  await sheet(page).getByRole("button", { name: "Save link" }).click();
  await expect(toast(page)).toContainText("Saved to Inbox");
  await expect(nav(page, "Inbox 3")).toBeVisible();

  // Reading: sorted and in Reading, with a title and a tag.
  await nav(page, "New link").click();
  await sheet(page).getByRole("textbox", { name: "Link" }).fill("https://example.com/article");
  await sheet(page).getByRole("button", { name: "Reading", exact: true }).click();
  await sheet(page).getByRole("button", { name: "Title and tags" }).click();
  await sheet(page).getByLabel("Title", { exact: true }).fill("A long read");
  await sheet(page).getByLabel("Tags", { exact: true }).fill("longread");
  await sheet(page).getByLabel("Tags", { exact: true }).press("Enter");
  await sheet(page).getByRole("button", { name: "Save link" }).click();
  await expect(toast(page)).toContainText("Saved to Reading");
  await expect(nav(page, "Inbox 3")).toBeVisible();
  await nav(page, "Reading 4").click();
  await expect(card(page, "A long read")).toBeVisible();
});

test("the sheet: a link that is not one, a link already saved and «Show it»", async ({ page }) => {
  await nav(page, "New link").click();
  const field = sheet(page).getByRole("textbox", { name: "Link" });
  await field.fill("not a link");
  await expect(sheet(page)).toContainText("That doesn’t look like a link yet");
  await sheet(page).getByRole("button", { name: "Save link" }).click();
  await expect(sheet(page).getByRole("alert")).toHaveText("That doesn't look like a link.");
  await field.fill("ftp://example.com/file");
  await expect(sheet(page).getByRole("alert")).toHaveCount(0);
  await sheet(page).getByRole("button", { name: "Save link" }).click();
  await expect(sheet(page).getByRole("alert")).toHaveText("Only http:// and https:// links can be saved.");

  // Already in the library: the sheet says so before saving, and shows it.
  await field.fill("https://www.vitsoe.com/rw/about/good-design/");
  const existing = sheet(page).locator("[data-add-preview=existing]");
  await expect(existing).toContainText("Ten principles for good design");
  await expect(existing).toContainText("Already in your library");
  await existing.getByRole("button", { name: "Show it" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Ten principles for good design");
});

test("⌘V in the library saves a link at once; Undo takes it away; text and fields are left alone", async ({ page }) => {
  const count = await page.locator("[data-bookmark-id]").count();
  await paste(page, "https://example.com/pasted");
  await expect(toast(page)).toContainText("Saved to Library");
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(count + 1);
  await expect(page.locator("[data-bookmark-id]").first()).toContainText("example.com");
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toContainText("Link removed");
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(count);
  await expect(nav(page, "Trash 0")).toBeVisible();

  // Not a link, or into a field: nothing saved.
  await paste(page, "just some words");
  await page.getByRole("textbox", { name: "Search the library" }).focus();
  await page.getByRole("textbox", { name: "Search the library" }).evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/plain", "https://example.com/into-the-field");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(count);

  // In the inbox it waits there.
  await nav(page, "Inbox 2").click();
  await page.locator("main, body").first().click({ position: { x: 700, y: 20 } });
  await paste(page, "https://example.com/for-later");
  await expect(toast(page)).toContainText("Saved to Inbox");
  await expect(nav(page, "Inbox 3")).toBeVisible();

  // A link already there: nothing changes, and it can be shown.
  await paste(page, "https://example.com/for-later");
  await expect(toast(page)).toContainText("This link is already in the library; nothing changed");
  await expect(nav(page, "Inbox 3")).toBeVisible();
});

test("a link dragged over the window frosts it; dropped, it is saved, with Shift into the inbox; a file asks to be imported", async ({ page }) => {
  const drag = (type: "dragenter" | "dragover" | "dragleave" | "drop", init: { link?: string; file?: boolean; shift?: boolean } = {}) =>
    page.evaluate(
      ({ type, init }) => {
        const data = new DataTransfer();
        if (init.link) {
          data.setData("text/uri-list", init.link);
          data.setData("text/plain", init.link);
        }
        if (init.file) data.items.add(new File(["x"], "notes.txt", { type: "text/plain" }));
        document.body.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true, shiftKey: !!init.shift }));
      },
      { type, init },
    );
  const veil = page.locator("[data-drop-veil]");
  await drag("dragenter", { link: "https://example.com/dropped" });
  await expect(veil).toBeVisible();
  await expect(veil).toContainText("Drop to save the link");
  await expect(veil).toContainText("It goes to Library; hold Shift to send it to Inbox");
  await drag("dragover", { link: "https://example.com/dropped", shift: true });
  await expect(veil).toContainText("It goes to Inbox");
  await drag("drop", { link: "https://example.com/dropped" });
  await expect(veil).toHaveCount(0);
  await expect(toast(page)).toContainText("Saved to Library");
  await expect(page.locator("[data-bookmark-id]").first()).toContainText("example.com");

  await drag("dragenter", { link: "https://example.com/dropped-later" });
  await drag("drop", { link: "https://example.com/dropped-later", shift: true });
  await expect(toast(page)).toContainText("Saved to Inbox");
  await expect(nav(page, "Inbox 3")).toBeVisible();

  // Leaving the window takes the veil away; a file gets the import veil, not the link's (NP-139).
  await drag("dragenter", { link: "https://example.com/away" });
  await expect(veil).toBeVisible();
  await drag("dragleave");
  await expect(veil).toHaveCount(0);
  await drag("dragenter", { file: true });
  await expect(veil).toHaveAttribute("data-drop-veil", "import");
  await drag("dragleave");
  await expect(veil).toHaveCount(0);
});

/**
 * A drag of files, as a webview shows it. `real`: as a drag from the system looks before the
 * drop in WebKit, WebView2 and Chromium, with `files` empty and no name; otherwise a DataTransfer
 * made by a script, which shows the files.
 */
const dragFiles = (page: Page, type: "dragenter" | "dragleave" | "drop", files: { name: string; text?: string }[], real = false) =>
  page.evaluate(
    ({ type, files, real }) => {
      const data = new DataTransfer();
      for (const file of files) data.items.add(new File([file.text ?? "x"], file.name));
      const event = new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true });
      if (real) {
        const hidden = { types: ["Files"], files: [], items: [{ kind: "file", type: "" }], dropEffect: "none" };
        Object.defineProperty(event, "dataTransfer", { value: hidden });
      }
      document.body.dispatchEvent(event);
    },
    { type, files, real },
  );

const OPML = '<?xml version="1.0"?><opml version="2.0"><body><outline text="A" xmlUrl="https://example.org/a.xml"/><outline text="B" xmlUrl="https://example.org/b.xml"/></body></opml>';

test("a file dragged over the window: the import veil, generic as real drags show it, with the name where the webview gives it", async ({ page }) => {
  const veil = page.locator("[data-drop-veil]");
  // Real use: no name before the drop, so the generic line.
  await dragFiles(page, "dragenter", [{ name: "rust-blogs.kpin" }], true);
  await expect(veil).toHaveAttribute("data-drop-veil", "import");
  await expect(veil).toContainText("Drop to import");
  await expect(veil).toContainText("Koona Pin imports .kpin lists, OPML and bookmarks files");
  await dragFiles(page, "dragleave", [], true);
  await expect(veil).toHaveCount(0);

  // Progressive enhancement: a DataTransfer that shows the file names it and its kind (frame K4).
  await dragFiles(page, "dragenter", [{ name: "rust-blogs.kpin" }]);
  await expect(veil).toContainText("rust-blogs.kpin · a list of links and feeds");
  await expect(veil).toContainText("Also .opml feeds and bookmarks .html");
  await dragFiles(page, "dragleave", []);
  await dragFiles(page, "dragenter", [{ name: "feeds.opml" }]);
  await expect(veil).toContainText("feeds.opml · feeds in OPML");
  await dragFiles(page, "dragleave", []);
  await dragFiles(page, "dragenter", [{ name: "notes.txt" }]);
  await expect(veil).toContainText("This file can’t be imported");
  await expect(veil).toContainText("Koona Pin imports .kpin lists, OPML and bookmarks files");
  await dragFiles(page, "dragleave", []);
  await expect(veil).toHaveCount(0);
});

test("a dropped file: a .kpin list opens its dialog, OPML and bookmarks open their import, others are refused", async ({ page }) => {
  const drop = async (files: { name: string; text?: string }[]) => {
    await dragFiles(page, "dragenter", files);
    await dragFiles(page, "drop", files);
  };
  const veil = page.locator("[data-drop-veil]");
  const alert = (text: string) => page.getByRole("alert").filter({ hasText: text });
  await drop([{ name: "notes.txt" }]);
  await expect(veil).toHaveCount(0);
  await expect(alert("Koona Pin imports .kpin lists, OPML and bookmarks files")).toBeVisible();

  // A list opens the list dialog (NP-138); a file dragged over it is not taken, and another list
  // while it is open is refused (said aloud: lists.spec.ts).
  await drop([{ name: "x.kpin", text: "{}" }]);
  const list = page.getByRole("dialog", { name: "Import list" });
  await expect(list).toContainText("This file can't be imported");
  await dragFiles(page, "dragenter", [{ name: "y.kpin", text: "{}" }]);
  await page.waitForTimeout(200);
  await expect(veil).toHaveCount(0);
  const pushed = await page.evaluate(async () => {
    const { openRequests } = await import("/src/services/openRequests.ts");
    return openRequests.push({ kind: "kpin-url", url: "https://example.com/y.kpin" });
  });
  expect(pushed).toBe(false);
  await expect(list).toContainText("This file can't be imported");
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);

  // OPML opens its own import.
  await drop([{ name: "feeds.opml", text: OPML }]);
  const dialog = page.getByRole("dialog", { name: "Import feeds" });
  await expect(dialog).toContainText("feeds.opml");
  await expect(dialog).toContainText("2 feeds");
  // A file dragged over an open dialog is not taken.
  await dragFiles(page, "dragenter", [{ name: "other.opml", text: OPML }]);
  await page.waitForTimeout(200);
  await expect(veil).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Several files: the first is taken, and that is said.
  const bookmarks = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><A HREF="https://example.org/dropped">Dropped</A></DL>';
  await drop([{ name: "bookmarks.html", text: bookmarks }, { name: "feeds.opml", text: OPML }]);
  const bookmarksDialog = page.getByRole("dialog", { name: "Import bookmarks" });
  await expect(bookmarksDialog).toContainText("bookmarks.html");
  await expect(bookmarksDialog).toContainText("1 link");
  await expect(page.getByText("One file at a time: only bookmarks.html is imported")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bookmarksDialog).toHaveCount(0);
});

test("a dropped file leaves with its dialog: «Import feeds (OPML)…» opened later starts empty", async ({ page }) => {
  await dragFiles(page, "dragenter", [{ name: "feeds.opml", text: OPML }]);
  await dragFiles(page, "drop", [{ name: "feeds.opml", text: OPML }]);
  const dialog = page.getByRole("dialog", { name: "Import feeds" });
  await expect(dialog).toContainText("feeds.opml");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Import feeds (OPML)…" }).click();
  await expect(dialog).toContainText("Feeds file .opml");
  await expect(dialog).not.toContainText("feeds.opml");
});

test("Collections and Tags fold, show their count, are remembered, and «+» opens the folded section", async ({ page }) => {
  const collections = sidebar(page).getByRole("button", { name: /^Collections/ });
  const tags = sidebar(page).getByRole("button", { name: /^Tags/ });
  await expect(collections).toHaveAttribute("aria-expanded", "true");
  await collections.click();
  await expect(collections).toHaveAttribute("aria-expanded", "false");
  await expect(collections).toHaveText(/Collections\s*4/);
  await expect(nav(page, "Design 2")).toBeHidden();
  // The keyboard folds the tags.
  await tags.focus();
  await page.keyboard.press("Enter");
  await expect(tags).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar(page).getByRole("button", { name: "design", exact: true })).toBeHidden();

  await page.reload();
  await expect(collections).toHaveAttribute("aria-expanded", "false");
  await expect(tags).toHaveAttribute("aria-expanded", "false");
  await tags.click();
  await expect(sidebar(page).getByRole("button", { name: "design", exact: true })).toBeVisible();

  // «+» of a folded section opens it first.
  await sidebar(page).getByRole("button", { name: "New collection", exact: true }).click();
  await expect(collections).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(nav(page, "Design 2")).toBeVisible();

  // Dragging the selection over a folded header opens it for the drag; the drop works.
  await collections.click();
  await expect(nav(page, "Design 2")).toBeHidden();
  const first = page.locator("[data-bookmark-id]").nth(3);
  await first.click({ modifiers: ["ControlOrMeta"] });
  const box = (await first.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 60, { steps: 4 });
  const header = (await collections.boundingBox())!;
  await page.mouse.move(header.x + 20, header.y + header.height / 2, { steps: 6 });
  await expect(nav(page, "Design 2")).toBeVisible({ timeout: 2000 });
  const design = (await nav(page, "Design 2").boundingBox())!;
  await page.mouse.move(design.x + 30, design.y + design.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(nav(page, "Design 3")).toBeVisible();
  // The drag is over: the section folds again, as the person left it.
  await expect(collections).toHaveAttribute("aria-expanded", "false");
});
