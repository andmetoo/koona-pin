import { test, expect, type Page } from "@playwright/test";
import { dropPoint } from "../fixtures/app";

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

/** A drag from outside, dispatched where the pointer would be: by default over the list area. */
const dragAt = async (
  page: Page,
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  init: { link?: string; file?: boolean; shift?: boolean } = {},
  where: "list" | "sidebar" | "toolbar" | "zero" = "list",
) => {
  // "zero": as WebKitGTK and WebView2 may give a drop, with no coordinates.
  const at = where === "zero" ? { x: 0, y: 0 } : await dropPoint(page, where);
  return page.evaluate(
    ({ type, init, at }) => {
      const data = new DataTransfer();
      if (init.link) {
        data.setData("text/uri-list", init.link);
        data.setData("text/plain", init.link);
      }
      if (init.file) data.items.add(new File(["x"], "notes.txt", { type: "text/plain" }));
      const event = new DragEvent(type, { bubbles: true, cancelable: true, shiftKey: !!init.shift, clientX: at.x, clientY: at.y });
      // A script's DataTransfer keeps its dropEffect; this one tells what the app set, if anything.
      const seen = { types: data.types, files: data.files, items: data.items, getData: (f: string) => data.getData(f), dropEffect: "unset" };
      Object.defineProperty(event, "dataTransfer", { value: seen });
      (document.elementFromPoint(at.x, at.y) ?? document.body).dispatchEvent(event);
      return seen.dropEffect;
    },
    { type, init, at },
  );
};

test("a link dragged over the window shows the drop zone; dropped, it is saved, with Shift into the inbox; a file gets the zone's hero", async ({ page }) => {
  const drag = (type: "dragenter" | "dragover" | "dragleave" | "drop", init: { link?: string; file?: boolean; shift?: boolean } = {}) =>
    dragAt(page, type, init);
  const zone = page.locator("[data-drop-zone]");
  await drag("dragenter", { link: "https://example.com/dropped" });
  await expect(zone).toBeVisible();
  await expect(zone).toHaveAttribute("data-drop-zone", "link");
  await expect(zone).toContainText("Drop to save the link");
  await expect(zone).toContainText("It goes to Library; hold Shift to send it to Inbox");
  // Said once through the live region.
  await expect(page.locator("[data-announcer]")).toHaveText("Drop to save the link. It goes to Library; hold Shift to send it to Inbox");
  await drag("dragover", { link: "https://example.com/dropped", shift: true });
  await expect(zone).toContainText("It goes to Inbox");
  await drag("drop", { link: "https://example.com/dropped" });
  await expect(zone).toHaveCount(0);
  await expect(toast(page)).toContainText("Saved to Library");
  await expect(page.locator("[data-bookmark-id]").first()).toContainText("example.com");

  await drag("dragenter", { link: "https://example.com/dropped-later" });
  await drag("drop", { link: "https://example.com/dropped-later", shift: true });
  await expect(toast(page)).toContainText("Saved to Inbox");
  await expect(nav(page, "Inbox 3")).toBeVisible();

  // Leaving the window takes the zone away; a file gets the import hero, not the link's (K9).
  await drag("dragenter", { link: "https://example.com/away" });
  await expect(zone).toBeVisible();
  await drag("dragleave");
  await expect(zone).toHaveCount(0);
  await drag("dragenter", { file: true });
  await expect(zone).toHaveAttribute("data-drop-zone", "hero");
  await drag("dragleave");
  await expect(zone).toHaveCount(0);
});

test("over the sidebar or the toolbar a drag from outside shows no zone and its drop does nothing", async ({ page }) => {
  const zone = page.locator("[data-drop-zone]");
  const cards = await page.locator("[data-bookmark-id]").count();
  const inbox = await sidebar(page).getByRole("button", { name: /^Inbox/ }).first().textContent();
  for (const where of ["sidebar", "toolbar"] as const) {
    expect(await dragAt(page, "dragenter", { link: "https://example.com/nowhere" }, where)).toBe("none");
    expect(await dragAt(page, "dragover", { link: "https://example.com/nowhere" }, where)).toBe("none");
    await expect(zone).toHaveCount(0);
    await dragAt(page, "drop", { link: "https://example.com/nowhere" }, where);
    expect(await dragFiles(page, "dragenter", [{ name: "feeds.opml", text: OPML }], false, where)).toBe("none");
    await expect(zone).toHaveCount(0);
    await dragFiles(page, "drop", [{ name: "feeds.opml", text: OPML }], false, where);
  }
  // A save would land within a frame or two: give it time, then nothing is in Library or Inbox.
  await page.waitForTimeout(400);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("[data-glass-toast]")).toHaveCount(0);
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(cards);
  await expect(sidebar(page).getByRole("button", { name: /^Inbox/ }).first()).toHaveText(inbox!);

  // From the sidebar into the list the zone shows; back over the sidebar it goes, with no leave in between.
  await dragAt(page, "dragenter", { link: "https://example.com/moving" }, "sidebar");
  await expect(zone).toHaveCount(0);
  expect(await dragAt(page, "dragover", { link: "https://example.com/moving" })).toBe("copy");
  await expect(zone).toHaveAttribute("data-drop-zone", "link");
  await dragAt(page, "dragover", { link: "https://example.com/moving" }, "sidebar");
  await expect(zone).toHaveCount(0);
  await dragAt(page, "dragleave", {}, "sidebar");

  // A drop that comes with no coordinates goes by where the last dragover was.
  await dragAt(page, "dragenter", { link: "https://example.com/zero" });
  await dragAt(page, "drop", { link: "https://example.com/zero" }, "zero");
  await expect(page.locator("[data-glass-toast]")).toContainText("Saved to Library");
  await dragAt(page, "dragenter", { link: "https://example.com/zero-off" }, "sidebar");
  await dragAt(page, "drop", { link: "https://example.com/zero-off" }, "zero");
  await page.waitForTimeout(400);
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(cards + 1);
});

test("at 800 × 550, beside the sidebar's strip, the zone covers the list and a drop there saves", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 550 });
  await expect(page.locator(".sidebar-strip")).toBeVisible();
  const zone = page.locator("[data-drop-zone]");
  await dragAt(page, "dragenter", { link: "https://example.com/small" }, "sidebar");
  await expect(zone).toHaveCount(0);
  await dragAt(page, "dragover", { link: "https://example.com/small" });
  await expect(zone).toBeVisible();
  const box = (await zone.locator(".drop-zone-card").boundingBox())!;
  const strip = (await page.locator(".sidebar-strip").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(strip.x + strip.width + 16);
  await expect(zone.locator(".drop-zone-words")).toBeInViewport({ ratio: 1 });
  await dragAt(page, "drop", { link: "https://example.com/small" });
  await expect(zone).toHaveCount(0);
  await expect(page.locator("[data-glass-toast]")).toContainText("Saved to Library");
});

/**
 * A drag of files, as a webview shows it. `real`: as a drag from the system looks before the
 * drop in WebKit, WebView2 and Chromium, with `files` empty and no name; otherwise a DataTransfer
 * made by a script, which shows the files.
 */
const dragFiles = async (
  page: Page,
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  files: { name: string; text?: string }[],
  real = false,
  where: "list" | "sidebar" | "toolbar" = "list",
) => {
  const at = await dropPoint(page, where);
  return page.evaluate(
    ({ type, files, real, at }) => {
      const data = new DataTransfer();
      for (const file of files) data.items.add(new File([file.text ?? "x"], file.name));
      const event = new DragEvent(type, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y });
      const hidden = { types: ["Files"], files: [], items: [{ kind: "file", type: "" }], dropEffect: "unset" };
      const seen = real ? hidden : { types: data.types, files: data.files, items: data.items, dropEffect: "unset" };
      Object.defineProperty(event, "dataTransfer", { value: seen });
      (document.elementFromPoint(at.x, at.y) ?? document.body).dispatchEvent(event);
      return seen.dropEffect;
    },
    { type, files, real, at },
  );
};

const OPML = '<?xml version="1.0"?><opml version="2.0"><body><outline text="A" xmlUrl="https://example.org/a.xml"/><outline text="B" xmlUrl="https://example.org/b.xml"/></body></opml>';
const LIST = '{"format":"koona","app":"pin","kind":"list","version":"1.0","title":"Dropped list","items":[{"type":"link","url":"https://example.org/dropped-list"}]}';
const BOOKMARKS = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><A HREF="https://example.org/dropped">Dropped</A></DL>';
const COPY = JSON.stringify({ format: "koona-pin", version: 1, exported_at: "2026-10-04T18:20:00.000Z", app_version: "0.1.0", collections: [], tags: [], bookmarks: [] });

test("a file dragged over the window: the hero, as real drags show it; the kind or a refusal where the webview gives the name", async ({ page }) => {
  const zone = page.locator("[data-drop-zone]");
  // Real use: no name before the drop, so the hero of K9a, in three lines.
  await dragFiles(page, "dragenter", [{ name: "rust-blogs.kpin" }], true);
  await expect(zone).toHaveAttribute("data-drop-zone", "hero");
  await expect(zone).toContainText("Drop anything here");
  await expect(zone).toContainText("Lists, feeds, bookmarks or a backup — Koona Pin works out what it is");
  await expect(zone).toContainText("Nothing is imported until you confirm");
  await expect(page.locator("[data-announcer]")).toContainText("Drop anything here");
  // The zone lies over the list area only, below the toolbar and beside the sidebar: the dashed card 16 px in from its every edge.
  const box = (await zone.locator(".drop-zone-card").boundingBox())!;
  const main = (await page.locator("main [data-drop-area]").boundingBox())!;
  const head = (await page.locator("main [data-drop-head]").boundingBox())!;
  const top = head.y + head.height;
  expect([box.x - main.x, box.y - top, main.x + main.width - box.x - box.width, main.y + main.height - box.y - box.height].map(Math.round)).toEqual([16, 16, 16, 16]);
  expect(box.x).toBeGreaterThan((await page.getByRole("complementary").first().boundingBox())!.width);
  await dragFiles(page, "dragleave", [], true);
  await expect(zone).toHaveCount(0);

  // Progressive enhancement: a DataTransfer that shows the file names it and its kind (K9b b).
  await dragFiles(page, "dragenter", [{ name: "rust-blogs.kpin" }]);
  await expect(zone).toHaveAttribute("data-drop-zone", "kind");
  await expect(zone).toContainText("Drop to import the list");
  await expect(zone).toContainText("rust-blogs.kpin");
  await expect(zone).toContainText("Nothing is imported until you confirm");
  await dragFiles(page, "dragleave", []);
  await dragFiles(page, "dragenter", [{ name: "feeds.opml" }]);
  await expect(zone).toContainText("Drop to import the feeds");
  await dragFiles(page, "dragleave", []);
  await dragFiles(page, "dragenter", [{ name: "koona-pin-2026-10-04.json" }]);
  // A .json may be a list or a full copy: by name it is neither, so the hero.
  await expect(zone).toHaveAttribute("data-drop-zone", "hero");
  await dragFiles(page, "dragleave", []);
  // Refused by name (K9b c); a .txt may still be OPML, so it gets the hero.
  await dragFiles(page, "dragenter", [{ name: "report.pdf" }]);
  await expect(zone).toHaveAttribute("data-drop-zone", "refused");
  await expect(zone).toContainText("Koona Pin can’t import this file");
  await expect(zone).toContainText("Koona Pin imports links, .kpin lists, OPML, bookmarks .html and Koona Pin backups");
  await dragFiles(page, "dragleave", []);
  await dragFiles(page, "dragenter", [{ name: "notes.txt" }]);
  await expect(zone).toHaveAttribute("data-drop-zone", "hero");
  await dragFiles(page, "dragleave", []);
  await expect(zone).toHaveCount(0);
});

test("a dropped file goes by what it holds: a list, OPML, bookmarks and a backup open their dialogs; others are refused", async ({ page }) => {
  const drop = async (files: { name: string; text?: string }[]) => {
    await dragFiles(page, "dragenter", files);
    await dragFiles(page, "drop", files);
  };
  const zone = page.locator("[data-drop-zone]");
  const alert = (text: string) => page.getByRole("alert").filter({ hasText: text });
  await drop([{ name: "report.pdf", text: "%PDF-1.7" }]);
  await expect(zone).toHaveCount(0);
  await expect(alert("Koona Pin imports links, .kpin lists, OPML, bookmarks .html and Koona Pin backups")).toBeVisible();
  // Other JSON is not ours, whatever its name.
  await drop([{ name: "data.kpin", text: '{"format":"other"}' }]);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A list opens the list dialog (NP-138), even named otherwise; a file dragged over it gets the
  // «Busy» zone, and a list dropped meanwhile is refused (said aloud: lists.spec.ts).
  await drop([{ name: "shared.json", text: LIST }]);
  const list = page.getByRole("dialog", { name: "Import list" });
  await expect(list).toContainText("Dropped list");
  await dragFiles(page, "dragenter", [{ name: "y.kpin", text: LIST }]);
  await expect(zone).toHaveAttribute("data-drop-zone", "busy");
  await expect(zone).toContainText("Finish the open import first");
  // Over the open dialog: the zone is in the top layer.
  expect(await zone.evaluate((el) => typeof el.showPopover !== "function" || el.matches(":popover-open"))).toBe(true);
  await dragFiles(page, "drop", [{ name: "y.kpin", text: LIST }]);
  await expect(zone).toHaveCount(0);
  await expect(alert("Another import is open — finish it first")).toBeVisible();
  await expect(list).toContainText("Dropped list");
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);

  // OPML opens its own import, named .txt too.
  await drop([{ name: "feeds.txt", text: OPML }]);
  const dialog = page.getByRole("dialog", { name: "Import feeds" });
  await expect(dialog).toContainText("feeds.txt");
  await expect(dialog).toContainText("2 feeds");
  // A file dragged over an open import is «Busy».
  await dragFiles(page, "dragenter", [{ name: "other.opml", text: OPML }]);
  await expect(zone).toHaveAttribute("data-drop-zone", "busy");
  await dragFiles(page, "dragleave", []);
  await expect(zone).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Several files: the first is taken, and that is said.
  await drop([{ name: "bookmarks.html", text: BOOKMARKS }, { name: "feeds.opml", text: OPML }]);
  const bookmarksDialog = page.getByRole("dialog", { name: "Import bookmarks" });
  await expect(bookmarksDialog).toContainText("bookmarks.html");
  await expect(bookmarksDialog).toContainText("1 link");
  await expect(page.getByText("One file at a time: only bookmarks.html is imported")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bookmarksDialog).toHaveCount(0);

  // A full copy opens Restore with the file checked, even named .kpin.
  await drop([{ name: "library.kpin", text: COPY }]);
  const restore = page.getByRole("dialog", { name: "Restore from a JSON copy" });
  await expect(restore).toContainText("library.kpin");
  await expect(restore).toContainText("0 bookmarks");
  await expect(restore.getByRole("button", { name: "Restore", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(restore).toHaveCount(0);

  // A list over 2 MB is too big; its cap is said.
  await drop([{ name: "huge.kpin", text: LIST.replace('"items"', `"description":"${"x".repeat(2 * 1024 * 1024)}","items"`) }]);
  await expect(alert("This file is over 2 MB, too big to import")).toBeVisible();
});

test("⋯ → «Import a file…» routes a picked file as a drop; a dropped file leaves with its dialog", async ({ page }) => {
  const more = page.getByRole("button", { name: "More", exact: true });
  await more.click();
  // One Import item (K5).
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: /^Import a file…/ })).toContainText("Lists, feeds, bookmarks or a backup");
  await expect(menu.getByRole("menuitem", { name: /Import feeds|Browser bookmarks|backup \(JSON\)/ })).toHaveCount(0);
  const pick = async (name: string, text: string) => {
    await more.click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: /^Import a file…/ }).click();
    await (await chooser).setFiles({ name, mimeType: "application/octet-stream", buffer: Buffer.from(text) });
  };
  await page.keyboard.press("Escape");

  await pick("subscriptions.xml", OPML);
  const feeds = page.getByRole("dialog", { name: "Import feeds" });
  await expect(feeds).toContainText("subscriptions.xml");
  await expect(feeds).toContainText("2 feeds");
  await page.keyboard.press("Escape");
  await pick("export.txt", BOOKMARKS);
  await expect(page.getByRole("dialog", { name: "Import bookmarks" })).toContainText("1 link");
  await page.keyboard.press("Escape");
  await pick("rust.kpin", LIST);
  await expect(page.getByRole("dialog", { name: "Import list" })).toContainText("Dropped list");
  await page.keyboard.press("Escape");
  await pick("koona-pin.json", COPY);
  await expect(page.getByRole("dialog", { name: "Restore from a JSON copy" })).toContainText("koona-pin.json");
  await page.keyboard.press("Escape");
  await pick("report.pdf", "%PDF-1.7");
  await expect(page.getByRole("alert").filter({ hasText: "Koona Pin imports links" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A dropped file belongs to its dialog: Settings → Feeds → Import… later starts empty.
  await dragFiles(page, "dragenter", [{ name: "feeds.opml", text: OPML }]);
  await dragFiles(page, "drop", [{ name: "feeds.opml", text: OPML }]);
  await expect(feeds).toContainText("feeds.opml");
  await page.keyboard.press("Escape");
  await expect(feeds).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Import…" }).click();
  await expect(feeds).toContainText("Feeds file .opml");
  await expect(feeds).not.toContainText("feeds.opml");
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
