import { test, expect, Page, Locator } from "@playwright/test";

// NP-123 (Р-69, points 4–6): a click selects, the link lives in the title and thumbnail of a row
// and on the corner buttons of a card, Space reads the selection in a sheet over the list.

const TITLES = [
  "Ten principles for good design",
  "The architecture of silence",
  "Typography is a voice",
  "Interfaces that stay out of the way",
  "Noticing the everyday",
  "Notes on attention",
];

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.removeItem("koonapin.demo.v4");
    localStorage.removeItem("koonapin.openLinks");
    localStorage.setItem("koonapin.view", "grid");
  });
  await page.reload();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
  // The browser is a list of addresses: nothing leaves the test.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    (window as unknown as { opened: string[] }).opened = [];
    api.openUrl = async (url: string) => void (window as unknown as { opened: string[] }).opened.push(url);
  });
});

const opened = (page: Page) => page.evaluate(() => (window as unknown as { opened: string[] }).opened);
const urlOf = (card: Locator) => card.evaluate(async (el) => {
  const { api } = await import("/src/services/api.ts");
  return (await api.getBookmarks()).items.find((b) => b.id === Number((el as HTMLElement).dataset.bookmarkId))!.url;
});
const card = (page: Page, title: string) =>
  page.locator("article[data-bookmark-id]").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
/** A plain spot of a card or row: a card's title, a row's collection. */
const spot = (c: Locator) => c.locator("[data-collection], h2:not(:has(a))").first();
const bar = (page: Page) => page.getByRole("toolbar", { name: "Selected bookmarks" });
const sheet = (page: Page) => page.locator("dialog[data-reading-sheet]");
const announcer = (page: Page) => page.locator("[data-announcer]");
const toList = async (page: Page) => {
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator("[data-view=list]")).toBeVisible();
};

test("the bar is icons at every width, each named with its key by its hint; no line of keys under it (#319)", async ({ page }) => {
  await spot(card(page, TITLES[0])).click();
  await expect(bar(page).getByRole("status")).toHaveText("1 selected");
  const buttons = bar(page).getByRole("button");
  const names = ["Read", "Move to…", "Tag", "Favorite", "Send to Reading", "Refresh previews", "Export", "Trash", "Clear selection"];
  await expect(buttons).toHaveCount(names.length);
  for (const [i, name] of names.entries()) {
    const button = buttons.nth(i);
    await expect(button).toHaveAccessibleName(name);
    // Only the icon on the bar: the words are in the hint.
    await expect(button).toHaveText("");
  }
  await expect(buttons.nth(0)).toHaveAttribute("aria-keyshortcuts", "Space");
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  await expect(buttons.nth(7)).toHaveAttribute("aria-keyshortcuts", mac ? "Backspace Meta+Backspace Delete" : "Delete");
  await expect(buttons.nth(8)).toHaveAttribute("aria-keyshortcuts", "Escape");
  await expect(bar(page).getByRole("tooltip").filter({ hasText: "Trash" })).toHaveText(mac ? "Trash⌫" : "TrashDel");
  await expect(page.getByText(/click — add/)).toHaveCount(0);
});

test("on a Mac ⌫ and ⌘⌫ trash the selection and, in the trash, delete it forever; fields, dialogs and the sheet keep ⌫ (#297)", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
  await page.reload();
  const cards = page.locator("[data-bookmark-id]");
  await expect(cards).toHaveCount(6);
  await spot(card(page, TITLES[0])).click();
  const trash = bar(page).getByRole("button", { name: "Trash" });
  await expect(trash).toHaveAttribute("aria-keyshortcuts", "Backspace Meta+Backspace Delete");
  await trash.hover();
  await expect(bar(page).getByRole("tooltip").filter({ hasText: "Trash" })).toHaveText("Trash⌫");
  await page.mouse.move(5, 895);

  // A field's ⌫ is the field's.
  const search = page.getByRole("textbox", { name: "Search the library" });
  await search.focus();
  await page.keyboard.type("x");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Meta+Backspace");
  await expect(search).toHaveValue("");
  await search.blur();
  await expect(cards).toHaveCount(6);
  // The sheet is a layer: ⌫ there leaves the selection alone.
  await page.keyboard.press(" ");
  await expect(sheet(page)).toBeVisible();
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  await expect(cards).toHaveCount(6);

  // ⌫ and Finder's ⌘⌫: to the trash.
  await page.keyboard.press("Backspace");
  await expect(card(page, TITLES[0])).toHaveCount(0);
  await spot(card(page, TITLES[1])).click();
  await page.keyboard.press("Meta+Backspace");
  await expect(card(page, TITLES[1])).toHaveCount(0);
  await expect(cards).toHaveCount(4);

  // In the trash, the dialog to delete for good; ⌫ in the dialog doesn't open another.
  await page.getByRole("button", { name: /^Trash/ }).click();
  await expect(cards).toHaveCount(2);
  await spot(card(page, TITLES[0])).click();
  await page.keyboard.press("Backspace");
  const dialog = page.getByRole("dialog", { name: "Delete forever?" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Backspace");
  await expect(page.getByRole("dialog", { name: "Delete forever?" })).toHaveCount(1);
  await dialog.getByRole("button", { name: "Delete forever" }).click();
  await expect(cards).toHaveCount(1);
});

test("a click selects and never opens; focus and selection look different and are announced (NP-123)", async ({ page }) => {
  const popups: unknown[] = [];
  page.on("popup", (popup) => popups.push(popup));
  const silence = card(page, TITLES[1]);
  const voice = card(page, TITLES[2]);

  // The title, the cover below the shutter, the empty part of the domain line: each selects.
  await spot(silence).click();
  await expect(silence).toHaveAttribute("data-selected", "true");
  await expect(bar(page).getByRole("status")).toHaveText("1 selected");
  await voice.locator("[data-preview]").click({ position: { x: 30, y: 140 } });
  await expect(voice).toHaveAttribute("data-selected", "true");
  await expect(silence).not.toHaveAttribute("data-selected");
  expect(await opened(page)).toEqual([]);
  expect(popups).toHaveLength(0);
  // No checkbox any more.
  await expect(page.getByRole("checkbox")).toHaveCount(0);

  // Said to a screen reader: the card's description, and the live region on every click.
  await expect(voice).toHaveAccessibleName(TITLES[2]);
  await expect(voice).toHaveAccessibleDescription("Selected");
  await expect(silence).not.toHaveAccessibleDescription("Selected");
  await expect(announcer(page)).toHaveAttribute("aria-live", "polite");
  await expect(announcer(page)).toHaveText(`${TITLES[2]}: selected`);
  await spot(silence).click({ modifiers: ["ControlOrMeta"] });
  await expect(announcer(page)).toHaveText(`${TITLES[1]}: selected`);
  await spot(silence).click({ modifiers: ["ControlOrMeta"] });
  await expect(announcer(page)).toHaveText(`${TITLES[1]}: not selected`);

  // Focus from the keyboard: an ink ring around the whole card; the selection: the preview sunk into glass, a check.
  const third = card(page, TITLES[3]);
  await third.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(third).toBeFocused();
  await expect(third).toHaveCSS("outline-style", "solid");
  await expect(third).toHaveCSS("outline-color", "rgb(46, 48, 43)");
  await expect(third).toHaveCSS("outline-offset", "4px");
  const ring = voice.locator("[data-ring]");
  await expect(ring).toHaveCSS("outline-style", "none");
  await expect(voice.locator("[data-preview]")).toHaveCSS("transform", "matrix(0.9, 0, 0, 0.9, 0, 0)");
  await expect(voice.locator(".card-halo")).toHaveCSS("opacity", "1");
  await expect(voice.locator(".card-check")).toHaveCSS("opacity", "1");
  await expect(voice).toHaveCSS("outline-style", "none");
  // The copy behind exists only for the selected: thousands of cards keep no blur.
  await expect(page.locator(".card-halo")).toHaveCount(1);
  await expect(third.locator("[data-preview]")).toHaveCSS("transform", "none");
  await expect(third).not.toHaveAttribute("data-selected");
  await page.screenshot({ path: "test-results/np123-focus-and-selection-grid.png" });

  // The list: selected — accent border and soft fill; focused — the ink ring.
  await toList(page);
  const row = card(page, TITLES[2]);
  await expect(row).toHaveAttribute("data-selected", "true");
  await expect(row).toHaveCSS("border-top-color", "rgb(47, 107, 79)");
  await expect(row).toHaveCSS("background-color", "rgb(226, 238, 230)");
  const other = card(page, TITLES[4]);
  await other.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(other).toBeFocused();
  await expect(other).toHaveCSS("outline-color", "rgb(46, 48, 43)");
  await expect(other).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await page.screenshot({ path: "test-results/np123-focus-and-selection-list.png" });

  // Several selected: a press on one without moving selects it alone; the drag needs more than 4 px.
  await spot(card(page, TITLES[0])).click({ modifiers: ["ControlOrMeta"] });
  await spot(card(page, TITLES[5])).click({ modifiers: ["ControlOrMeta"] });
  await expect(bar(page).getByRole("status")).toHaveText("3 selected");
  const box = (await spot(card(page, TITLES[0])).boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + 12, box.y + 6);
  await page.mouse.up();
  await expect(bar(page).getByRole("status")).toHaveText("1 selected");
  await expect(card(page, TITLES[0])).toHaveAttribute("data-selected", "true");
  expect(await opened(page)).toEqual([]);
  await expect(page.locator("[data-drag-stack]")).toHaveCount(0);
});

test("arrows move the selection between cards and rows; a focused selected card has one ring (#319)", async ({ page }) => {
  const cards = page.locator("article[data-bookmark-id]");
  const selected = page.locator("article[data-bookmark-id][data-selected]");
  const columns = await page.locator("[data-view=grid] .grid").first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  expect(columns).toBeGreaterThan(1);
  expect(columns).toBeLessThan(6);

  await spot(cards.nth(0)).click();
  await page.keyboard.press("ArrowRight");
  await expect(selected).toHaveCount(1);
  await expect(cards.nth(1)).toHaveAttribute("data-selected", "true");
  await expect(cards.nth(1)).toBeFocused();
  // One ring: the ink one of focus around the whole card, none around its cover; the glass says selected.
  await expect(cards.nth(1)).toHaveCSS("outline-color", "rgb(46, 48, 43)");
  await expect(cards.nth(1).locator("[data-ring]")).toHaveCSS("outline-style", "none");
  await expect(announcer(page)).toHaveText(/: selected$/);
  await page.keyboard.press("ArrowLeft");
  await expect(cards.nth(0)).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(cards.nth(0)).toHaveAttribute("data-selected", "true");
  // ↓ a row down, ↑ back.
  await page.keyboard.press("ArrowDown");
  await expect(cards.nth(columns)).toHaveAttribute("data-selected", "true");
  await expect(selected).toHaveCount(1);
  await page.keyboard.press("ArrowUp");
  await expect(cards.nth(0)).toHaveAttribute("data-selected", "true");
  // Shift adds the range, as Shift+click does.
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(selected).toHaveCount(3);
  await expect(bar(page).getByRole("status")).toHaveText("3 selected");
  // Space still reads, Esc still clears.
  await page.keyboard.press(" ");
  await expect(sheet(page)).toBeVisible();
  // The sheet keeps its arrows: the selection under it does not move.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  await expect(selected).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(selected).toHaveCount(0);

  // The list: ↓ ↑ by a row; ← → do nothing there.
  await toList(page);
  const rows = page.locator("article[data-bookmark-id]");
  await spot(rows.nth(0)).click();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toHaveAttribute("data-selected", "true");
  await expect(rows.nth(1)).toBeFocused();
  // The selected border thickened in place, no ink ring beside it.
  await expect(rows.nth(1)).toHaveCSS("outline-color", "rgb(47, 107, 79)");
  await expect(rows.nth(1)).toHaveCSS("outline-offset", "-1px");
  await page.keyboard.press("ArrowRight");
  await expect(rows.nth(1)).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("ArrowUp");
  await expect(rows.nth(0)).toHaveAttribute("data-selected", "true");

  // A text field keeps its arrows.
  const search = page.getByRole("textbox", { name: "Search the library" });
  await search.focus();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(0)).toHaveAttribute("data-selected", "true");
});

test("the corner buttons of a card: hover fades them in, keyboard focus shows them, Tab walks Open and Read (NP-123)", async ({ page }) => {
  const voice = card(page, TITLES[2]);
  const shutter = voice.locator("[data-shutter]");
  const openButton = shutter.getByRole("button", { name: `Open in browser: ${TITLES[2]}` });
  // Three round glass buttons in the top-right corner of the cover, hidden until the card is hovered.
  await expect(shutter.locator(".card-action")).toHaveCount(3);
  await expect(openButton).toHaveCSS("opacity", "0");
  await expect(openButton).toHaveCSS("pointer-events", "none");
  await expect(openButton).toHaveCSS("width", "32px");
  await expect(openButton).toHaveCSS("border-radius", "9999px");
  const cover = (await voice.locator("[data-preview]").boundingBox())!;
  await voice.locator("[data-preview]").hover();
  await expect(openButton).toHaveCSS("opacity", "1");
  await expect(openButton).toHaveCSS("cursor", "pointer");
  const more = (await shutter.getByRole("button", { name: `Actions: ${TITLES[2]}` }).boundingBox())!;
  expect(Math.round(cover.x + cover.width - (more.x + more.width))).toBe(9);
  expect(Math.round(more.y - cover.y)).toBe(9);
  // Words live in hints: «Read» with its key.
  await shutter.getByRole("button", { name: `Read here: ${TITLES[2]}` }).hover();
  await expect(shutter.getByRole("tooltip").filter({ hasText: "Read" })).toHaveCSS("opacity", "1");
  await expect(shutter.getByRole("button", { name: `Read here: ${TITLES[2]}` })).toHaveAttribute("aria-keyshortcuts", "Space");
  await page.screenshot({ path: "test-results/np123-shutter-hover.png" });

  // «↗ Open» goes to the browser and selects nothing.
  await shutter.getByRole("button", { name: `Open in browser: ${TITLES[2]}` }).click();
  expect(await opened(page)).toEqual([await urlOf(voice)]);
  await expect(page.locator("[data-selected]")).toHaveCount(0);

  // «Read» opens the sheet over the list.
  await shutter.getByRole("button", { name: `Read here: ${TITLES[2]}` }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByRole("heading", { level: 1 })).toHaveText(TITLES[2]);
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);

  // From the keyboard: the focused card shows its shutter, Tab walks its two buttons, then its menu.
  await page.mouse.move(5, 895);
  const notes = card(page, TITLES[5]);
  const notesShutter = notes.locator("[data-shutter]");
  await card(page, TITLES[4]).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  const notesOpen = notesShutter.getByRole("button", { name: `Open in browser: ${TITLES[5]}` });
  await expect(notesOpen).toHaveCSS("opacity", "0");
  await card(page, TITLES[4]).locator("button").last().focus();
  await page.keyboard.press("Tab");
  await expect(notes).toBeFocused();
  await expect(notesOpen).toHaveCSS("opacity", "1");
  await page.keyboard.press("Tab");
  await expect(notesOpen).toBeFocused();
  await expect(notesOpen).toHaveCSS("opacity", "1");
  await page.keyboard.press("Tab");
  await expect(notesShutter.getByRole("button", { name: `Read here: ${TITLES[5]}` })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(notesShutter.getByRole("button", { name: `Actions: ${TITLES[5]}` })).toBeFocused();
  await page.screenshot({ path: "test-results/np123-shutter-keyboard.png" });
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(sheet(page).getByRole("heading", { level: 1 })).toHaveText(TITLES[5]);
  await page.keyboard.press("Escape");
  await expect(notesShutter.getByRole("button", { name: `Read here: ${TITLES[5]}` })).toBeFocused();

  // In the trash the shutter offers the browser and «Restore», no reading.
  await spot(notes).click();
  await page.keyboard.press("Delete");
  await page.getByRole("button", { name: /^Trash/ }).click();
  const trashed = card(page, TITLES[5]);
  await expect(trashed.locator("[data-shutter]").getByRole("button", { name: "Restore" })).toHaveCount(1);
  await expect(trashed.locator("[data-shutter]").getByRole("button", { name: /^Read here/ })).toHaveCount(0);
  await trashed.focus();
  await page.keyboard.press(" ");
  await expect(sheet(page)).toHaveCount(0);
});

test("the links of a row: title and thumbnail with ↗; double-click and Enter follow «Open links» (NP-123)", async ({ page }) => {
  await toList(page);
  const row = card(page, TITLES[1]);
  const url = await urlOf(row);
  const title = row.getByRole("link", { name: TITLES[1], exact: true });
  const thumbnail = row.getByRole("link", { name: `Open: ${TITLES[1]}` });
  const arrow = title.locator("svg");

  // Pointer, underline and ↗ under the pointer.
  await expect(arrow).toHaveCSS("opacity", "0");
  await title.hover();
  await expect(title).toHaveCSS("cursor", "pointer");
  await expect(title).toHaveCSS("text-decoration-line", "underline");
  await expect(arrow).toHaveCSS("opacity", "1");
  await expect(thumbnail).toHaveCSS("cursor", "pointer");
  await page.screenshot({ path: "test-results/np123-row-link.png" });

  // The title and the thumbnail open; they do not select.
  await title.click();
  await thumbnail.click();
  expect(await opened(page)).toEqual([url, url]);
  await expect(page.locator("[data-selected]")).toHaveCount(0);
  // Ctrl+click on the title selects instead of opening.
  await title.click({ modifiers: ["ControlOrMeta"] });
  await expect(row).toHaveAttribute("data-selected", "true");
  expect(await opened(page)).toHaveLength(2);

  // A double-click on the rest of the row opens it in the browser; so does Enter on the focused row.
  await spot(row).dblclick();
  expect(await opened(page)).toEqual([url, url, url]);
  await expect(row).toHaveAttribute("data-selected", "true");
  await row.focus();
  await page.keyboard.press("Enter");
  expect(await opened(page)).toHaveLength(4);
  // A double-click on the title opens the page once, not twice.
  await title.dblclick();
  expect(await opened(page)).toHaveLength(5);
  // In the grid as well.
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await spot(card(page, TITLES[3])).dblclick();
  expect((await opened(page)).at(-1)).toBe(await urlOf(card(page, TITLES[3])));

  // «Open links: In reading mode» (the setting comes with NP-124): the same gestures read in the app, no ↗.
  await page.evaluate(() => localStorage.setItem("koonapin.openLinks", "reader"));
  await page.reload();
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    (window as unknown as { opened: string[] }).opened = [];
    api.openUrl = async (url: string) => void (window as unknown as { opened: string[] }).opened.push(url);
  });
  // NP-122: «in reading mode» is the mode itself, at that bookmark; Esc twice comes back.
  const article = page.locator("[data-reading-mode] .reader-title");
  const leave = async () => {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-reading-mode]")).toHaveCount(0);
  };
  await spot(card(page, TITLES[3])).dblclick();
  await expect(article).toHaveText(TITLES[3]);
  await leave();
  await card(page, TITLES[3]).focus();
  await page.keyboard.press("Enter");
  await expect(article).toHaveText(TITLES[3]);
  await leave();
  await toList(page);
  await expect(card(page, TITLES[1]).getByRole("link", { name: TITLES[1], exact: true }).locator("svg")).toHaveCount(0);
  await card(page, TITLES[1]).getByRole("link", { name: TITLES[1], exact: true }).click();
  await expect(article).toHaveText(TITLES[1]);
  await leave();
  // «↗ Open» of the shutter is always the browser.
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await card(page, TITLES[3]).locator("[data-preview]").hover();
  await card(page, TITLES[3]).getByRole("button", { name: `Open in browser: ${TITLES[3]}` }).click();
  expect(await opened(page)).toEqual([await urlOf(card(page, TITLES[3]))]);
});

test("Space reads the selection in a sheet over the list; ↑/↓ go through it, Esc closes and keeps it (NP-123)", async ({ page }) => {
  await toList(page);
  // Selected in this order; the last clicked is the second in the list.
  await spot(card(page, TITLES[0])).click();
  await spot(card(page, TITLES[3])).click({ modifiers: ["ControlOrMeta"] });
  await spot(card(page, TITLES[1])).click({ modifiers: ["ControlOrMeta"] });
  await expect(bar(page).getByRole("status")).toHaveText("3 selected");
  // «Read · Space» comes first on the bar: the book, named with its key by its hint.
  await expect(bar(page).getByRole("button").first()).toHaveAccessibleName("Read");
  await expect(bar(page).getByRole("button").first()).toHaveAttribute("aria-keyshortcuts", "Space");

  await page.mouse.move(5, 895);
  await page.keyboard.press(" ");
  const s = sheet(page);
  const heading = s.getByRole("heading", { level: 1 });
  await expect(s).toBeVisible();
  await expect(heading).toHaveText(TITLES[1]);
  await expect(s.locator("[data-reader-position]")).toHaveText("↑ ↓2 of 3");
  await expect(s.getByRole("button", { name: /Back to All bookmarks$/ })).toBeVisible();
  // Over the list: the sheet is 760 px wide, the list stays under the scrim.
  const panel = (await s.locator(":scope > div").first().boundingBox())!;
  expect(Math.round(panel.width)).toBe(760);
  await expect(s.locator(".reader-body")).toContainText("is the page this bookmark was saved from");
  await page.screenshot({ path: "test-results/np123-sheet.png" });

  await page.keyboard.press("ArrowDown");
  await expect(heading).toHaveText(TITLES[3]);
  await expect(s.locator("[data-reader-position]")).toHaveText("↑ ↓3 of 3");
  await page.keyboard.press("ArrowDown");
  await expect(heading).toHaveText(TITLES[3]);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(heading).toHaveText(TITLES[0]);
  await expect(s.locator("[data-reader-position]")).toHaveText("↑ ↓1 of 3");

  // «Open in browser» and the heart act on the bookmark shown.
  await s.getByRole("button", { name: "Open in browser" }).click();
  expect(await opened(page)).toEqual([await urlOf(card(page, TITLES[0]))]);
  const heart = s.getByRole("button", { name: /favorites$/ });
  const pressed = await heart.getAttribute("aria-pressed");
  await heart.click();
  await expect(heart).toHaveAttribute("aria-pressed", pressed === "true" ? "false" : "true");

  // Esc closes the sheet only: the selection stays, and Space opens the one read last.
  await page.keyboard.press("Escape");
  await expect(s).toHaveCount(0);
  await expect(bar(page).getByRole("status")).toHaveText("3 selected");
  await page.keyboard.press(" ");
  await expect(heading).toHaveText(TITLES[0]);
  // A click beside the sheet closes it too.
  await page.mouse.click(60, 450);
  await expect(s).toHaveCount(0);
  // «Read» of the bar does what Space does.
  await bar(page).getByRole("button", { name: /^Read/ }).first().click();
  await expect(heading).toHaveText(TITLES[0]);
  await page.keyboard.press("Escape");

  // One selected: no position, ↓ scrolls the article instead of moving.
  await spot(card(page, TITLES[4])).click();
  await page.keyboard.press(" ");
  await expect(heading).toHaveText(TITLES[4]);
  await expect(s.locator("[data-reader-position]")).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await expect(heading).toHaveText(TITLES[4]);
  await page.keyboard.press("Escape");

  // A focused button keeps Space for itself; a text field too.
  await page.getByRole("textbox", { name: "Search the library" }).focus();
  await page.keyboard.press(" ");
  await expect(s).toHaveCount(0);
});

test("the sheet: a page that cannot be read offers the browser; progress is saved at most every 2 s and on close (NP-123)", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 550 });
  await page.clock.install();
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const w = window as unknown as { saved: number[] };
    w.saved = [];
    const original = api.setReadingProgress;
    api.setReadingProgress = async (id: number, progress: number) => {
      w.saved.push(Math.round(progress * 100) / 100);
      return original(id, progress);
    };
    const fetch = api.fetchReaderPage;
    api.fetchReaderPage = async (url: string) => (url.includes("linear") ? { kind: "status", url, status: 403 } : fetch(url));
  });
  const saved = () => page.evaluate(() => (window as unknown as { saved: number[] }).saved);

  // A 403: the failure card says why and offers the browser.
  await card(page, TITLES[3]).locator("[data-preview]").hover();
  await card(page, TITLES[3]).getByRole("button", { name: /^Read here/ }).click();
  const s = sheet(page);
  await expect(s.locator("[data-reader-failure]")).toContainText("This page can’t be shown here");
  await expect(s.locator("[data-reader-failure]")).toContainText("The site answered with error 403");
  await page.screenshot({ path: "test-results/np123-sheet-failure.png" });
  await s.locator("[data-reader-failure]").getByRole("button", { name: "Open in browser" }).click();
  expect(await opened(page)).toEqual([await urlOf(card(page, TITLES[3]))]);
  await page.keyboard.press("Escape");
  expect(await saved()).toEqual([]);

  // Scrolling writes at once, then waits two seconds between writes; closing writes the last.
  // The clock stands still between steps: only runFor moves it.
  await page.clock.pauseAt(Date.now() + 60_000);
  await card(page, TITLES[1]).locator("[data-preview]").hover();
  await card(page, TITLES[1]).getByRole("button", { name: /^Read here/ }).click();
  const scroller = s.locator("[data-reader-scroll]");
  await expect(s.locator(".reader-body")).toBeVisible();
  const scrollTo = (share: number) => scroller.evaluate((el, share) => el.scrollTo({ top: share * (el.scrollHeight - el.clientHeight) }), share);
  await scrollTo(0.3);
  await expect.poll(saved).toEqual([0.3]);
  await scrollTo(0.5);
  await scrollTo(0.6);
  // The scroll is handled (the bar shows it) before the clock moves.
  await expect(s.locator("[data-reading-progress]")).toHaveAttribute("style", "width: 60%;");
  expect(await saved()).toEqual([0.3]);
  await page.clock.runFor(2100);
  await expect.poll(saved).toEqual([0.3, 0.6]);
  // Back up: not unread.
  await scrollTo(0.2);
  await expect(s.locator("[data-reading-progress]")).toHaveAttribute("style", "width: 20%;");
  expect(await saved()).toEqual([0.3, 0.6]);
  // The end, within two seconds of the last write: it waits for the close.
  await scrollTo(1);
  expect(await saved()).toEqual([0.3, 0.6]);
  await expect(s.locator("[data-reading-progress]")).toHaveAttribute("style", "width: 100%;");
  await page.keyboard.press("Escape");
  await expect.poll(saved).toEqual([0.3, 0.6, 1]);
  // Read to the end: the card menu now offers «Mark as unread».
  await card(page, TITLES[1]).click({ button: "right", position: { x: 40, y: 150 } });
  await expect(page.getByRole("menuitem", { name: "Mark as unread" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Read to 40 % before (the sample library): the sheet opens where reading stopped.
  await card(page, TITLES[2]).locator("[data-preview]").hover();
  await card(page, TITLES[2]).getByRole("button", { name: /^Read here/ }).click();
  await expect(s.locator(".reader-body")).toBeVisible();
  await expect.poll(() => scroller.evaluate((el) => Math.round((el.scrollTop / (el.scrollHeight - el.clientHeight)) * 10) / 10)).toBe(0.4);
});

test("triage keeps Space for the browser (NP-123)", async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { opened: string[] }).opened = [];
    window.open = (url) => ((window as unknown as { opened: string[] }).opened.push(String(url)), null);
  });
  await page.locator("[data-notification-bell]").click();
  await page.getByRole("dialog", { name: "Notifications" }).getByRole("button", { name: "Sort", exact: true }).click();
  await expect(page.locator("[data-triage-card]")).toBeVisible();
  await page.keyboard.press("Space");
  expect(await opened(page)).toHaveLength(1);
  await expect(sheet(page)).toHaveCount(0);
});

/** Cards in the first row of the grid: the same top as the first card. */
async function firstRow(page: Page) {
  const tops = await page.locator("[data-bookmark-id]").evaluateAll((cards) => cards.map((c) => Math.round(c.getBoundingClientRect().top)));
  return tops.filter((top) => top === tops[0]).length;
}

test("the compact grid: smaller cards, more of them in a row, two even in a narrow window; the choice is kept", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect.poll(() => firstRow(page)).toBe(3);
  await page.getByRole("button", { name: "Compact grid", exact: true }).click();
  await expect(page.getByRole("button", { name: "Compact grid", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => firstRow(page)).toBe(4);
  // Two lines of 13 px for the title, the corner buttons a size smaller.
  const card = page.locator("[data-bookmark-id]").first();
  await expect(card.locator("h2")).toHaveCSS("font-size", "13px");
  await card.locator("[data-ring]").hover();
  await expect(card.locator(".card-action").first()).toHaveCSS("width", "28px");

  await page.setViewportSize({ width: 420, height: 800 });
  await expect.poll(() => firstRow(page)).toBe(2);
  await page.reload();
  await expect(page.getByRole("button", { name: "Compact grid", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("a click and Esc leave no ring of keyboard focus; an arrow brings it back", async ({ page }) => {
  const cards = page.locator("[data-bookmark-id]");
  await cards.nth(1).click({ position: { x: 20, y: 150 } });
  await expect(cards.nth(1)).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Escape");
  await expect(cards.nth(1)).not.toHaveAttribute("data-selected");
  await expect(cards.nth(1)).toBeFocused();
  await expect(cards.nth(1)).toHaveCSS("outline-style", "none");
  // The pointer leaves the card: its corner buttons go with it, focus does not bring them back.
  await page.mouse.move(5, 5);
  await expect(cards.nth(1).locator(".card-action").first()).toHaveCSS("opacity", "0");

  await page.keyboard.press("ArrowRight");
  await expect(cards.nth(2)).toBeFocused();
  await expect(cards.nth(2)).toHaveCSS("outline-style", "solid");
});
