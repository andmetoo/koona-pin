import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// NP-118: a dialog has one height for its whole life. Each one is walked through its states in the
// demo, in English, German and Russian, in the smallest and a wide window: its box stays the same.
const here = path.dirname(fileURLToPath(import.meta.url));
type Catalog = { [key: string]: string | Catalog };
const catalog = (code: string): Catalog => JSON.parse(readFileSync(path.join(here, "..", "..", "src", "locales", `${code}.json`), "utf8"));
const text = (c: Catalog, key: string) => key.split(".").reduce<string | Catalog>((node, k) => (node as Catalog)[k], c) as string;
const starts = (label: string) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const fixture = path.join(here, "..", "fixtures", "bookmarks", "chrome.html");

/** A JSON copy as Export writes it. */
function copyFile(format = "koona-pin") {
  const at = "2026-09-01T10:00:00.000Z";
  const bookmark = (uid: string, url: string) => ({
    uid, url, title: uid, description: null, notes: null, domain: new URL(url).hostname, image_url: null, favicon_url: null, site_name: null,
    is_favorite: false, collection: null, tags: [], source: "import", created_at: at, updated_at: at, triaged_at: at, deleted_at: null,
  });
  const copy = {
    format, version: 1, exported_at: "2026-10-04T18:20:00.000Z", app_version: "0.1.0",
    collections: [], tags: [], bookmarks: [bookmark("b1", "https://restored.example/one"), bookmark("b2", "https://restored.example/two")],
  };
  return { name: "koona-pin-2026-10-04.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(copy)) };
}

/** The open dialog's box, which must not change from opening to closing. */
function tracker(page: Page) {
  const dialog = page.locator("dialog[open]");
  const box = async () => {
    const b = (await dialog.boundingBox())!;
    return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
  };
  let first: Awaited<ReturnType<typeof box>> | null = null;
  let name = "";
  const heights: Record<string, number> = {};
  return {
    dialog,
    heights,
    /** After the 200 ms appearance, which moves it by 5 px. */
    async open(dialogName: string) {
      await expect(dialog).toBeVisible();
      await page.waitForTimeout(300);
      name = dialogName;
      first = await box();
      heights[name] = first.height;
    },
    async same(step: string) {
      expect(await box(), `${name}: ${step}`).toEqual(first);
    },
  };
}

for (const code of ["en", "de", "ru"]) {
  const t = (key: string) => text(catalog(code), key);
  // 1200×800 in English is where the mockups' heights are compared with the code's.
  for (const [width, height] of [[800, 550], [1600, 800], ...(code === "en" ? [[1200, 800]] : [])]) {
    test(`${code} ${width}×${height}: every dialog keeps its size and place through its states`, async ({ page }, info) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width, height });
      await page.addInitScript((language) => {
        localStorage.removeItem("koonapin.demo.v4");
        localStorage.setItem("koonapin.language", language);
        if (!localStorage.getItem("koonapin.demo.update")) localStorage.setItem("koonapin.demo.update", "on");
      }, code);
      await page.goto("/");
      await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const track = tracker(page);
      const { dialog } = track;
      const button = (key: string) => dialog.getByRole("button", { name: t(key), exact: true });
      const more = async (item: string) => {
        await page.getByRole("button", { name: t("toolbar.more"), exact: true }).click();
        await page.getByRole("menuitem", { name: starts(t(item)) }).click();
      };
      const settings = () => page.getByRole("button", { name: t("nav.settings") }).first().click();

      // Import: the file, then a run held until released, the report, an error, a file without links.
      await more("more.importHtml");
      await track.open("import");
      await dialog.locator("input[type=file]").setInputFiles(fixture);
      await track.same("file chosen");
      await page.evaluate(async () => {
        const { api } = await import("/src/services/api.ts");
        const run = api.importHtmlBookmarks.bind(api);
        const w = window as unknown as { release: () => void };
        api.importHtmlBookmarks = (...args) => new Promise((resolve) => (w.release = () => resolve(run(...args))));
      });
      await button("import.run").click();
      await expect(dialog.getByRole("progressbar")).toBeVisible();
      await track.same("running");
      await page.evaluate(() => (window as unknown as { release: () => void }).release());
      await expect(dialog.getByRole("status")).toBeVisible();
      await track.same("report");
      await dialog.getByRole("button", { name: t("import.showSkipped") }).click();
      await track.same("skipped shown");
      await button("import.done").click();
      await page.evaluate(async () => {
        const { api } = await import("/src/services/api.ts");
        const { CommandError } = await import("/src/services/errors.ts");
        api.importHtmlBookmarks = async () => {
          throw new CommandError("database_busy", "database is locked");
        };
      });
      await more("more.importHtml");
      await track.open("import");
      await dialog.locator("input[type=file]").setInputFiles(fixture);
      await button("import.run").click();
      await expect(dialog.getByRole("alert")).toBeVisible();
      await track.same("error");
      await page.keyboard.press("Escape");
      await more("more.importHtml");
      await track.open("import");
      await dialog.locator("input[type=file]").setInputFiles({ name: "notes.html", mimeType: "text/html", buffer: Buffer.from("<html><body>Notes</body></html>") });
      await expect(dialog.getByRole("alert")).toBeVisible();
      await track.same("empty file");
      await page.keyboard.press("Escape");

      // Restore from a JSON copy: the file, the confirmation of a replace and back, the report, a refused copy.
      await more("more.importJson");
      await track.open("restore");
      await dialog.locator("input[type=file]").setInputFiles(copyFile());
      await track.same("file chosen");
      await dialog.getByRole("radio", { name: starts(t("restore.replace")) }).click();
      await button("restore.run").click();
      await expect(button("restore.confirm")).toBeVisible();
      await track.same("replace?");
      await button("common.keep").click();
      await track.same("kept");
      // Escape on the confirmation goes back to the copy, as «Keep» does.
      await button("restore.run").click();
      await page.keyboard.press("Escape");
      await expect(dialog.getByRole("radio", { name: starts(t("restore.replace")) })).toHaveAttribute("aria-checked", "true");
      await track.same("Escape on replace?");
      await button("restore.run").click();
      await button("restore.confirm").click();
      await expect(dialog.getByRole("status")).toBeVisible();
      await track.same("report");
      await button("import.done").click();
      await more("more.importJson");
      await track.open("restore");
      await dialog.locator("input[type=file]").setInputFiles(copyFile("other-app"));
      await expect(dialog.getByRole("alert")).toBeVisible();
      await track.same("refused");
      await page.keyboard.press("Escape");

      // Add link and New collection keep the line of an error.
      await page.getByRole("button", { name: t("sidebar.newLink") }).first().click();
      await track.open("add link");
      await dialog.getByRole("textbox").first().fill("ftp://example.com/file");
      await button("add.save").click();
      await expect(dialog.getByRole("alert")).toBeVisible();
      await track.same("error");
      await page.keyboard.press("Escape");
      await page.evaluate(async () => {
        const { api } = await import("/src/services/api.ts");
        const { CommandError } = await import("/src/services/errors.ts");
        api.createCollection = async () => {
          throw new CommandError("database_busy", "database is locked");
        };
      });
      // A narrow window has no «New collection» in the sidebar.
      if (width > 800) {
        await page.getByRole("button", { name: t("sidebar.newCollection") }).first().click();
        await track.open("new collection");
        await dialog.getByRole("textbox").fill("Reading");
        await button("collection.create").click();
        await expect(dialog.getByRole("alert")).toBeVisible();
        await track.same("error");
        await page.keyboard.press("Escape");
      }

      // Restore a backup: the list, the confirmation and back, the report, a refused file.
      await settings();
      await page.getByRole("button", { name: t("settings.restore"), exact: true }).click();
      await track.open("backup");
      await expect(dialog.getByRole("radio").first()).toBeVisible();
      await track.same("listed");
      await button("backup.run").click();
      await track.same("confirm");
      await button("common.keep").click();
      await track.same("kept");
      await button("backup.run").click();
      await page.keyboard.press("Escape");
      await expect(dialog.getByRole("radio").first()).toBeVisible();
      await track.same("Escape on confirm");
      await button("backup.run").click();
      await button("backup.confirm").click();
      await expect(dialog.getByRole("status")).toBeVisible();
      await track.same("done");
      await button("import.done").click();
      await page.evaluate(async () => {
        const { api } = await import("/src/services/api.ts");
        api.pickBackup = async () => ({ outcome: "rejected", file_name: "notes.db", problem: { problem: "not_database" } });
      });
      await page.getByRole("button", { name: t("settings.restore"), exact: true }).click();
      await track.open("backup");
      await button("backup.choose").click();
      await expect(dialog.getByRole("alert")).toBeVisible();
      await track.same("refused");
      await page.keyboard.press("Escape");

      // Feedback: the form, the report shown, a wrong address, a failure, sent.
      await page.getByRole("button", { name: t("settings.feedbackButton") }).click();
      await track.open("feedback");
      await button("feedback.showReport").click();
      await track.same("report shown");
      // In a low window the form scrolls; the report keeps its lines.
      expect((await dialog.getByLabel(t("feedback.report"), { exact: true }).boundingBox())!.height).toBeGreaterThan(80);
      await dialog.getByRole("textbox", { name: t("feedback.message") }).fill("The grid jumps when a card loads.");
      await dialog.getByRole("textbox", { name: t("feedback.email") }).fill("anna@example");
      await button("feedback.send").click();
      await expect(dialog.getByRole("textbox", { name: t("feedback.email") })).toHaveAttribute("aria-invalid", "true");
      await track.same("wrong address");
      await dialog.getByRole("textbox", { name: t("feedback.email") }).fill("");
      await page.evaluate(async () => {
        const { api } = await import("/src/services/api.ts");
        const { CommandError } = await import("/src/services/errors.ts");
        const send = api.sendFeedback.bind(api);
        let failed = false;
        api.sendFeedback = async (feedback) => {
          if (failed) return send(feedback);
          failed = true;
          throw new CommandError("network", "offline", "no_connection");
        };
      });
      await button("feedback.send").click();
      await expect(dialog.getByRole("alert")).toBeVisible();
      await track.same("failed");
      await expect(button("common.retry")).toBeInViewport({ ratio: 1 });
      await button("common.retry").click();
      await expect(dialog.getByRole("status").filter({ hasText: t("feedback.sentTitle") })).toBeVisible();
      await track.same("sent");
      await button("feedback.done").click();

      // Update: the offer with what's new, the download, the installation; then a failure.
      const update = async () => {
        await settings();
        await page.getByRole("button", { name: t("settings.updateButton") }).click();
      };
      await update();
      await track.open("update");
      await button("update.update").click();
      await expect(dialog.getByRole("progressbar")).toBeVisible();
      await track.same("downloading");
      await expect(dialog.getByRole("status")).toBeVisible({ timeout: 10_000 });
      await track.same("installing");
      await expect(dialog).toHaveCount(0, { timeout: 5_000 });
      await page.evaluate(() => localStorage.setItem("koonapin.demo.update", "failing"));
      await page.reload();
      await update();
      await track.open("update");
      await button("update.update").click();
      await expect(dialog.getByRole("alert")).toBeVisible({ timeout: 10_000 });
      await track.same("failed");

      await info.attach("heights", { body: JSON.stringify(track.heights), contentType: "application/json" });
      console.log(`${code} ${width}×${height}`, JSON.stringify(track.heights));
    });
  }
}

test("dialogs with tabs keep their size and place when the tab changes", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
  const track = tracker(page);
  const steady = async (name: string, tabs: string[]) => {
    await track.open(name);
    for (const tab of tabs) {
      await track.dialog.getByRole("radio", { name: tab }).click();
      await expect(track.dialog.locator("[data-tab-panel][data-active]")).toBeVisible();
      await track.same(tab);
    }
    await page.keyboard.press("Escape");
  };
  await page.getByRole("button", { name: "No browser yet" }).click();
  await steady("Connect browser", ["Edge", "Firefox", "Chrome"]);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Let AI assistants use your library" }).click();
  await page.getByRole("button", { name: "How to connect…" }).click();
  await steady("Connect an AI assistant", ["Claude Code", "ChatGPT", "Custom", "Claude Desktop"]);
});
