import { expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// What the UI specs share: opening the demo in a known state, the notification centre, a browser
// that only records addresses, failing api calls, the locale catalogs and a JSON copy as Export writes it.

/**
 * Opens the demo with a fresh library: `settings` are `koonapin.*` keys without the prefix (null
 * removes one), written before the reload that starts the app on them. `clear` empties localStorage
 * first. `cards` waits for that many cards; without it, for the first one.
 */
export async function openApp(
  page: Page,
  { settings = {}, clear = false, viewport, cards }: { settings?: Record<string, string | null>; clear?: boolean; viewport?: { width: number; height: number }; cards?: number } = {},
) {
  if (viewport) await page.setViewportSize(viewport);
  await page.goto("/");
  await page.evaluate(
    ({ settings, clear }) => {
      if (clear) localStorage.clear();
      localStorage.removeItem("koonapin.demo.v4");
      for (const [key, value] of Object.entries(settings)) {
        if (value === null) localStorage.removeItem(`koonapin.${key}`);
        else localStorage.setItem(`koonapin.${key}`, value);
      }
    },
    { settings, clear },
  );
  await page.reload();
  if (cards === undefined) await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
  else await expect(page.locator("[data-bookmark-id]")).toHaveCount(cards);
}

/** A group of Settings (S1), opened if folded: General is always open, the others start folded. */
export type SettingsGroup = "general" | "connections" | "reading" | "feeds" | "backups" | "storage" | "support";
export async function settingsGroup(page: Page, name: SettingsGroup): Promise<Locator> {
  const group = page.locator(`section[data-settings-group="${name}"]`);
  await expect(group).toBeVisible();
  const head = group.locator("h2 button");
  if ((await head.count()) && (await head.getAttribute("aria-expanded")) === "false") {
    await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true");
  }
  return group;
}

export const bell = (page: Page) => page.locator("[data-notification-bell]");
export const centre = (page: Page) => page.getByRole("dialog", { name: "Notifications" });
/** Triage over the inbox; since the notification centre, the library's way in is the bell. */
export async function openTriage(page: Page) {
  await bell(page).click();
  await centre(page).getByRole("button", { name: "Sort", exact: true }).click();
}

/** The browser is a list of addresses: nothing leaves the test. The demo's openUrl is window.open. */
export const stubBrowser = (page: Page) =>
  page.evaluate(async () => {
    const w = window as unknown as { opened: string[] };
    w.opened = [];
    window.open = (url) => (w.opened.push(String(url)), null);
    const { api } = await import("/src/services/api.ts");
    api.openUrl = async (url: string) => void w.opened.push(url);
  });
/** The addresses opened since stubBrowser. */
export const opened = (page: Page) => page.evaluate(() => (window as unknown as { opened: string[] }).opened);

/** The next call of an api method fails with a CommandError; the one after it works again. */
export async function failOnce(page: Page, method: string, code: string, message = code, detail?: string) {
  await page.evaluate(
    async ([method, code, message, detail]) => {
      const { api } = await import("/src/services/api.ts");
      const { CommandError } = await import("/src/services/errors.ts");
      const target = api as unknown as Record<string, unknown>;
      const original = target[method];
      target[method] = async () => {
        target[method] = original;
        type Args = ConstructorParameters<typeof CommandError>;
        throw new CommandError(code as Args[0], message, detail as Args[2]);
      };
    },
    [method, code, message, detail] as const,
  );
}

export const locales = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "locales");
export type Catalog = { [key: string]: string | Catalog };
export const catalog = (code: string): Catalog => JSON.parse(readFileSync(path.join(locales, `${code}.json`), "utf8"));
/** A string of a catalog by its dotted key. */
export const text = (c: Catalog, key: string) => key.split(".").reduce<string | Catalog>((node, k) => (node as Catalog)[k], c) as string;

/** When a copy's rows were made. */
export const copiedAt = "2026-09-01T10:00:00.000Z";
/** A bookmark of a JSON copy, sorted and imported at copiedAt; `more` overrides any field. */
export const copyBookmark = (uid: string, url: string, title: string, more: Record<string, unknown> = {}) => ({
  uid, url, title, description: null, notes: null, domain: new URL(url).hostname, image_url: null, favicon_url: null, site_name: null,
  is_favorite: false, collection: null, tags: [], source: "import", created_at: copiedAt, updated_at: copiedAt, triaged_at: copiedAt, deleted_at: null, ...more,
});
/** A JSON copy as Export writes it, as a file for setInputFiles; `edit` may spoil it first. */
export function jsonCopy(
  { format = "koona-pin", collections = [], tags = [], bookmarks }: { format?: string; collections?: unknown[]; tags?: unknown[]; bookmarks: unknown[] },
  edit: (copy: Record<string, unknown>) => void = () => {},
) {
  const copy: Record<string, unknown> = { format, version: 1, exported_at: "2026-10-04T18:20:00.000Z", app_version: "0.1.0", collections, tags, bookmarks };
  edit(copy);
  return { name: "koona-pin-2026-10-04.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(copy)) };
}
/** Where a drag from outside is dispatched (K9): a named region, or the middle of any element. */
export type DropWhere = "list" | "sidebar" | "toolbar" | Locator;

/**
 * The point for `where`: the middle of the view's drop area below its heads, where the drop zone
 * lies; the middle of the sidebar or of the view's first head (the toolbar), where it never does.
 */
export async function dropPoint(page: Page, where: DropWhere = "list") {
  if (where === "list")
    return page.evaluate(() => {
      const box = document.querySelector("main [data-drop-area]")!.getBoundingClientRect();
      const heads = Array.from(document.querySelectorAll("main [data-drop-head]"), (head) => head.getBoundingClientRect()).filter((head) => head.width > 0);
      const top = Math.max(box.top, ...heads.map((head) => head.bottom));
      return { x: Math.round(box.left + box.width / 2), y: Math.round((top + box.bottom) / 2) };
    });
  const region = where === "sidebar" ? page.getByRole("complementary").first() : where === "toolbar" ? page.locator("main [data-drop-head]").first() : where;
  const box = (await region.boundingBox())!;
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}
