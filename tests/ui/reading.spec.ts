import { test, expect, Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// NP-122 (Р-69, point 1, frames R0, B1–B9): the reading mode drops from «Read», reads the queue
// one article after another and folds back into the library at the same place.

type Catalog = { [key: string]: string | Catalog };
const catalog = (code: string): Catalog => JSON.parse(readFileSync(`src/locales/${code}.json`, "utf8"));
const text = (c: Catalog, key: string) => key.split(".").reduce<string | Catalog>((node, part) => (node as Catalog)[part], c) as string;

const mode = (page: Page) => page.locator("[data-reading-mode]");
const queue = (page: Page) => mode(page).locator("[data-reading-queue]");
const current = (page: Page) => queue(page).locator("[aria-current=true]");
const heading = (page: Page) => mode(page).locator(".reader-title");
/** The toolbar's «Read»; the selection bar has one of its own. */
const readButton = (page: Page) => page.locator("button[data-read-mode]");
const opened = (page: Page) => page.evaluate(() => (window as unknown as { opened: string[] }).opened);

async function boot(
  page: Page,
  { width = 1440, height = 900, theme = "light", language = "en", view = "grid" }: { width?: number; height?: number; theme?: string; language?: string; view?: string } = {},
) {
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await page.evaluate(
    ({ theme, language, view }) => {
      localStorage.removeItem("koonapin.demo.v4");
      localStorage.removeItem("koonapin.openLinks");
      localStorage.setItem("koonapin.theme", theme);
      localStorage.setItem("koonapin.language", language);
      localStorage.setItem("koonapin.view", view);
    },
    { theme, language, view },
  );
  await page.reload();
  await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  // The browser is a list of addresses: nothing leaves the test.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    (window as unknown as { opened: string[] }).opened = [];
    api.openUrl = async (url: string) => void (window as unknown as { opened: string[] }).opened.push(url);
  });
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

  await readButton(page).click();
  await expect(mode(page)).toBeVisible();
  // The drop: a circle from the button, not a fade.
  await expect(mode(page)).toHaveAttribute("data-drop", "circle");
  await expect(current(page)).toContainText(list.find((b) => !b.read)!.title);
  await expect(heading(page)).toHaveText(list.find((b) => !b.read)!.title);
  // The library underneath takes no focus.
  expect(await page.evaluate(() => !!document.querySelector("main")?.closest("[inert]"))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(current(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(mode(page)).toHaveCount(0);
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
  // Tab from the search field to «Read».
  await page.keyboard.press("Control+K");
  for (let i = 0; i < 12; i++) {
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
  // The Russian layout: the same key.
  await page.keyboard.press("j");
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
  await context.setOffline(true);
  await stubPages(page, "offline", list[0].url);
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

test("reduced motion: a fade instead of the circle; a narrow window keeps the queue behind «Queue» (NP-122)", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await boot(page, { width: 800, height: 550 });
  const list = await readingList(page);
  await readButton(page).click();
  await expect(mode(page)).toHaveAttribute("data-drop", "fade");
  await expect(queue(page)).toHaveCount(0);
  const toggle = mode(page).getByRole("button", { name: `Queue · ${list.length}` });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // The browser as an icon with its name.
  await mode(page).getByRole("button", { name: "Open in browser" }).click();
  expect(await opened(page)).toEqual([list[0].url]);
  // Esc shows the queue, a second one leaves.
  await page.keyboard.press("Escape");
  await expect(current(page)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(queue(page)).toHaveCount(0);
  await expect(heading(page)).toHaveText(list[1].title);
  await toggle.click();
  await expect(queue(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(mode(page)).toHaveCount(0);
});

/**
 * Evidence for acceptance 2: every state in both themes, at 1440×900 and 800×550, in English,
 * German and Russian, beside its frame in the PR. Screenshots only; the assertions are above.
 */
for (const language of ["en", "de", "ru"]) {
  for (const theme of ["light", "dark"]) {
    test(`evidence ${language} ${theme}`, { tag: "@evidence" }, async ({ page, context }) => {
      test.setTimeout(120_000);
      const t = (key: string) => text(catalog(language), key);
      for (const [width, height] of [
        [1440, 900],
        [800, 550],
      ]) {
        const shot = async (state: string) => {
          // The drop and the queue's fade have finished; the running line never does.
          await page.waitForFunction(
            () =>
              !document
                .querySelector("[data-reading-mode]")
                ?.getAnimations({ subtree: true })
                .some((a) => a.effect?.getTiming().iterations !== Infinity),
          );
          await page.screenshot({ path: `${process.env.READING_SHOTS ?? "test-results/np122"}/${language}-${theme}-${width}-${state}.png` });
        };
        await context.setOffline(false);
        await boot(page, { width, height, theme, language });
        await shot("R0");
        await fillReading(page);
        if (width === 1440) {
          // B1 and B2: the drop held at 60 and 150 ms of its 200.
          for (const [frame, at] of [
            ["B1", 60],
            ["B2", 150],
          ] as const) {
            await readButton(page).click();
            await page.waitForFunction((at) => {
              const drop = document.querySelector("[data-reading-mode]")?.getAnimations()[0];
              if (!drop) return false;
              drop.pause();
              drop.currentTime = at;
              return true;
            }, at);
            await page.screenshot({ path: `${process.env.READING_SHOTS ?? "test-results/np122"}/${language}-${theme}-${width}-${frame}.png` });
            await page.evaluate(() => document.querySelector("[data-reading-mode]")?.getAnimations()[0]?.finish());
            await page.keyboard.press("Escape");
            await page.keyboard.press("Escape");
            await expect(mode(page)).toHaveCount(0);
          }
        }
        const list = await readingList(page);
        const read = () => readButton(page).click();
        const leave = async () => {
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");
          await expect(mode(page)).toHaveCount(0);
        };
        /** A new session for each state: the pages stubbed for the last one stay in the old one's memory. */
        const fresh = async () => {
          await page.reload();
          await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
          await page.evaluate(() => document.fonts.ready);
        };
        // B3: an article a quarter read.
        await read();
        await expect(mode(page).locator(".reader-body")).toBeVisible();
        await mode(page).locator("[data-reader-scroll]").evaluate((el) => el.scrollTo({ top: (el.scrollHeight - el.clientHeight) * 0.25 }));
        await expect(mode(page).locator("[data-reading-progress]")).not.toHaveAttribute("style", "width: 0%;");
        await shot("B3");
        if (width === 800) {
          await mode(page).getByRole("button", { name: new RegExp(`^${t("readingMode.queueButton").split("{{")[0]}`) }).click();
          await shot("B9-queue");
          await page.keyboard.press("Escape");
          await expect(mode(page)).toHaveCount(0);
        } else await leave();
        // B4 loading.
        await fresh();
        await stubPages(page, "hang", list[0].url);
        await read();
        await expect(mode(page).locator("[data-reading-running]")).toBeVisible();
        await shot("B4");
        await leave();
        // B5 can't extract.
        await fresh();
        await stubPages(page, "403", list[0].url);
        await read();
        await expect(mode(page).locator("[data-reader-failure=failed]")).toBeVisible();
        await shot("B5");
        await leave();
        // B6 no connection.
        await fresh();
        await context.setOffline(true);
        await stubPages(page, "offline", list[0].url);
        await read();
        await expect(mode(page).locator("[data-reader-failure=offline]")).toBeVisible();
        await shot("B6");
        await leave();
        await context.setOffline(false);
        // B7 Reading empty.
        await page.evaluate(async () => {
          const { api } = await import("/src/services/api.ts");
          const ids = (await api.getBookmarks({ onlyReading: true })).items.map((b) => b.id);
          await api.bulkUpdate(ids, { action: "reading", reading: false });
        });
        await read();
        await expect(mode(page).locator("[data-reading-empty]")).toBeVisible();
        await shot("B7");
        await leave();
      }
    });
  }
}
