// Evidence for NP-122, acceptance 2: every state of the reading mode in both themes, at 1440×900
// and 800×550, in English and German (the longest), to put beside its frame in a PR. Screenshots only;
// tests/ui/reading.spec.ts has the assertions. Needs the dev server (`bun run dev`, port in
// KOONAPIN_DEV_URL, default http://127.0.0.1:1420). Writes .test-data/reading/<language>-<theme>-<width>-<state>.png
// (or into READING_SHOTS).
import { chromium } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";

const base = process.env.KOONAPIN_DEV_URL ?? "http://127.0.0.1:1420";
const out = process.env.READING_SHOTS ?? ".test-data/reading";
await mkdir(out, { recursive: true });

const text = (catalog, key) => key.split(".").reduce((node, part) => node[part], catalog);
const mode = (page) => page.locator("[data-reading-mode]");
const readButton = (page) => page.locator("button[data-read-mode]");

async function boot(page, { width, height, theme, language }) {
  await page.setViewportSize({ width, height });
  await page.goto(base);
  await page.evaluate(
    ({ theme, language }) => {
      localStorage.removeItem("koonapin.demo.v4");
      localStorage.removeItem("koonapin.openLinks");
      localStorage.setItem("koonapin.theme", theme);
      localStorage.setItem("koonapin.language", language);
      localStorage.setItem("koonapin.view", "grid");
    },
    { theme, language },
  );
  await page.reload();
  await page.locator("[data-bookmark-id]").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  // The browser is a list of addresses: nothing leaves the script.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    api.openUrl = async () => {};
  });
}

/** Reading as in the mockups: more to read, two already read at the bottom. */
const fillReading = (page) =>
  page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const more = (await api.getBookmarks()).items.filter((b) => !b.reading_at).slice(0, 3);
    await api.bulkUpdate(more.map((b) => b.id), { action: "reading", reading: true });
    await api.bulkUpdate(more.slice(0, 2).map((b) => b.id), { action: "read", read: true });
  });

const readingList = (page) =>
  page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    return (await api.getBookmarks({ onlyReading: true })).items.map((b) => ({ url: b.url }));
  });

/** Pages that never arrive, fail, or come from a computer without a connection. */
const stubPages = (page, how, match) =>
  page.evaluate(
    async ({ how, match }) => {
      const { api } = await import("/src/services/api.ts");
      window.fetchPage ??= api.fetchReaderPage;
      const original = window.fetchPage;
      api.fetchReaderPage = async (url) => {
        if (!url.includes(match)) return original(url);
        if (how === "hang") return new Promise(() => {});
        if (how === "403") return { kind: "status", url, status: 403 };
        return { kind: "failed" };
      };
    },
    { how, match },
  );

const browser = await chromium.launch();
for (const language of ["en", "de"]) {
  const catalog = JSON.parse(await readFile(`src/locales/${language}.json`, "utf8"));
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ locale: "en-US" });
    const page = await context.newPage();
    for (const [width, height] of [
      [1440, 900],
      [800, 550],
    ]) {
      const file = (state) => `${out}/${language}-${theme}-${width}-${state}.png`;
      const shot = async (state) => {
        // The drop and the queue's fade have finished; the running line never does.
        await page.waitForFunction(
          () =>
            !document
              .querySelector("[data-reading-mode]")
              ?.getAnimations({ subtree: true })
              .some((a) => a.effect?.getTiming().iterations !== Infinity),
        );
        await page.screenshot({ path: file(state) });
      };
      const read = () => readButton(page).click();
      const gone = () => mode(page).waitFor({ state: "detached" });
      const leave = async () => {
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        await gone();
      };
      /** A new session for each state: the pages stubbed for the last one stay in the old one's memory. */
      const fresh = async () => {
        await page.reload();
        await page.locator("[data-bookmark-id]").first().waitFor();
        await page.evaluate(() => document.fonts.ready);
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
        ]) {
          await read();
          await page.waitForFunction((at) => {
            const drop = document.querySelector("[data-reading-mode]")?.getAnimations()[0];
            if (!drop) return false;
            drop.pause();
            drop.currentTime = at;
            return true;
          }, at);
          await page.screenshot({ path: file(frame) });
          await page.evaluate(() => document.querySelector("[data-reading-mode]")?.getAnimations()[0]?.finish());
          await leave();
        }
      }
      const list = await readingList(page);
      // B3 from its top (meta line, title, dek), then a quarter read with the line moving.
      await read();
      await mode(page).locator(".reader-body").waitFor();
      await shot("B3");
      // The line follows scrolling once the article settled where reading stopped: scroll until it does.
      const progress = mode(page).locator("[data-reading-progress]");
      for (let i = 0; i < 50; i++) {
        await mode(page)
          .locator("[data-reader-scroll]")
          .evaluate((el) => el.scrollTo({ top: (el.scrollHeight - el.clientHeight) * 0.25 + Math.random() }));
        if ((await progress.getAttribute("style")) !== "width: 0%;") break;
        await page.waitForTimeout(100);
      }
      await shot("B3-scrolled");
      if (width === 800) {
        await mode(page)
          .getByRole("button", { name: new RegExp(`^${text(catalog, "readingMode.queueButton").split("{{")[0]}`) })
          .click();
        await shot("B9-queue");
        await page.keyboard.press("Escape");
        await gone();
      } else await leave();
      // B4 loading.
      await fresh();
      await stubPages(page, "hang", list[0].url);
      await read();
      await mode(page).locator("[data-reading-running]").waitFor();
      await shot("B4");
      await leave();
      // B5 can't extract.
      await fresh();
      await stubPages(page, "403", list[0].url);
      await read();
      await mode(page).locator("[data-reader-failure=failed]").waitFor();
      await shot("B5");
      await leave();
      // B6 no connection.
      await fresh();
      await stubPages(page, "offline", list[0].url);
      await context.setOffline(true);
      await read();
      await mode(page).locator("[data-reader-failure=offline]").waitFor();
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
      await mode(page).locator("[data-reading-empty]").waitFor();
      await shot("B7");
      await leave();
    }
    await context.close();
  }
}
await browser.close();
console.log("reading mode rendered to", out);
