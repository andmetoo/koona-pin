// Renders the covers of NP-087 in the real interface for the Lunacy mockup:
// grid, list and triage, both themes, English and Russian, at 1440×900.
// Needs the dev server on http://127.0.0.1:1420 (`bun run dev`) and network
// for the sites' icons. Writes .test-data/covers/<view>-<theme>-<lang>.png (outside test-results, which a test run clears).
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const out = ".test-data/covers";
await mkdir(out, { recursive: true });

/** The pages of the owner's screenshot (5 Oct 2026) that had empty plates, and two with pictures. */
const sites = [
  ["https://github.com/andmetoo/koonapin/issues", "Issues · andmetoo/koonapin", "Проблемы · andmetoo/koonapin"],
  ["https://www.iana.org/", "Internet Assigned Numbers Authority", "Internet Assigned Numbers Authority"],
  ["https://mail.google.com/mail/u/0/", "Inbox — Gmail", "Входящие — Gmail"],
  ["https://vk.com/", "VK", "ВКонтакте"],
  ["https://addons.mozilla.org/en-US/developers/addon/api/key/", "Manage API Keys :: Developer Hub", "Ключи API :: Developer Hub"],
  ["https://dash.cloudflare.com/8eb737b7/home", "Cloudflare dashboard", "Панель Cloudflare"],
  ["http://192.168.1.1/", "Router", "Роутер"],
];

const browser = await chromium.launch();
for (const lang of ["en", "ru"])
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: lang === "ru" ? "ru-RU" : "en-US" });
    await page.goto("http://127.0.0.1:1420/");
    await page.evaluate(
      ({ lang, theme }) => {
        localStorage.clear();
        localStorage.setItem("koonapin.language", lang);
        localStorage.setItem("koonapin.theme", theme);
      },
      { lang, theme },
    );
    await page.reload();
    await page.locator("[data-bookmark-id]").first().waitFor();
    await page.evaluate(
      async ({ sites, lang }) => {
        const { api } = await import("/src/services/api.ts");
        const demo = (await api.getBookmarks()).items;
        const at = "2026-10-05T09:00:00.000Z";
        const made = sites.map(([url, en, ru], i) => {
          const domain = new URL(url).hostname.replace(/^www\./, "");
          const local = domain.startsWith("192.");
          return {
            ...demo[0], id: 100 + i, url, domain, title: lang === "ru" ? ru : en, description: null, image_url: null,
            favicon_url: local ? null : `https://www.google.com/s2/favicons?domain=${domain}&sz=128`, site_name: null,
            tags: [], is_favorite: i === 1, collection_id: null, created_at: at, updated_at: at,
            // Two wait in the inbox: triage shows a cover at 280 px.
            triaged_at: i === 3 || i === 0 ? null : at, source: "chrome",
          };
        });
        // Saved a moment ago: its metadata is on the way, the preview shimmers.
        const fresh = { ...made[0], id: 99, url: "https://example.com/just-saved", domain: "example.com", title: lang === "ru" ? "Только что сохранено" : "Just saved", favicon_url: null, created_at: new Date().toISOString(), triaged_at: new Date().toISOString() };
        const pictures = demo.filter((b) => b.image_url).slice(0, 2).map((b) => ({ ...b, triaged_at: at, is_favorite: false }));
        localStorage.setItem("koonapin.demo.v4", JSON.stringify({ bookmarks: [fresh, ...made.slice(0, 3), pictures[0], ...made.slice(3), pictures[1]], collections: await api.getCollections() }));
      },
      { sites, lang },
    );
    await page.reload();
    await page.locator("[data-preview-pending]").waitFor();
    await page.waitForLoadState("networkidle");
    // The demo label is not part of the design.
    await page.addStyleTag({ content: "span.mr-auto.pl-8[data-tauri-drag-region]{visibility:hidden}" });
    await page.screenshot({ path: `${out}/grid-${theme}-${lang}.png` });
    await page.getByRole("button", { name: lang === "ru" ? "Список" : "List", exact: true }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/list-${theme}-${lang}.png` });
    await page.getByRole("region", { name: lang === "ru" ? "Новые закладки" : "New bookmarks" }).getByRole("button", { name: lang === "ru" ? "Разобрать" : "Sort" }).click();
    await page.locator("[data-triage-card] .cover").waitFor();
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: `${out}/triage-${theme}-${lang}.png` });
    await page.close();
  }
await browser.close();
console.log("covers rendered to", out);
