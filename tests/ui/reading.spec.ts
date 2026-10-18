import { test, expect, Page } from "@playwright/test";
import { catalog, openApp, opened, stubBrowser, text } from "../fixtures/app";

// NP-122 (Р-69, point 1, frames R0, B1–B9): the reading mode drops from «Read», reads the queue
// one article after another and folds back into the library at the same place.

const mode = (page: Page) => page.locator("[data-reading-mode]");
const queue = (page: Page) => mode(page).locator("[data-reading-queue]");
const current = (page: Page) => queue(page).locator("[aria-selected=true]");
const heading = (page: Page) => mode(page).locator(".reader-title");
/** The toolbar's «Read»; the selection bar has one of its own. */
const readButton = (page: Page) => page.locator("button[data-read-mode]");

async function boot(
  page: Page,
  { width = 1440, height = 900, theme = "light", language = "en", view = "grid" }: { width?: number; height?: number; theme?: string; language?: string; view?: string } = {},
) {
  await openApp(page, { viewport: { width, height }, settings: { openLinks: null, theme, language, view } });
  await page.evaluate(() => document.fonts.ready);
  await stubBrowser(page);
}

/** Reading as in the mockups: more to read, two already read at the bottom. */
async function fillReading(page: Page) {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const more = (await api.getBookmarks()).items.filter((b) => !b.reading_at).slice(0, 3);
    await api.bulkUpdate(more.map((b) => b.id), { action: "reading", reading: true });
    await api.bulkUpdate(more.slice(0, 2).map((b) => b.id), { action: "read", read: true });
  });
}

/** Reading in its own order (NP-121): unread newest first, then the read. */
const readingList = (page: Page) =>
  page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    return (await api.getBookmarks({ onlyReading: true })).items.map((b) => ({ id: b.id, title: b.title, url: b.url, domain: b.domain, read: !!b.read_at }));
  });

/** Pages that never arrive, fail, or come from a computer without a connection. */
const stubPages = (page: Page, how: "hang" | "403" | "offline", match: string) =>
  page.evaluate(
    async ({ how, match }) => {
      const { api } = await import("/src/services/api.ts");
      const w = window as unknown as { fetchPage?: typeof api.fetchReaderPage };
      w.fetchPage ??= api.fetchReaderPage;
      const original = w.fetchPage;
      api.fetchReaderPage = async (url: string) => {
        if (!url.includes(match)) return original(url);
        if (how === "hang") return new Promise(() => {});
        if (how === "403") return { kind: "status", url, status: 403 };
        return { kind: "failed" };
      };
    },
    { how, match },
  );

test("«Read» drops the mode at the first unread of Reading; Esc twice returns to the same place (NP-122)", async ({ page }) => {
  await boot(page, { width: 1200, height: 520 });
  const list = await readingList(page);
  // The library as the person left it: a selection, scrolled down.
  const card = page.locator("[data-bookmark-id]").nth(4);
  await card.locator("h2").first().click();
  await expect(card).toHaveAttribute("data-selected", "true");
  const scroll = page.locator("[data-scroll=main]");
  await scroll.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  const top = await scroll.evaluate((el) => el.scrollTop);
  expect(top).toBeGreaterThan(0);

  const toolbar = await readButton(page).boundingBox();
  await readButton(page).click();
  await expect(mode(page)).toBeVisible();
  // The drop: a circle from the button, not a fade.
  await expect(mode(page)).toHaveAttribute("data-drop", "circle");
  await expect(current(page)).toContainText(list.find((b) => !b.read)!.title);
  await expect(heading(page)).toHaveText(list.find((b) => !b.read)!.title);
  // «Read» stays where it was: the mode's own, pressed, in the same place and size (owner, 2026-10-15).
  const pressed = mode(page).getByRole("button", { name: "Read", exact: true });
  await expect(pressed).toHaveAttribute("aria-pressed", "true");
  expect(await pressed.boundingBox()).toEqual(toolbar);
  // The library underneath takes no focus.
  expect(await page.evaluate(() => !!document.querySelector("main")?.closest("[inert]"))).toBe(true);
  // Once the drop is over the library is hidden: WKWebView paints a scroller's bar above a fixed layer.
  await expect(scroll).toHaveCSS("visibility", "hidden");

  await page.keyboard.press("Escape");
  await expect(current(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(mode(page)).toHaveCount(0);
  await expect(scroll).toHaveCSS("visibility", "visible");
  await expect(readButton(page)).toBeFocused();
  await expect(card).toHaveAttribute("data-selected", "true");
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(top);
  await expect(page.getByRole("toolbar", { name: "Selected bookmarks" })).toBeVisible();

  // «Read» in the mode leaves at once, folding back.
  await readButton(page).click();
  await mode(page).getByRole("button", { name: "Read", exact: true }).click();
  await expect(mode(page)).toHaveCount(0);
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(top);
});

test("keyboard only: open, J/K through the queue, O, the queue with arrows, leave (NP-122)", async ({ page }) => {
  await boot(page);
  await fillReading(page);
  const list = await readingList(page);
  // Tab from the search field in the toolbar to «Read».
  await page.keyboard.press("Control+K");
  for (let i = 0; i < 60; i++) {
    if (await readButton(page).evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(readButton(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(heading(page)).toHaveText(list[0].title);
  await expect(mode(page).locator("[data-reader-scroll]")).toBeFocused();

  await page.keyboard.press("j");
  await expect(heading(page)).toHaveText(list[1].title);
  await expect(current(page)).toContainText(list[1].title);
  // The Russian layout: J's key types «о», and it still means J.
  await page.evaluate(() =>
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "о", code: "KeyJ", bubbles: true, cancelable: true })),
  );
  await expect(heading(page)).toHaveText(list[2].title);
  await page.keyboard.press("k");
  await expect(heading(page)).toHaveText(list[1].title);
  await page.keyboard.press("o");
  expect(await opened(page)).toEqual([list[1].url]);

  // Esc: the queue, the current item focused; ↓ and Enter read another one.
  await page.keyboard.press("Escape");
  await expect(current(page)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(heading(page)).toHaveText(list[3].title);
  await expect(mode(page).locator("[data-reader-scroll]")).toBeFocused();
  // J in the queue moves the queue's focus with it.
  await page.keyboard.press("Escape");
  await page.keyboard.press("k");
  await expect(heading(page)).toHaveText(list[2].title);
  await expect(current(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(mode(page)).toHaveCount(0);
});

test("Tab goes between the queue and the article; arrows in the queue pick the article (#319)", async ({ page }) => {
  await boot(page);
  await fillReading(page);
  const list = await readingList(page);
  await readButton(page).click();
  const article = mode(page).locator("[data-reader-scroll]");
  await expect(heading(page)).toHaveText(list[0].title);
  await expect(article).toBeFocused();
  await expect(queue(page)).toContainText("Tab — queue, article");

  // Shift+Tab: the queue, at the current item; the queue is a list box with one stop for Tab.
  await page.keyboard.press("Shift+Tab");
  await expect(current(page)).toBeFocused();
  await expect(queue(page).getByRole("listbox")).toBeVisible();
  await expect(queue(page).locator("[data-queue-item][tabindex='0']")).toHaveCount(1);
  // ↓ reads the next one at once, the queue keeps focus.
  await page.keyboard.press("ArrowDown");
  await expect(heading(page)).toHaveText(list[1].title);
  await expect(current(page)).toContainText(list[1].title);
  await expect(current(page)).toBeFocused();
  await expect(queue(page).locator("[data-queue-item][tabindex='0']")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await expect(heading(page)).toHaveText(list[0].title);
  await page.keyboard.press("End");
  await expect(heading(page)).toHaveText(list[list.length - 1].title);
  await page.keyboard.press("Home");
  await expect(heading(page)).toHaveText(list[0].title);

  // Tab: the article, past the toolbar; its arrows scroll and pick nothing.
  await page.keyboard.press("Tab");
  await expect(article).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(heading(page)).toHaveText(list[0].title);
  // The ring of the region.
  expect(await article.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
  // J and Esc as before.
  await page.keyboard.press("j");
  await expect(heading(page)).toHaveText(list[1].title);
  await page.keyboard.press("Escape");
  await expect(current(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(mode(page)).toHaveCount(0);
});

test("the queue: read ones dimmed at the bottom, the switch reads the section, the end marks read (NP-122)", async ({ page }) => {
  await boot(page);
  await fillReading(page);
  const list = await readingList(page);
  await readButton(page).click();
  const items = queue(page).locator("[data-queue-item]");
  await expect(items).toHaveCount(list.length);
  await expect(items.last()).toHaveAttribute("data-read", "true");
  await expect(items.last()).toContainText("✓ Read");
  await expect(queue(page).locator("[data-reading-summary]")).toHaveText("4 to read · 2 read");

  // Read to the end, then J: the article is read, it stays in its place, dimmed.
  const scroller = mode(page).locator("[data-reader-scroll]");
  await expect(mode(page).locator(".reader-body")).toBeVisible();
  await expect(mode(page).locator("[data-reading-progress]")).toHaveCount(1);
  await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(mode(page).locator("[data-reading-progress]")).toHaveAttribute("style", "width: 100%;");
  await page.keyboard.press("j");
  await expect(items.first()).toHaveAttribute("data-read", "true");
  await expect(items.first()).toContainText(list[0].title);
  await expect(queue(page).locator("[data-reading-summary]")).toContainText("3 to read");
  // The minutes of an article read in this session.
  await expect(items.first()).toContainText(/\d+ min/);

  // The switch: the library's section, in its order.
  await queue(page).getByRole("button", { name: /^Queue: Reading/ }).click();
  await page.getByRole("menuitemradio", { name: "All bookmarks" }).click();
  await expect(queue(page).getByRole("button", { name: /^Queue: All bookmarks/ })).toBeVisible();
  const all = await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    return (await api.getBookmarks({}, { sort: "newest" })).items.length;
  });
  await expect(items).toHaveCount(all);
  await expect(current(page)).toBeVisible();
});

test("only the next article is read ahead, once the current one is on the page (NP-122)", async ({ page }) => {
  await boot(page);
  await fillReading(page);
  const list = await readingList(page);
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const w = window as unknown as { fetched: string[] };
    w.fetched = [];
    const original = api.fetchReaderPage;
    api.fetchReaderPage = async (url: string) => (w.fetched.push(url), original(url));
  });
  const fetched = () => page.evaluate(() => (window as unknown as { fetched: string[] }).fetched);
  await readButton(page).click();
  await expect(mode(page).locator(".reader-body")).toBeVisible();
  await expect.poll(fetched).toEqual([list[0].url, list[1].url]);
  // J shows the article read ahead at once, and reads the one after it.
  await page.keyboard.press("j");
  await expect(mode(page).locator(".reader-body")).toBeVisible();
  await expect.poll(fetched).toEqual([list[0].url, list[1].url, list[2].url]);
  // Leaving reads nothing more.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(mode(page)).toHaveCount(0);
  expect(await fetched()).toHaveLength(3);
});

test("states: loading, can't extract (Next, Mark as read), no connection (Try again, back online), Reading empty (NP-122)", async ({ page, context }) => {
  await boot(page);
  const list = await readingList(page);

  // Loading: the skeleton under the title, the running line, «opening…» in the queue.
  await stubPages(page, "hang", list[0].url);
  await readButton(page).click();
  await expect(mode(page).getByRole("status", { name: "Loading the article…" })).toBeVisible();
  await expect(mode(page).locator("[data-reading-running]")).toBeVisible();
  await expect(current(page)).toContainText("opening…");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(mode(page)).toHaveCount(0);

  // A 403: the card says why and keeps the person going; never an empty column.
  // (The page that hung above stays pending in this session: the next one fails instead.)
  await stubPages(page, "403", list[1].url);
  await readButton(page).click();
  // J only once the mode has the keys and its queue: on a slow runner it can arrive before (#324's
  // main run); the article takes focus at once, but J has nowhere to go until the queue has loaded.
  await expect(mode(page).locator("[data-reader-scroll]")).toBeFocused();
  await expect(heading(page)).toHaveText(list[0].title);
  await page.keyboard.press("j");
  const card = mode(page).locator("[data-reader-failure=failed]");
  await expect(card).toContainText("Can’t show this page in reading mode");
  await expect(card).toContainText("The site answered with error 403");
  await expect(current(page)).toContainText("opens in the browser");
  await card.getByRole("button", { name: "Open in browser" }).click();
  expect(await opened(page)).toEqual([list[1].url]);
  await card.getByRole("button", { name: /^Next/ }).click();
  await expect(heading(page)).toHaveText(list[2].title);
  await page.keyboard.press("k");
  await card.getByRole("button", { name: "Mark as read" }).click();
  await expect(heading(page)).toHaveText(list[2].title);
  await expect(queue(page).locator(`[data-queue-item]`).nth(1)).toHaveAttribute("data-read", "true");
  // Marked read: undone from the notice like any other.
  await expect(page.getByText("Marked as read").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // No connection: the card waits for the network and asks again by itself. A new session: the
  // pages read above stay in this one's memory.
  await page.reload();
  await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
  // Stubbed while online: offline, the page could not load the module it imports.
  await stubPages(page, "offline", list[0].url);
  await context.setOffline(true);
  await readButton(page).click();
  await expect(heading(page)).toHaveCount(0);
  const offline = mode(page).locator("[data-reader-failure=offline]");
  await expect(offline).toContainText("No connection");
  await expect(offline).toContainText(`loads the page from ${list[0].domain}`);
  await expect(current(page)).toContainText("waiting for connection");
  await offline.getByRole("button", { name: "Try again" }).click();
  await expect(offline).toBeVisible();
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    api.fetchReaderPage = (window as unknown as { fetchPage: typeof api.fetchReaderPage }).fetchPage;
  });
  await context.setOffline(false);
  await expect(heading(page)).toHaveText(list[0].title);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Reading empty: how to fill it, and the way back.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const ids = (await api.getBookmarks({ onlyReading: true })).items.map((b) => b.id);
    await api.bulkUpdate(ids, { action: "reading", reading: false });
  });
  await readButton(page).click();
  await expect(mode(page).locator("[data-reading-empty]")).toContainText("Reading is empty");
  await expect(queue(page).locator("[data-reading-summary]")).toHaveText("Nothing to read yet");
  await mode(page).getByRole("button", { name: "Back to library" }).click();
  await expect(mode(page)).toHaveCount(0);
});

/** The card's actions sit on one row, nothing cut off at its end. */
async function oneRow(page: Page) {
  const row = mode(page).locator("[data-reader-failure=failed] [data-reader-actions]");
  const boxes = await row.locator("button").evaluateAll((buttons) => buttons.map((b) => b.getBoundingClientRect().top));
  expect(new Set(boxes).size).toBe(1);
  expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  return boxes.length;
}

test("«Remove» on the card and ⌫ anywhere take the article out of Reading and go on; Ctrl Z brings it back (#319)", async ({ page }) => {
  await boot(page);
  const list = await readingList(page);
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  await stubPages(page, "403", list[0].url);
  await readButton(page).click();
  const card = mode(page).locator("[data-reader-failure=failed]");
  await expect(card).toBeVisible();
  // Open in browser, Next, Mark as read, Remove: one row.
  expect(await oneRow(page)).toBe(4);
  const remove = card.getByRole("button", { name: "Remove from Reading" });
  await expect(remove).toHaveText(mac ? "Remove⌫" : "RemoveDel");
  await expect(remove).toHaveAttribute("aria-keyshortcuts", "Backspace Delete");
  await expect(queue(page)).toContainText(mac ? "⌫ — remove from Reading" : "Del — remove from Reading");

  await remove.click();
  await expect(heading(page)).toHaveText(list[1].title);
  await expect(queue(page)).not.toContainText(list[0].title);
  await expect(page.getByText("Removed from Reading").first()).toBeVisible();
  // Undone from the mode itself.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(queue(page)).toContainText(list[0].title);
  await expect.poll(async () => (await readingList(page)).map((b) => b.id)).toContain(list[0].id);

  // ⌫ from the article, Del from the queue: out, and on to the next.
  await expect(mode(page).locator("[data-reader-scroll]")).toBeFocused();
  await page.keyboard.press("Backspace");
  await expect(heading(page)).toHaveText(list[2].title);
  await expect.poll(async () => (await readingList(page)).map((b) => b.id)).not.toContain(list[1].id);
  await page.keyboard.press("Escape");
  await expect(current(page)).toBeFocused();
  // The last of Reading: the one before it is read, the queue keeps focus.
  await page.keyboard.press("Delete");
  await expect(current(page)).toContainText(list[0].title);
  await expect(current(page)).toBeFocused();
  await expect.poll(async () => (await readingList(page)).map((b) => b.id)).not.toContain(list[2].id);
});

test("the card's actions stay on one row in a narrow window and a long language (#319)", async ({ page }) => {
  await boot(page, { width: 800, height: 550, language: "de" });
  const list = await readingList(page);
  await stubPages(page, "403", list[0].url);
  await readButton(page).click();
  const card = mode(page).locator("[data-reader-failure=failed]");
  await expect(card).toBeVisible();
  expect(await oneRow(page)).toBe(4);
  // Words or, where they do not fit, the icon: named in full either way.
  await expect(card.getByRole("button", { name: text(catalog("de"), "card.fromReading") })).toBeVisible();
});

test("a narrow window: the queue behind «Queue», Tab never reaches it hidden and leaves it open for the article; reduced motion fades (NP-122, #319)", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await boot(page, { width: 800, height: 550 });
  const list = await readingList(page);
  const toolbar = await readButton(page).boundingBox();
  await readButton(page).click();
  // Reduced motion: a fade instead of the circle.
  await expect(mode(page)).toHaveAttribute("data-drop", "fade");
  // «Read» stays where it was, the book alone, in the same place and size (owner, 2026-10-15).
  const pressed = mode(page).getByRole("button", { name: "Read", exact: true });
  await expect(pressed).toHaveAttribute("aria-pressed", "true");
  expect(await pressed.boundingBox()).toEqual(toolbar);
  const article = mode(page).locator("[data-reader-scroll]");
  await expect(article).toBeFocused();
  await expect(queue(page)).toHaveCount(0);
  const toggle = mode(page).getByRole("button", { name: `Queue · ${list.length}` });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // Tab does not reach the hidden queue.
  await page.keyboard.press("Shift+Tab");
  await expect(queue(page)).toHaveCount(0);
  // The browser as an icon with its name.
  await mode(page).getByRole("button", { name: "Open in browser" }).click();
  expect(await opened(page)).toEqual([list[0].url]);
  // Esc shows the queue; ↓ reads the next one behind it and the queue stays.
  await page.keyboard.press("Escape");
  await expect(current(page)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(heading(page)).toHaveText(list[1].title);
  await expect(current(page)).toBeFocused();
  // Tab: the queue closes, the article takes focus.
  await page.keyboard.press("Tab");
  await expect(queue(page)).toHaveCount(0);
  await expect(article).toBeFocused();
  // Enter in the queue closes it too.
  await page.keyboard.press("Escape");
  await expect(current(page)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(queue(page)).toHaveCount(0);
  await expect(heading(page)).toHaveText(list[2].title);
  // «Queue» opens it; Esc in the open queue leaves the mode.
  await toggle.click();
  await expect(queue(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(mode(page)).toHaveCount(0);
});
