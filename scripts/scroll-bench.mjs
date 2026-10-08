// Scrolling a large library in the browser demo (NP-012): frame times while
// the grid and the list scroll continuously through 10 000 bookmarks.
// Run: bun scripts/scroll-bench.mjs [count]
// Starts its own Vite server on a free port; Chromium from Playwright
// (PLAYWRIGHT_BROWSERS_PATH as for the UI tests).
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const count = Number(process.argv[2] ?? 10_000);
/** Pixels per frame: about 7 200 px/s at 60 Hz, a fast wheel or a dragged scrollbar. */
const STEP = 120;
/** Upper bound; the run stops at the end of the fully loaded list. */
const MAX_FRAMES = 12_000;

const server = await createServer({ server: { port: 0, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();

async function measure(view) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url);
  await page.evaluate(
    async ({ count, view }) => {
      const { api } = await import("/src/services/api.ts");
      // The demo's own key: a stale copy here once left the run on the 6 default bookmarks.
      const { DEMO_STORAGE_KEY } = await import("/src/services/demo.ts");
      const [first] = (await api.getBookmarks()).items;
      const words = ["Архитектура", "интерфейс", "design", "notes", "Ёлка", "search", "библиотека", "release"];
      const bookmarks = Array.from({ length: count }, (_, i) => ({
        ...first,
        id: i + 1,
        url: `https://site${i % 300}.example/${i}`,
        domain: `site${i % 300}.example`,
        title: `${words[i % 8]} ${words[(i * 3) % 8]} ${i}`,
        description: `${words[(i * 5) % 8]} — ${words[(i * 7) % 8]}`,
        // A few real images, so previews decode while scrolling; every
        // seventh has none and shows the site plate.
        image_url: i % 7 === 0 ? null : `/app-icon.svg?v=${i % 6}`,
        tags: [words[i % 8].toLowerCase()],
        // Spread over a year, newest first by id.
        created_at: new Date(Date.UTC(2026, 9, 3) - i * 3_153_600).toISOString(),
      }));
      localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify({ bookmarks, collections: await api.getCollections() }));
      localStorage.setItem("koonapin.view", view);
    },
    { count, view },
  );
  await page.reload();
  await page.waitForSelector("[data-bookmark-id]");
  // The first page of the seeded library, not the demo's own few bookmarks.
  const first = Math.min(count, 100);
  await page.waitForFunction(
    (first) => Number(document.querySelector("[data-loaded]")?.getAttribute("data-loaded")) === first,
    first,
    { timeout: 10_000 },
  ).catch(() => {
    throw new Error(`the demo did not take the seeded library: expected ${first} loaded bookmarks`);
  });
  const result = await page.evaluate(
    async ({ STEP, MAX_FRAMES, count }) => {
      const scroller = document.querySelector('[data-scroll="main"]');
      const gaps = [];
      let last = performance.now();
      const loaded = () => Number(document.querySelector("[data-loaded]")?.getAttribute("data-loaded"));
      for (let frame = 0; frame < MAX_FRAMES; frame++) {
        const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
        if (atEnd && loaded() === count) break;
        scroller.scrollTop += STEP;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const now = performance.now();
        gaps.push(now - last);
        last = now;
      }
      gaps.sort((a, b) => a - b);
      const at = (p) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))];
      return {
        p50: at(0.5),
        p95: at(0.95),
        p99: at(0.99),
        max: gaps.at(-1),
        over33: gaps.filter((g) => g > 33.4).length,
        scrolled: Math.round(scroller.scrollTop),
        frames: gaps.length,
        loaded: loaded(),
        inDom: document.querySelectorAll("[data-bookmark-id]").length,
      };
    },
    { STEP, MAX_FRAMES, count },
  );
  await page.close();
  return result;
}

console.log(`${count} bookmarks, scrolled to the end at ${STEP} px per frame, 1440×900`);
for (const view of ["grid", "list"]) {
  const r = await measure(view);
  if (r.loaded !== count) throw new Error(`${view}: scrolled to the end with ${r.loaded} of ${count} bookmarks loaded`);
  const ms = (v) => `${v.toFixed(1)} ms`;
  console.log(
    `${view.padEnd(4)}  frame p50 ${ms(r.p50)}  p95 ${ms(r.p95)}  p99 ${ms(r.p99)}  max ${ms(r.max)}  ` +
      `over 33 ms: ${r.over33} of ${r.frames} frames  scrolled ${r.scrolled} px  loaded ${r.loaded}  cards in DOM ${r.inDom}`,
  );
}
await browser.close();
await server.close();
