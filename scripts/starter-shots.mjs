// Renders the starter links of NP-117 in the real interface for the Lunacy mockup:
// list, grid and triage of a new library, both themes, English, at 1440×900.
// The import banner does not exist yet: the script adds it to the page, built
// from the inbox banner's classes. Needs the dev server (`bun run dev`, port in
// KOONAPIN_DEV_URL, default http://127.0.0.1:1420). Writes .test-data/starter/<view>-<theme>.png.
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const base = process.env.KOONAPIN_DEV_URL ?? "http://127.0.0.1:1420";
const out = ".test-data/starter";
await mkdir(out, { recursive: true });

/** The starter set of NP-117 (#228), newest first: Bun and Lunacy last. */
const starter = [
  ["https://koona.app/pin/#how", "Start here: how Koona Pin works", "Save, sort and find links in a few minutes."],
  ["https://koona.app/pin/downloads/#extension", "Add the Save button to your browser", "Chrome, Edge or Firefox: one click saves the page you are on."],
  ["https://koona.app/pin/docs/mcp/", "Connect Claude or Cursor (MCP)", "Let your AI assistant search your library and save links, on this computer."],
  ["https://koona.app/pin/changelog/", "What's new in Koona Pin", "Every version and what changed in it."],
  ["https://koona.app/", "Koona apps", "Other apps by Koona."],
  ["https://bun.com/", "Bun", "A fast JavaScript runtime and toolkit."],
  ["https://www.lunacyapp.com/", "Lunacy", "A free design app with built-in graphics."],
];

const importBanner = `<span class="flex min-w-0 items-start gap-2.5"><span class="mt-px flex shrink-0 text-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><path d="M8 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4"/></svg></span><span>Bring your bookmarks from Chrome, Edge or Firefox — their folders become collections</span></span><span class="flex shrink-0 items-center gap-3"><button type="button" class="inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-surface text-sm font-medium text-ink h-[30px] px-3">Import bookmarks…</button><button type="button" class="flex size-6 items-center justify-center rounded-md text-icon"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button></span>`;

async function addImportBanner(page) {
  await page.evaluate((html) => {
    const inbox = document.querySelector('[role="region"][aria-label="New bookmarks"]');
    const plate = document.createElement("div");
    plate.className = "flex items-center justify-between gap-5 rounded-xl px-4 py-3 text-sm bg-panel text-ink";
    plate.innerHTML = html;
    inbox.parentElement.insertBefore(plate, inbox);
  }, importBanner);
}

const browser = await chromium.launch();
for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  await page.goto(base);
  await page.evaluate(
    async ({ theme, starter }) => {
      localStorage.clear();
      localStorage.setItem("koonapin.language", "en");
      localStorage.setItem("koonapin.theme", theme);
      localStorage.setItem("koonapin.view", "list");
      const { api } = await import("/src/services/api.ts");
      const sample = (await api.getBookmarks()).items[0];
      const now = Date.parse("2026-10-09T16:02:00.000Z");
      const bookmarks = starter.map(([url, title, description], i) => {
        const at = new Date(now - i * 1000).toISOString();
        return {
          ...sample, id: i + 1, url, domain: new URL(url).hostname.replace(/^www\./, ""), title, description,
          notes: null, image_url: null, favicon_url: null, site_name: null, tags: [], is_favorite: false, collection_id: null,
          created_at: at, updated_at: at, triaged_at: null, deleted_at: null, source: "app", revision: 1,
        };
      });
      const collections = ["Development", "Design", "Reading"].map((name, i) => ({
        id: i + 1, name, color: null, icon: null, count: null, created_at: "2026-10-09T16:00:00.000Z",
      }));
      localStorage.setItem("koonapin.demo.v4", JSON.stringify({ bookmarks, collections }));
    },
    { theme, starter },
  );
  await page.reload();
  await page.locator("[data-bookmark-id]").first().waitFor();
  // The demo label is not part of the design.
  await page.addStyleTag({ content: "span.mr-auto.pl-8[data-tauri-drag-region]{visibility:hidden}" });
  await addImportBanner(page);
  await page.screenshot({ path: `${out}/list-${theme}.png` });
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/grid-${theme}.png` });
  await page.getByRole("region", { name: "New bookmarks" }).getByRole("button", { name: "Sort" }).click();
  await page.locator("[data-triage-card] .cover").waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/triage-${theme}.png` });
  await page.close();
}
await browser.close();
console.log("starter links rendered to", out);
