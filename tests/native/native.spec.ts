import { test, expect, chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";
import net from "node:net";
import { assertNoOtherApp, capture, hello, hostMessage, pipeReady, testPipe } from "../../scripts/lib/native-host.mjs";

// The test apps are single-instance too: a running Netami Pin would take them over.
test.beforeAll(() => assertNoOtherApp());

test("real WebView2, SQLite, capture through the host, close-to-tray and single instance", async ({
  request,
}) => {
  const data = path.resolve(".test-data", `webview-${Date.now()}`);
  await mkdir(data, { recursive: true });
  const executable = path.resolve(
    process.env.NETAMIPIN_TEST_BINARY || "src-tauri/target/debug/netamipin.exe",
  );
  const env = {
    ...process.env,
    NETAMIPIN_DATA_DIR: data,
    WEBVIEW2_USER_DATA_FOLDER: path.join(data, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9225",
    NETAMIPIN_PIPE: testPipe("webview"),
  };
  const processHandle = spawn(executable, [], {
    env,
    windowsHide: true,
    stdio: "ignore",
  });
  let browser;
  try {
    await expect
      .poll(
        async () => {
          try {
            return (
              await request.get("http://127.0.0.1:9225/json/version", {
                timeout: 500,
              })
            ).ok();
          } catch {
            return false;
          }
        },
        { timeout: 20000 },
      )
      .toBe(true);
    browser = await chromium.connectOverCDP("http://127.0.0.1:9225");
    const context = browser.contexts()[0];
    const page =
      context.pages().find((p) => p.url().includes("1420")) ??
      context.pages()[0];
    page.on("pageerror", (error) =>
      console.error("WebView page error:", error.message),
    );
    await expect(
      page.getByRole("heading", { name: "Your bookmarks will live here" }),
    ).toBeVisible({ timeout: 15000 });
    // A new library speaks English: its first collections are named by the interface,
    // listed by name (NP-085).
    await expect
      .poll(() => page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke("get_collections")).map((c: { name: string }) => c.name)))
      .toEqual(["Articles / To read", "Design & UI", "Development"]);
    await page
      .getByRole("button", { name: "Add link", exact: true })
      .first()
      .click();
    await page
      .getByLabel("Link", { exact: true })
      .fill("https://example.invalid/native-ui");
    await page.getByLabel("Title", { exact: true }).fill("SQLite check");
    await page
      .getByLabel("Collection", { exact: true })
      .selectOption({ label: "Development" });
    await page.getByRole("button", { name: "Save link" }).click();
    await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
    await page.locator("[data-bookmark-id]").hover();
    await page.getByRole("button", { name: /^Actions:/ }).click();
    await page.getByRole("menuitem", { name: "Edit…" }).click();
    await page.getByLabel("Collection", { exact: true }).selectOption("");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect(page.locator("[data-bookmark-id] [data-collection]")).toContainText(
      "No collection",
    );
    // The link added by hand waited in the inbox; saving it in the editor sorted it.
    await expect(page.getByRole("button", { name: "Inbox", exact: true })).toBeVisible();
    // Nothing has written yet: the browser is not connected.
    await expect(page.getByRole("button", { name: "Browser not connected" })).toBeVisible();
    const captured = await hostMessage(
      capture("webview-incoming", "https://example.invalid/native-host", "From the browser", "edge"),
      { env },
    );
    expect(captured.reply).toMatchObject({ ok: true, outcome: "created" });
    await expect(page.locator("[data-bookmark-id]")).toHaveCount(2);
    // The capture tells the app about the browser; the status updates by itself.
    await expect(page.getByRole("button", { name: "Browser connected" })).toBeVisible();
    // The capture waits in the inbox at once: badge, banner, section.
    await expect(page.getByRole("button", { name: "Inbox 1", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "New bookmarks" })).toContainText("1 new bookmark is waiting");
    await page.getByRole("button", { name: "Inbox 1", exact: true }).click();
    await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
    await expect(page.locator("[data-bookmark-id]")).toContainText("From the browser");
    await page.getByRole("button", { name: "All bookmarks" }).click();
    // FTS5 through IPC: the capture is in the index, case folds.
    const search = page.getByRole("textbox", { name: "Search the library" });
    await search.fill("BROWSER native");
    await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
    await expect(page.getByText("1 of 2")).toBeVisible();
    await search.fill("");
    await expect(page.locator("[data-bookmark-id]")).toHaveCount(2);
    console.log(
      "WebView2 viewport:",
      await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        scale: devicePixelRatio,
      })),
    );
    await page.getByRole("button", { name: "Maximize", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Restore", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Restore", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Maximize", exact: true }),
    ).toBeVisible();
    // The restored window can land a row under the cursor; the docs show the list at rest.
    await page.mouse.move(1, 1);
    await page.waitForTimeout(300);
    await page.screenshot({ path: "doc/concepts/native-webview2.jpg" });
    await page
      .getByRole("button", { name: "Close window", exact: true })
      .click();
    // In the tray the app still answers the browser.
    expect((await hostMessage(hello(), { env })).reply.ok).toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible"),
        ),
      )
      .toBe(false);
    const second = spawn(executable, [], {
      env,
      windowsHide: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        second.kill();
        reject(new Error("Second instance did not exit"));
      }, 5000);
      second.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible"),
        ),
      )
      .toBe(true);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    // Edge saved; the hello above came from Chrome.
    await expect(page.locator('[data-capture="connected"]')).toContainText("Connected: Chrome, Edge");
    await expect(page.locator('[data-capture="connected"]')).toContainText(/Last saved today at .* from Edge/);
    // The tray speaks the interface's language and follows a switch without a restart (NP-085).
    const trayLabels = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_tray_labels"));
    expect(await trayLabels()).toEqual({ open: "Open Netami Pin", quit: "Quit", tooltip: "Netami Pin — your link library" });
    await page.getByLabel("Language", { exact: true }).selectOption("ru");
    await expect.poll(trayLabels).toEqual({ open: "Открыть Netami Pin", quit: "Выйти", tooltip: "Netami Pin — библиотека ссылок" });
    await page.getByLabel("Язык", { exact: true }).selectOption("en");
    await expect.poll(trayLabels).toEqual({ open: "Open Netami Pin", quit: "Quit", tooltip: "Netami Pin — your link library" });
    // A launch from the host (--autostart) does not show the window.
    await page.getByRole("button", { name: "Close window", exact: true }).click();
    const fromHost = spawn(executable, ["--autostart"], { env, windowsHide: true, stdio: "ignore" });
    await new Promise<void>((resolve) => fromHost.on("exit", () => resolve()));
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible"))).toBe(false);
    const shown = spawn(executable, [], { env, windowsHide: true, stdio: "ignore" });
    await new Promise<void>((resolve) => shown.on("exit", () => resolve()));
    await expect
      .poll(() => page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible")))
      .toBe(true);
    const tray = page.getByRole("switch", {
      name: "Keep the app in the tray when the window is closed",
    });
    await expect(tray).toHaveAttribute("aria-checked", "true");
    await tray.click();
    await expect(tray).toHaveAttribute("aria-checked", "false");
    await expect(tray).toBeEnabled();
    const exited = new Promise<void>((resolve) =>
      processHandle.once("exit", () => resolve()),
    );
    await page
      .getByRole("button", { name: "Close window", exact: true })
      .click();
    await exited;
  } finally {
    await browser?.close();
    processHandle.kill();
  }
});

test("a capture pipe held by another program is reported while the library stays usable", async ({
  request,
}) => {
  // Another program holds the name first: the app does not share it and says why.
  const name = testPipe("held");
  const holder = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    holder.once("error", reject);
    holder.listen(`\\\\.\\pipe\\${name}`, resolve);
  });
  const data = await folder("held-pipe");
  const app = await launch(request, { ...isolated(data), NETAMIPIN_PIPE: name });
  try {
    const page = app.page;
    await expect(page.getByRole("button", { name: "Capture isn't working" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("alert").filter({ hasText: "couldn't open its capture channel" })).toBeVisible();
    await page.getByRole("button", { name: "Details", exact: true }).click();
    const block = page.locator('[data-capture="failing"]');
    await expect(block).toContainText("Netami Pin couldn't open its capture channel");
    await page.screenshot({ path: "test-results/capture-failing.png" });
    // The other program leaves: «Try again» opens the pipe.
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    await block.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.locator('[data-capture="none"]')).toBeVisible();
    await expect.poll(() => pipeReady(name)).toBe(true);
    // The library worked all along.
    await page.getByRole("button", { name: "All bookmarks" }).click();
    await page.getByRole("button", { name: "Add link", exact: true }).first().click();
    await page.getByLabel("Link", { exact: true }).fill("https://example.invalid/while-held");
    await page.getByRole("button", { name: "Save link" }).click();
    await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
    holder.close();
  }
});
const binary = () =>
  path.resolve(
    process.env.NETAMIPIN_TEST_BINARY || "src-tauri/target/debug/netamipin.exe",
  );

async function launch(
  request: import("@playwright/test").APIRequestContext,
  env: Record<string, string>,
  args: string[] = [],
) {
  // WebView2 of a previously killed app may still answer on the debugging port.
  // Only a refused connection means it is gone: one busy shutting down only times
  // out, and the test would then drive the old window and its library.
  await expect
    .poll(
      async () => {
        try {
          await request.get("http://127.0.0.1:9225/json/version", {
            timeout: 500,
          });
          return false;
        } catch (error) {
          return String(error).includes("ECONNREFUSED");
        }
      },
      { timeout: 15000 },
    )
    .toBe(true);
  const processHandle = spawn(binary(), args, {
    env: {
      ...process.env,
      ...env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9225",
    },
    windowsHide: true,
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolve) =>
    processHandle.once("exit", () => resolve()),
  );
  await expect
    .poll(
      async () => {
        try {
          return (
            await request.get("http://127.0.0.1:9225/json/version", {
              timeout: 500,
            })
          ).ok();
        } catch {
          return false;
        }
      },
      { timeout: 20000 },
    )
    .toBe(true);
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9225");
  const page = browser.contexts()[0].pages()[0];
  return { processHandle, exited, browser, page };
}

const NPIN = 0x4e50494e;
/** A library, WebView2 profile and capture pipe of the test's own. */
const isolated = (data: string) => ({
  NETAMIPIN_DATA_DIR: data,
  WEBVIEW2_USER_DATA_FOLDER: path.join(data, "webview"),
  NETAMIPIN_PIPE: testPipe(path.basename(data)),
});
async function folder(name: string) {
  const data = path.resolve(".test-data", `${name}-${Date.now()}`);
  await mkdir(data, { recursive: true });
  return data;
}
/** The capture pipe opens only with the library. */
const captureOpen = (env: { NETAMIPIN_PIPE: string }) => pipeReady(env.NETAMIPIN_PIPE);

test("a start in the tray: the hidden window still gives the tray its words (NP-085)", async ({ request }) => {
  const env = isolated(await folder("tray-language"));
  const russian = { open: "Открыть Netami Pin", quit: "Выйти", tooltip: "Netami Pin — библиотека ссылок" };
  let app = await launch(request, env);
  try {
    await expect(app.page.getByRole("heading", { name: "Your bookmarks will live here" })).toBeVisible({ timeout: 15000 });
    await app.page.getByRole("button", { name: "Settings", exact: true }).click();
    await app.page.getByLabel("Language", { exact: true }).selectOption("ru");
    await app.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("quit_app"));
    await app.exited;
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
  }
  // As at sign-in: the window stays hidden, the interface loads and tells the tray.
  app = await launch(request, env, ["--autostart"]);
  try {
    const labels = () => app.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_tray_labels"));
    await expect.poll(labels, { timeout: 15000 }).toEqual(russian);
    expect(await app.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible"))).toBe(false);
    await app.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("quit_app"));
    await app.exited;
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
  }
});

test("library of a newer version shows a screen and stays unchanged", async ({
  request,
}) => {
  const data = await folder("newer-schema");
  const file = path.join(data, "netamipin.db");
  const db = new DatabaseSync(file);
  // Far beyond any schema this build knows.
  db.exec(
    `CREATE TABLE bookmarks (url TEXT); PRAGMA application_id = ${NPIN}; PRAGMA user_version = 99;`,
  );
  db.close();
  const before = await readFile(file);
  const env = isolated(data);
  const app = await launch(request, env);
  try {
    const screen = app.page.locator('[data-error-code="DB_NEWER_SCHEMA"]');
    await expect(screen).toBeVisible({ timeout: 15000 });
    await expect(screen).toContainText("netamipin.db · DB_NEWER_SCHEMA");
    await expect(screen).toContainText("pin.netami.app");
    // Nothing writes in this state: no capture pipe, no library commands.
    expect(await captureOpen(env)).toBe(false);
    expect(
      await app.page.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke("get_counts").then(
          () => "answered",
          () => "refused",
        ),
      ),
    ).toBe("refused");
    await app.page.screenshot({ path: "test-results/library-newer-schema.png" });
    // Try again is not offered: only a newer version can open this library.
    await expect(screen.getByRole("button")).toHaveCount(3);
    await screen.getByRole("button").last().click();
    await app.exited;
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
  }
  expect((await readFile(file)).equals(before)).toBe(true);
  expect((await readdir(data)).some((name) => name === "backups")).toBe(false);
});

test("library of an earlier build is moved aside and a new one is created", async ({
  request,
}) => {
  const data = await folder("before-schema-1");
  const db = new DatabaseSync(path.join(data, "netamipin.db"));
  db.exec(`CREATE TABLE bookmarks (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
    INSERT INTO bookmarks (url, title) VALUES ('https://example.invalid/old', 'Old');
    PRAGMA user_version = 1;`);
  db.close();
  const app = await launch(request, isolated(data));
  try {
    await expect(
      app.page.getByRole("heading", { name: "Your bookmarks will live here" }),
    ).toBeVisible({ timeout: 15000 });
    await expect(app.page.getByRole("status")).toContainText("netamipin.old-");
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
  }
  const old = (await readdir(data)).find((name) => /^netamipin\.old-.*\.db$/.test(name));
  expect(old).toBeTruthy();
  const kept = new DatabaseSync(path.join(data, old!), { readOnly: true });
  expect(kept.prepare("SELECT title FROM bookmarks").get()).toEqual({ title: "Old" });
  kept.close();
});

test("damaged library is detected in the background and not written", async ({
  request,
}) => {
  const data = await folder("damaged");
  const file = path.join(data, "netamipin.db");
  // A real library first, then enough rows to damage pages in the middle.
  const first = await launch(request, isolated(data));
  try {
    await expect(
      first.page.getByRole("heading", { name: "Your bookmarks will live here" }),
    ).toBeVisible({ timeout: 15000 });
    await first.page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("quit_app"),
    ).catch(() => {});
    await first.exited;
  } finally {
    await first.browser.close().catch(() => {});
    first.processHandle.kill();
  }
  const db = new DatabaseSync(file);
  const insert = db.prepare(
    "INSERT INTO bookmarks (uid,url,title,domain,created_at,updated_at) VALUES (?,?,?,?,?,?)",
  );
  db.exec("BEGIN");
  for (let i = 0; i < 3000; i++)
    insert.run(randomUUID(), `https://example.invalid/${i}`, `Link ${i}`, "example.invalid", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();
  const bytes = await readFile(file);
  bytes.fill(0xa5, bytes.length / 2, bytes.length / 2 + 16384);
  await writeFile(file, bytes);
  // The intact library got its first automatic copy on the first start.
  const copies = await readdir(path.join(data, "backups"));
  expect(copies).toHaveLength(1);

  const app = await launch(request, isolated(data));
  try {
    await expect(app.page.getByRole("alert").filter({ hasText: "The library is damaged" })).toBeVisible({ timeout: 15000 });
    await app.page.screenshot({ path: "test-results/library-damaged.png" });
    const written = await app.page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("add_bookmark", {
        url: "https://example.invalid/after-damage",
        title: null,
        collectionId: null,
        tags: [],
      }).then(
        () => "saved",
        (error: unknown) => error,
      ),
    );
    expect(written).toMatchObject({ code: "read_only" });
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
  }
  // The damaged library is not copied, and the good copy stays.
  expect(await readdir(path.join(data, "backups"))).toEqual(copies);
});

test("import of 10 000 links keeps the window responsive", async ({ request }) => {
  const data = await folder("import-10k");
  const app = await launch(request, isolated(data));
  try {
    await expect(
      app.page.getByRole("heading", { name: "Your bookmarks will live here" }),
    ).toBeVisible({ timeout: 15000 });
    const result = await app.page.evaluate(async () => {
      let html = "<DL>";
      for (let i = 0; i < 10000; i++)
        html += `<DT><A HREF="https://example.invalid/${i}">Link ${i}</A>`;
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const started = performance.now();
      let finished = 0;
      const importing = invoke("import_html_bookmarks", { htmlContent: html }).then(
        (summary: { added: number }) => {
          finished = performance.now();
          return summary.added;
        },
      );
      // get_library_status is a sync command: it runs on the main thread and
      // waits for it, so its delay shows whether the window is blocked.
      const delays: number[] = [];
      while (!finished && delays.length < 200) {
        const sent = performance.now();
        await invoke("get_library_status");
        delays.push(performance.now() - sent);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return {
        imported: await importing,
        importMs: Math.round(finished - started),
        probes: delays.length,
        worstMs: Math.round(Math.max(0, ...delays)),
      };
    });
    console.log("Import of 10 000 links:", result);
    expect(result.imported).toBe(10000);
    expect(result.probes).toBeGreaterThan(1);
    expect(result.worstMs).toBeLessThan(250);
    await expect(app.page.locator("h1")).toContainText("10000");
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
  }
});

test("import of the three browsers' files: folders into collections in SQLite, the inbox, nothing twice", async ({ request }) => {
  const data = await folder("import-browsers");
  const app = await launch(request, isolated(data));
  try {
    const page = app.page;
    await expect(page.getByRole("heading", { name: "Your bookmarks will live here" })).toBeVisible({ timeout: 15000 });
    const files = Object.fromEntries(
      await Promise.all(
        ["chrome", "edge", "firefox"].map(async (name) => [name, await readFile(path.join("tests/fixtures/bookmarks", `${name}.html`), "utf8")]),
      ),
    );
    const result = await page.evaluate(async (files) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const run = (html: string, toInbox: boolean) => invoke("import_html_bookmarks", { htmlContent: html, toInbox });
      const chrome = await run(files.chrome, false);
      const edge = await run(files.edge, false);
      const firefox = await run(files.firefox, true);
      const again = await run(files.chrome, false);
      const collections = ((await invoke("get_collections")) as { name: string; count: number }[]).map((c) => `${c.name}:${c.count}`);
      const counts = await invoke("get_counts");
      return { chrome, edge, firefox, again, collections, counts };
    }, files);
    expect(result.chrome).toMatchObject({ added: 7, not_web: 2, repeated: 1, collections: ["Работа", "Чтение"], tags: 2 });
    expect(result.edge).toMatchObject({ added: 4, not_web: 1, invalid: 1, collections: ["Design"] });
    expect(result.firefox).toMatchObject({ added: 7, not_web: 1, collections: ["Mozilla Firefox", "Recipes", "Reading"] });
    expect(result.again).toMatchObject({ added: 0, existing: 7, collections: [], tags: 0 });
    // Edge's «работа» landed in Chrome's «Работа».
    expect(result.collections).toEqual(expect.arrayContaining(["Работа:4", "Чтение:1", "Design:2", "Recipes:2", "Reading:1"]));
    expect(result.counts).toMatchObject({ total: 18, inbox: 7, inbox_imported: 7 });
    await expect(page.getByRole("region", { name: "New bookmarks" })).toContainText("7 of them from the import");
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
  }
});

test("restore from JSON through IPC: a refused copy changes nothing, a replace leaves a backup of the old library first", async ({ request }) => {
  const data = await folder("restore-json");
  const app = await launch(request, isolated(data));
  try {
    const page = app.page;
    await expect(page.getByRole("heading", { name: "Your bookmarks will live here" })).toBeVisible({ timeout: 15000 });
    const chrome = await readFile(path.join("tests/fixtures/bookmarks", "chrome.html"), "utf8");
    const result = await page.evaluate(async (chrome) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      await invoke("import_html_bookmarks", { htmlContent: chrome, toInbox: false });
      const at = "2026-09-01T10:00:00.000Z";
      const copy = {
        format: "netami-pin", version: 1, exported_at: at, app_version: "0.1.0",
        collections: [{ uid: "c1", name: "From the copy", color: null, icon: null, created_at: at }],
        tags: [],
        bookmarks: [
          { uid: "b1", url: "https://copy.example/1", title: "First", description: null, notes: "a note", domain: "copy.example", image_url: null, favicon_url: null,
            is_favorite: true, collection: "c1", tags: ["copy"], source: "chrome", created_at: at, updated_at: at, triaged_at: null, deleted_at: null },
        ],
      };
      const refused = await invoke("restore_library", { content: JSON.stringify({ ...copy, version: 9 }), mode: "replace" });
      const countsAfterRefused = await invoke("get_counts");
      const check = await invoke("check_restore", { content: JSON.stringify(copy) });
      const restored = await invoke("restore_library", { content: JSON.stringify(copy), mode: "replace" });
      const counts = await invoke("get_counts");
      const collections = ((await invoke("get_collections")) as { name: string }[]).map((c) => c.name);
      return { refused, countsAfterRefused, check, restored, counts, collections };
    }, chrome);
    expect(result.refused).toEqual({ outcome: "rejected", problem: { problem: "newer", version: 9 } });
    expect(result.countsAfterRefused).toMatchObject({ total: 7 });
    expect(result.check).toMatchObject({ outcome: "ready", preview: { bookmarks: 1, collections: 1, current: 7 } });
    expect(result.restored).toMatchObject({ outcome: "restored", summary: { added: 1, in_inbox: 1, collections: ["From the copy"] } });
    expect(result.counts).toMatchObject({ total: 1, inbox: 1, favorites: 1 });
    expect(result.collections).toEqual(["From the copy"]);
    const backupName = (result.restored as { summary: { backup: string } }).summary.backup;
    const backups = await readdir(path.join(data, "backups"));
    expect(backups).toContain(backupName);
    const saved = new DatabaseSync(path.join(data, "backups", backupName), { readOnly: true });
    expect(saved.prepare("SELECT count(*) AS n FROM bookmarks").get()).toEqual({ n: 7 });
    saved.close();
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
  }
});

test("backup: copy, changes, restore in place with capture working after it; a broken file is replaced from the error screen", async ({ request }) => {
  const data = await folder("restore-backup");
  const env = isolated(data);
  const hostEnv = { ...process.env, ...env };
  const counts = (page: import("@playwright/test").Page) =>
    page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_counts")) as Promise<{ total: number }>;
  const app = await launch(request, env);
  try {
    const page = app.page;
    await expect(page.getByRole("heading", { name: "Your bookmarks will live here" })).toBeVisible({ timeout: 15000 });
    await captureOpen(env);
    const save = (id: string, url: string) => hostMessage(capture(id, url, id, "chrome"), { env: hostEnv });
    expect((await save("before-copy", "https://example.invalid/before-copy")).reply).toMatchObject({ ok: true, outcome: "created" });
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("back_up_now"));
    // Changes after the copy: they stay in the WAL of the open library.
    expect((await save("after-copy", "https://example.invalid/after-copy")).reply).toMatchObject({ ok: true, outcome: "created" });
    expect(await counts(page)).toMatchObject({ total: 2 });

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Restore…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Restore from a backup" });
    await expect(dialog.getByRole("radio").first()).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByRole("radio").first()).toContainText("1 bookmark");
    await dialog.getByRole("button", { name: "Restore…" }).click();
    const confirm = page.getByRole("dialog", { name: /^Restore the copy from today/ });
    await expect(confirm).toContainText("The library has 2 bookmarks now; the copy holds 1");
    await confirm.getByRole("button", { name: "Restore", exact: true }).click();
    const report = page.getByRole("dialog", { name: "Library restored" });
    await expect(report).toContainText("1 bookmark from the copy of today");
    await page.screenshot({ path: "test-results/backup-restored.png" });
    const previous = (await report.locator("span.text-subtle").innerText()).trim();
    await report.getByRole("button", { name: "Done" }).click();
    expect(await counts(page)).toMatchObject({ total: 1 });
    // The replaced library is kept with the change made after the copy.
    const saved = new DatabaseSync(path.join(data, "backups", previous), { readOnly: true });
    expect(saved.prepare("SELECT count(*) AS n FROM bookmarks").get()).toEqual({ n: 2 });
    saved.close();
    // Capture through the host works on the restored library, and the link
    // saved after the copy comes back when the extension sends it again.
    expect((await save("after-copy", "https://example.invalid/after-copy")).reply).toMatchObject({ ok: true, outcome: "created" });
    expect((await save("after-restore", "https://example.invalid/after-restore")).reply).toMatchObject({ ok: true, outcome: "created" });
    expect(await counts(page)).toMatchObject({ total: 3 });
    // The open window shows both. «after-copy» comes back under the id it had
    // before the restore, with a lower revision than the window saw then.
    await page.getByRole("button", { name: "All bookmarks" }).click();
    await expect(page.locator("[data-bookmark-id]")).toHaveCount(3);
    await expect(page.getByRole("button", { name: "after-copy", exact: true })).toBeVisible();
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("quit_app")).catch(() => {});
    await app.exited;
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
  }

  // A file that is not a database where the library was: the error screen restores a copy.
  // Without its WAL, which after the restore holds every page of the library.
  await rm(path.join(data, "netamipin.db-wal"), { force: true });
  await rm(path.join(data, "netamipin.db-shm"), { force: true });
  await writeFile(path.join(data, "netamipin.db"), "This is not an SQLite file.\n");
  const broken = await launch(request, env);
  try {
    const page = broken.page;
    await expect(page.locator("[data-error-code=DB_NOT_DATABASE]")).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: "Restore from backup…" }).click();
    const dialog = page.getByRole("dialog", { name: "Restore from a backup" });
    // The newest readable copy is the library as it was before the restore above.
    await expect(dialog.getByRole("radio").first()).toContainText("Before a restore");
    await dialog.getByRole("button", { name: "Restore…" }).click();
    const confirm = page.getByRole("dialog", { name: /^Restore the copy/ });
    await expect(confirm).toContainText("is moved to the backups folder as it is");
    await confirm.getByRole("button", { name: "Restore", exact: true }).click();
    await page.getByRole("dialog", { name: "Library restored" }).getByRole("button", { name: "Done" }).click();
    await captureOpen(env);
    expect(await counts(page)).toMatchObject({ total: 2 });
    expect((await hostMessage(capture("after-gate", "https://example.invalid/after-gate", "after-gate", "chrome"), { env: hostEnv })).reply).toMatchObject({
      ok: true,
      outcome: "created",
    });
  } finally {
    await broken.browser.close().catch(() => {});
    broken.processHandle.kill();
  }
  const kept = (await readdir(path.join(data, "backups"))).filter((name) => name.startsWith("netamipin.before-restore-"));
  const texts = await Promise.all(kept.map((name) => readFile(path.join(data, "backups", name), "utf8").catch(() => "")));
  expect(texts).toContain("This is not an SQLite file.\n");
});

test("duplicates: captured twins form a group in SQLite, merge is one command, Ctrl Z brings them back", async ({ request }) => {
  const data = await folder("duplicates");
  const env = isolated(data);
  const hostEnv = { ...process.env, ...env };
  const app = await launch(request, env);
  try {
    const page = app.page;
    await expect(page.getByRole("heading", { name: "Your bookmarks will live here" })).toBeVisible({ timeout: 15000 });
    await captureOpen(env);
    for (const [id, url] of [
      ["one", "https://example.invalid/page"],
      ["two", "http://www.example.invalid/page/?utm_source=mail"],
      ["three", "https://example.invalid/page#part"],
      ["other", "https://example.invalid/page?ref=x"],
    ])
      expect((await hostMessage(capture(id, url, id, "chrome"), { env: hostEnv })).reply).toMatchObject({ ok: true, outcome: "created" });
    await expect(page.getByRole("complementary").getByRole("button", { name: "Duplicates 1", exact: true })).toBeVisible();
    const result = await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const groups = (await invoke("get_duplicates")) as { key: string; main: number; bookmarks: { id: number; url: string }[] }[];
      const [group] = groups;
      const merged = await invoke("merge_duplicates", {
        groups: [{ main: group.main, others: group.bookmarks.filter((b) => b.id !== group.main).map((b) => b.id) }],
      });
      const after = await invoke("get_counts");
      const undone = await invoke("undo", { command: (merged as { command: number }).command });
      const back = await invoke("get_counts");
      return { groups, merged, after, undone: (undone as { outcome: string }).outcome, back };
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].key).toBe("example.invalid/page");
    expect(result.groups[0].bookmarks[0].url).toBe("https://example.invalid/page");
    expect(result.merged).toMatchObject({ groups: 1, trashed: 2 });
    expect(result.after).toMatchObject({ total: 2, trash: 2, duplicates: 0 });
    expect(result.undone).toBe("undone");
    expect(result.back).toMatchObject({ total: 4, trash: 0, duplicates: 1 });
    // «Not duplicates» and its undo change no bookmark, yet reach the count and the section.
    const nav = (name: string) => page.getByRole("complementary").getByRole("button", { name, exact: true });
    await nav("Duplicates 1").click();
    const group = page.locator("[data-duplicate-group='example.invalid/page']");
    await expect(group.getByRole("radio")).toHaveCount(3);
    // The counts read after the merge and the undo above (at most 150 ms later)
    // are done first, so only the hiding itself can change them now.
    await page.waitForTimeout(500);
    await group.getByRole("button", { name: "Not duplicates" }).click();
    await expect(page.getByRole("heading", { name: "No duplicates" })).toBeVisible();
    await expect(nav("Duplicates 0")).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(group.getByRole("radio")).toHaveCount(3);
    await expect(nav("Duplicates 1")).toBeVisible();
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
  }
  const db = new DatabaseSync(path.join(data, "netamipin.db"), { readOnly: true });
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
  expect(db.prepare("SELECT url_key, count(*) AS n FROM bookmarks GROUP BY url_key ORDER BY n DESC").all()).toEqual([
    { url_key: "example.invalid/page", n: 3 },
    { url_key: "example.invalid/page?ref=x", n: 1 },
  ]);
  db.close();
});

test("link check: runs in the background through IPC, a missing site is never broken, a local one is not requested, stop is at once", async ({ request }) => {
  const data = await folder("link-check");
  const env = isolated(data);
  const hostEnv = { ...process.env, ...env };
  // A local server that must get no request: the guard of NP-019 keeps it out.
  let hits = 0;
  const server = net.createServer((socket) => {
    hits++;
    socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const app = await launch(request, env);
  try {
    const page = app.page;
    await expect(page.getByRole("heading", { name: "Your bookmarks will live here" })).toBeVisible({ timeout: 15000 });
    await captureOpen(env);
    // `.invalid` never resolves (RFC 2606): three sites that are not found.
    for (const [id, url] of [
      ["one", "https://one.invalid/page"],
      ["two", "https://two.invalid/"],
      ["three", "https://three.invalid/a"],
      ["local", `http://127.0.0.1:${port}/router`],
    ])
      expect((await hostMessage(capture(id, url, id, "chrome"), { env: hostEnv })).reply).toMatchObject({ ok: true, outcome: "created" });
    const result = await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      type Report = { state: string; done: number; total: number; library: number; local: number; unchecked: number; finished_at: string | null; failed: { reason: string }[]; gone: unknown[] };
      const before = (await invoke("get_link_check")) as Report;
      await invoke("start_link_check", { ids: null, resume: false });
      // The window answers while the check runs.
      const started = performance.now();
      await invoke("get_counts");
      const answered = performance.now() - started;
      let report = before;
      for (let i = 0; i < 200 && (report = (await invoke("get_link_check")) as Report).state === "running"; i++)
        await new Promise((r) => setTimeout(r, 100));
      // A second run, stopped at once.
      await invoke("start_link_check", { ids: null, resume: false });
      const asked = performance.now();
      await invoke("stop_link_check");
      let stopped = report;
      for (let i = 0; i < 50 && (stopped = (await invoke("get_link_check")) as Report).state === "running"; i++)
        await new Promise((r) => setTimeout(r, 20));
      return { before, report, answered, stopped: stopped.state, stopTook: performance.now() - asked };
    });
    expect(result.before).toMatchObject({ state: "idle", library: 4, unchecked: 4, finished_at: null });
    expect(result.answered).toBeLessThan(500);
    expect(result.report).toMatchObject({ state: "idle", library: 4, local: 1, unchecked: 0, gone: [] });
    expect(result.report.failed.map((f) => f.reason)).toEqual(["no_site", "no_site", "no_site"]);
    expect(result.report.finished_at).not.toBeNull();
    expect(result.stopped).toBe("stopped");
    expect(result.stopTook).toBeLessThan(1000);
    // Nothing to decide: no sidebar entry; the section shows what could not be checked.
    await expect(page.getByRole("complementary").getByRole("button", { name: /^Link check/ })).toHaveCount(0);
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
    server.close();
  }
  expect(hits).toBe(0);
  const db = new DatabaseSync(path.join(data, "netamipin.db"), { readOnly: true });
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
  expect(db.prepare("SELECT outcome, reason, count(*) AS n FROM link_checks GROUP BY outcome, reason ORDER BY outcome").all()).toEqual([
    { outcome: "failed", reason: "no_site", n: 3 },
    { outcome: "local", reason: null, n: 1 },
  ]);
  db.close();
});

test("Ctrl A selects 10 000 bookmarks from SQLite without loading their pages", async ({ request }) => {
  const data = await folder("select-10k");
  const app = await launch(request, isolated(data));
  try {
    const page = app.page;
    await expect(page.getByRole("heading", { name: "Your bookmarks will live here" })).toBeVisible({ timeout: 15000 });
    await page.evaluate(async () => {
      let html = "<DL>";
      for (let i = 0; i < 10000; i++) html += `<DT><A HREF="https://example.invalid/${i}">Link ${i}</A>`;
      await window.__TAURI_INTERNALS__.invoke("import_html_bookmarks", { htmlContent: html });
    });
    await expect(page.locator("h1")).toContainText("10000", { timeout: 15000 });
    // The command alone, ten times after a warm-up.
    const commandMs = await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const times: number[] = [];
      for (let i = 0; i < 11; i++) {
        const started = performance.now();
        const ids = (await invoke("get_bookmark_ids", { query: { only_favorites: false, only_inbox: false, only_trash: false } })) as number[];
        if (ids.length !== 10000) throw new Error(`${ids.length} ids`);
        if (i) times.push(performance.now() - started);
      }
      return Math.round(Math.max(...times));
    });
    // The key press until the bar counts every bookmark.
    await page.locator('[data-scroll="main"]').click({ position: { x: 5, y: 5 } });
    const pressMs = await page.evaluate(async () => {
      const started = performance.now();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
      while (!document.querySelector('[role="toolbar"] [role="status"]')?.textContent?.startsWith("10000"))
        await new Promise((resolve) => requestAnimationFrame(resolve));
      return Math.round(performance.now() - started);
    });
    console.log("Ctrl A over 10 000:", { commandMs, pressMs });
    await expect(page.locator("[data-loaded]")).toHaveAttribute("data-loaded", "100");
    // «No noticeable delay»: well under the 100 ms of an instant response.
    expect(pressMs).toBeLessThan(100);
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
  }
});

test("bulk actions on 1 000 bookmarks: one transaction in SQLite, the window keeps drawing, undone whole", async ({ request }) => {
  const data = await folder("bulk-1k");
  const app = await launch(request, isolated(data));
  try {
    const page = app.page;
    await expect(page.getByRole("heading", { name: "Your bookmarks will live here" })).toBeVisible({ timeout: 15000 });
    await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      let html = "<DL>";
      for (let i = 0; i < 1000; i++) html += `<DT><A HREF="https://bulk.invalid/${i}" TAGS="old">Link ${i}</A>`;
      await invoke("import_html_bookmarks", { htmlContent: html });
      await invoke("create_collection", { name: "Batch", color: null, icon: null });
    });
    await page.reload();
    await expect(page.locator("h1")).toContainText("1000", { timeout: 15000 });
    const counts = () =>
      page.evaluate(async () => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        const collections = (await invoke("get_collections")) as { name: string; count: number }[];
        const tags = (await invoke("get_tags")) as { name: string; count: number }[];
        const library = (await invoke("get_counts")) as { total: number; trash: number; favorites: number };
        return {
          shelf: collections.find((c) => c.name === "Batch")?.count,
          tagged: tags.find((t) => t.name === "urgent")?.count ?? 0,
          total: library.total,
          trash: library.trash,
        };
      });

    // A failed action through IPC: a collection that is gone. Nothing is written.
    const failed = await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const ids = (await invoke("get_bookmark_ids", { query: {} })) as number[];
      return invoke("bulk_update", { ids, change: { action: "move", collection_id: 999999 } }).then(
        () => "written",
        (error: { code: string }) => error.code,
      );
    });
    expect(failed).toBe("not_found");
    expect(await counts()).toEqual({ shelf: 0, tagged: 0, total: 1000, trash: 0 });

    // Ctrl A, then «Move to…» → «Batch»: the frames keep coming while SQLite writes.
    await page.locator('[data-scroll="main"]').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Control+a");
    const bar = page.getByRole("toolbar", { name: "Selected bookmarks" });
    await expect(bar.getByRole("status")).toHaveText("1000 selected");
    await bar.getByRole("button", { name: "Move to…" }).click();
    const item = page.getByRole("menuitem", { name: "Batch" });
    await expect(item).toBeVisible();
    const moved = await page.evaluate(async () => {
      let longest = 0;
      let last = performance.now();
      let running = true;
      const frames = () => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
        if (running) requestAnimationFrame(frames);
      };
      requestAnimationFrame(frames);
      const started = performance.now();
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => e.textContent?.includes("Batch"))!.click();
      while (!document.body.textContent?.includes("moved to «Batch»")) await new Promise((resolve) => requestAnimationFrame(resolve));
      running = false;
      return { ms: Math.round(performance.now() - started), longestFrame: Math.round(longest) };
    });
    console.log("Move 1 000 in bulk:", moved);
    expect(moved.longestFrame).toBeLessThan(100);
    expect((await counts()).shelf).toBe(1000);

    // A tag to all, then Ctrl Z takes it off all of them and keeps the move.
    await bar.getByRole("button", { name: "Tag" }).click();
    await page.getByRole("combobox", { name: "Tag for the selected bookmarks" }).fill("urgent");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Tag «urgent» added to 1000 bookmarks")).toBeVisible();
    expect((await counts()).tagged).toBe(1000);
    await page.keyboard.press("Control+z");
    await expect(page.getByText("Undone for 1000 bookmarks")).toBeVisible();
    expect(await counts()).toEqual({ shelf: 1000, tagged: 0, total: 1000, trash: 0 });
    const kept = await page.evaluate(async () => {
      const { items } = (await window.__TAURI_INTERNALS__.invoke("get_bookmarks", { query: { limit: 1 } })) as { items: { tags: string[] }[] };
      return items[0].tags;
    });
    expect(kept).toEqual(["old"]);

    // Del: all of them to the trash in one go; Ctrl Z brings them back into «Batch».
    await page.keyboard.press("Delete");
    await expect(page.getByText("1000 bookmarks in Trash")).toBeVisible();
    expect(await counts()).toEqual({ shelf: 0, tagged: 0, total: 0, trash: 1000 });
    await page.keyboard.press("Control+z");
    await expect(page.getByText("Back from Trash: 1000 bookmarks")).toBeVisible();
    expect(await counts()).toEqual({ shelf: 1000, tagged: 0, total: 1000, trash: 0 });

    // NP-030: the same 1 000 dragged onto «Trash» with the mouse of WebView2 — the hint says it, SQLite does it.
    await page.locator('[data-scroll="main"]').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Control+a");
    await expect(bar.getByRole("status")).toHaveText("1000 selected");
    const from = (await page.locator("[data-bookmark-id][data-selected]").first().boundingBox())!;
    const to = (await page.getByRole("complementary").getByRole("button", { name: /^Trash/ }).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 8, { steps: 3 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
    await expect(page.locator("[data-drop-hint]")).toHaveText("Move 1000 to Trash");
    await page.mouse.up();
    await expect(page.getByText("1000 bookmarks in Trash")).toBeVisible();
    expect(await counts()).toEqual({ shelf: 0, tagged: 0, total: 0, trash: 1000 });
    await page.keyboard.press("Control+z");
    await expect(page.getByText("Back from Trash: 1000 bookmarks")).toBeVisible();
    expect(await counts()).toEqual({ shelf: 1000, tagged: 0, total: 1000, trash: 0 });
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
  }
});

test("foreign file: retry after moving it away opens a new library", async ({
  request,
}) => {
  const data = await folder("foreign-retry");
  const file = path.join(data, "netamipin.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA application_id = 305419896; CREATE TABLE notes (text TEXT);");
  db.close();
  const env = isolated(data);
  const app = await launch(request, env);
  try {
    const screen = app.page.locator('[data-error-code="DB_FOREIGN"]');
    await expect(screen).toBeVisible({ timeout: 15000 });
    // The first button is Try again and has the focus for the keyboard.
    await expect(screen.getByRole("button").first()).toBeFocused();
    expect(await captureOpen(env)).toBe(false);
    const { rename } = await import("node:fs/promises");
    await rename(file, path.join(data, "notes-of-another-app.db"));
    await app.page.keyboard.press("Enter");
    await expect(
      app.page.getByRole("heading", { name: "Your bookmarks will live here" }),
    ).toBeVisible({ timeout: 15000 });
    await expect.poll(() => captureOpen(env)).toBe(true);
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
  }
});

// A measurement, not a correctness check: about 35 s and sensitive to machine load.
// Not in `npm run test:native`; run it with `npm run test:perf` before a release
// and after changes to the grid, the list or paging (NP-012).
test("10 000 bookmarks scroll smoothly in the grid and the list", { tag: "@perf" }, async ({ request }) => {
  test.setTimeout(240_000);
  const data = await folder("scroll-10k");
  const app = await launch(request, isolated(data));
  try {
    await expect(
      app.page.getByRole("heading", { name: "Your bookmarks will live here" }),
    ).toBeVisible({ timeout: 15000 });
    await app.page.evaluate(async () => {
      let html = "<DL>";
      for (let i = 0; i < 10000; i++)
        html += `<DT><A HREF="https://site${i % 300}.invalid/${i}">Bookmark ${i} · Architecture and interfaces</A>`;
      await window.__TAURI_INTERNALS__.invoke("import_html_bookmarks", { htmlContent: html });
    });
    await expect(app.page.locator("h1")).toContainText("10000", { timeout: 15000 });
    for (const view of ["Grid", "List"]) {
      await app.page.getByRole("button", { name: view, exact: true }).click();
      await app.page.locator('[data-scroll="main"]').evaluate((el) => el.scrollTo({ top: 0 }));
      // Scroll to the end of the fully loaded list, a fast flick of 400 px per
      // frame; pages of 100 arrive from SQLite on the way.
      const result = await app.page.evaluate(async () => {
        const scroller = document.querySelector<HTMLElement>('[data-scroll="main"]')!;
        const loaded = () => Number(document.querySelector("[data-loaded]")?.getAttribute("data-loaded"));
        const gaps: number[] = [];
        let last = performance.now();
        for (let frame = 0; frame < 10_000; frame++) {
          const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
          if (atEnd && loaded() === 10000) break;
          scroller.scrollTop += 400;
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const now = performance.now();
          gaps.push(now - last);
          last = now;
        }
        gaps.sort((a, b) => a - b);
        const at = (p: number) => Math.round(gaps[Math.floor((gaps.length - 1) * p)] * 10) / 10;
        return {
          frames: gaps.length,
          p50: at(0.5),
          p95: at(0.95),
          max: at(1),
          over50: gaps.filter((g) => g > 50).length,
          loaded: loaded(),
          inDom: document.querySelectorAll("[data-bookmark-id]").length,
        };
      });
      console.log(`Scrolling 10 000 bookmarks, ${view}:`, result);
      expect(result.loaded).toBe(10000);
      expect(result.inDom).toBeLessThan(100);
      // Recorded in doc/testing.md; the bound only catches a clear regression.
      expect(result.p95).toBeLessThan(50);
    }
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
  }
});

test("find and edit in the new interface: search, site, editor, collection removal", async ({ request }) => {
  const data = await folder("find-edit");
  const app = await launch(request, isolated(data));
  try {
    const page = app.page;
    await expect(page.getByRole("heading", { name: "Your bookmarks will live here" })).toBeVisible({ timeout: 15000 });
    await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const shelf = await invoke("create_collection", { name: "Shelf", color: null, icon: null });
      const add = (url: string, title: string, tags: string[], collectionId: number | null) =>
        invoke("add_bookmark", { url, title, collectionId, tags });
      await add("https://site-a.invalid/1", "Ёлочные игрушки", ["праздник"], shelf.id);
      await add("https://site-a.invalid/2", "Гирлянды", [], shelf.id);
      await add("https://site-b.invalid/3", "Pie recipe", ["kitchen"], null);
    });
    const cards = page.locator("[data-bookmark-id]");
    await expect(cards).toHaveCount(3);

    // Search through IPC and FTS5: «елочн» finds «Ёлочные».
    const search = page.getByRole("textbox", { name: "Search the library" });
    await search.fill("елочн");
    await expect(cards).toHaveCount(1);
    await search.press("Escape");
    await expect(cards).toHaveCount(3);

    // The site filter is exact and shows a chip.
    await page.getByRole("button", { name: "Only bookmarks from site-a.invalid" }).first().click();
    await expect(cards).toHaveCount(2);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("2 of 3");
    await page.getByRole("button", { name: "Remove site filter site-a.invalid" }).click();

    // The editor writes title and tags to SQLite.
    const card = page.locator("[data-bookmark-id]", { hasText: "Pie recipe" });
    await card.hover();
    await card.getByRole("button", { name: /^Actions:/ }).click();
    await page.getByRole("menuitem", { name: "Edit…" }).click();
    await page.getByLabel("Title", { exact: true }).fill("Apple pie");
    const tags = page.getByLabel("Tags", { exact: true });
    await tags.fill("baking");
    await tags.press("Control+Enter");
    await expect(page.getByRole("status")).toContainText("Changes saved");
    const db = new DatabaseSync(path.join(data, "netamipin.db"), { readOnly: true });
    const saved = db
      .prepare(
        `SELECT b.title, group_concat(t.name, ',') AS tags FROM bookmarks b
         LEFT JOIN bookmark_tags bt ON bt.bookmark_id = b.id LEFT JOIN tags t ON t.id = bt.tag_id
         WHERE b.url = 'https://site-b.invalid/3' GROUP BY b.id`,
      )
      .get() as { title: string; tags: string };
    expect(saved.title).toBe("Apple pie");
    expect(saved.tags.split(",").sort()).toEqual(["baking", "kitchen"]);

    // Deleting a collection keeps its bookmarks, without a collection.
    await page.getByRole("button", { name: /^Shelf/ }).hover();
    await page.getByRole("button", { name: "Delete collection Shelf" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Shelf/ })).toHaveCount(0);
    await expect(cards).toHaveCount(3);
    const left = () =>
      db.prepare("SELECT count(*) AS n, sum(collection_id IS NULL) AS free FROM bookmarks").get();
    await expect.poll(left).toEqual({ n: 3, free: 3 });
    db.close();
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
  }
});
test("trash survives a restart, empties itself at start, deletes for good on request, restores with every field", async ({ request }) => {
  const data = await folder("trash-restart");
  const env = isolated(data);
  let app = await launch(request, env);
  try {
    let page = app.page;
    await expect(page.getByRole("heading", { name: "Your bookmarks will live here" })).toBeVisible({ timeout: 15000 });
    await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const shelf = await invoke("create_collection", { name: "Shelf", color: null, icon: null });
      const { bookmark } = await invoke("add_bookmark", { url: "https://trash.invalid/1", title: "To the trash and back", collectionId: shelf.id, tags: ["tag"] });
      await invoke("update_bookmark", { id: bookmark.id, patch: { notes: "Note", is_favorite: true, collection: { action: "keep" } } });
      for (const url of ["https://trash.invalid/old", "https://trash.invalid/recent"]) {
        const added = await invoke("add_bookmark", { url, title: null, collectionId: null, tags: [] });
        await invoke("trash_bookmark", { id: added.bookmark.id });
      }
    });
    const card = page.locator("[data-bookmark-id]");
    await expect(card).toHaveCount(1);
    // No confirmation: to the trash with an undo notice.
    await card.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to trash" }).click();
    await expect(page.locator(".fixed[role=status]")).toContainText("Moved to Trash");
    await expect(page.getByRole("button", { name: "Trash 3", exact: true })).toBeVisible();

    // Quit; meanwhile one bookmark has lain in the trash 40 days, another 10,
    // and the clock is trusted (looked at an hour ago).
    void page.evaluate(() => window.__TAURI_INTERNALS__.invoke("quit_app")).catch(() => {});
    await app.exited;
    await app.browser.close().catch(() => {});
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const edit = new DatabaseSync(path.join(data, "netamipin.db"));
    edit.prepare("UPDATE bookmarks SET deleted_at = ? WHERE url = ?").run(ago(40), "https://trash.invalid/old");
    edit.prepare("UPDATE bookmarks SET deleted_at = ? WHERE url = ?").run(ago(10), "https://trash.invalid/recent");
    edit
      .prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?), (?, ?)")
      .run("trash_clock_looked", ago(1 / 24), "trash_clock_wait_ms", "0");
    edit.close();

    // Started again: the cleanup at start takes only the old one.
    app = await launch(request, env);
    page = app.page;
    await page.getByRole("button", { name: "Trash 2", exact: true }).click({ timeout: 15000 });
    // «Delete forever» through IPC: only from the trash, once.
    const second = await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const { items } = await invoke("get_bookmarks", { query: { only_trash: true } });
      const recent = items.find((b: { url: string }) => b.url === "https://trash.invalid/recent");
      await invoke("delete_forever", { id: recent.id });
      return invoke("delete_forever", { id: recent.id }).then(
        () => "deleted",
        (e: { code: string }) => e.code,
      );
    });
    expect(second).toBe("not_found");
    await expect(page.getByRole("button", { name: "Trash 1", exact: true })).toBeVisible();
    const trashed = page.locator("[data-bookmark-id]");
    await expect(trashed).toHaveCount(1);
    await trashed.hover();
    await trashed.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByRole("heading", { name: "Trash is empty" })).toBeVisible();

    const db = new DatabaseSync(path.join(data, "netamipin.db"), { readOnly: true });
    const back = db
      .prepare(
        `SELECT b.deleted_at, b.notes, b.is_favorite, c.name AS collection, group_concat(t.name) AS tags
         FROM bookmarks b LEFT JOIN collections c ON c.id = b.collection_id
         LEFT JOIN bookmark_tags bt ON bt.bookmark_id = b.id LEFT JOIN tags t ON t.id = bt.tag_id
         GROUP BY b.id`,
      )
      .get();
    const tombstones = db.prepare("SELECT count(*) AS n FROM tombstones WHERE kind = 'bookmark'").get();
    db.close();
    expect(back).toEqual({ deleted_at: null, notes: "Note", is_favorite: 1, collection: "Shelf", tags: "tag" });
    expect(tombstones).toEqual({ n: 2 });
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
  }
});
test("undo: Ctrl Z puts a decision back in SQLite, a later save wins, a restart starts a new journal", async ({ request }) => {
  const data = await folder("undo");
  const env = isolated(data);
  let app = await launch(request, env);
  try {
    let page = app.page;
    await expect(page.getByRole("heading", { name: "Your bookmarks will live here" })).toBeVisible({ timeout: 15000 });
    await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      await invoke("add_bookmark", { url: "https://undo.invalid/1", title: "Decision", collectionId: null, tags: ["tag"] });
    });
    const db = new DatabaseSync(path.join(data, "netamipin.db"), { readOnly: true });
    const row = () =>
      db.prepare("SELECT is_favorite, triaged_at IS NULL AS inbox, deleted_at IS NULL AS live FROM bookmarks WHERE url = ?").get("https://undo.invalid/1");
    const card = page.locator("[data-bookmark-id]");
    await expect(card).toHaveCount(1);

    // The star is a decision; Ctrl Z takes it back, into the inbox again.
    await card.hover();
    await card.getByRole("button", { name: "Add to favorites" }).click();
    await expect.poll(row).toEqual({ is_favorite: 1, inbox: 0, live: 1 });
    await page.keyboard.press("Control+z");
    await expect(page.locator(".fixed[role=status]")).toContainText("Undone: «Decision»");
    await expect.poll(row).toEqual({ is_favorite: 0, inbox: 1, live: 1 });
    await expect(page.getByRole("button", { name: "Inbox 1", exact: true })).toBeVisible();

    // To the trash and back with Ctrl Z.
    await card.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to trash" }).click();
    await expect.poll(row).toEqual({ is_favorite: 0, inbox: 1, live: 0 });
    await page.keyboard.press("Control+z");
    await expect(page.locator(".fixed[role=status]")).toContainText("Back from Trash: «Decision»");
    await expect.poll(row).toEqual({ is_favorite: 0, inbox: 1, live: 1 });

    // Saved again from the trash after «to the trash»: the undo is refused, nothing is written.
    const outcome = await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const { items } = await invoke("get_bookmarks", { query: {} });
      const { command } = await invoke("trash_bookmark", { id: items[0].id });
      await invoke("add_bookmark", { url: "https://undo.invalid/1", title: null, collectionId: null, tags: [] });
      return invoke("undo", { command });
    });
    expect(outcome).toMatchObject({ outcome: "conflict", action: "trash", title: "Decision" });
    expect(row()).toEqual({ is_favorite: 0, inbox: 1, live: 1 });

    // The journal belongs to this run: after a restart there is nothing to undo.
    await card.hover();
    await card.getByRole("button", { name: "Add to favorites" }).click();
    await expect.poll(row).toEqual({ is_favorite: 1, inbox: 0, live: 1 });
    db.close();
    void page.evaluate(() => window.__TAURI_INTERNALS__.invoke("quit_app")).catch(() => {});
    await app.exited;
    await app.browser.close().catch(() => {});
    app = await launch(request, env);
    page = app.page;
    await expect(page.locator("[data-bookmark-id]")).toHaveCount(1, { timeout: 15000 });
    await page.locator("main").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Control+z");
    await expect(page.locator(".fixed[role=status]")).toContainText("Nothing to undo");
    const after = new DatabaseSync(path.join(data, "netamipin.db"), { readOnly: true });
    expect(after.prepare("SELECT is_favorite FROM bookmarks").get()).toEqual({ is_favorite: 1 });
    after.close();
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
  }
});
test("triage: decisions reach SQLite at once, a restart midway loses nothing", async ({ request }) => {
  const data = await folder("triage");
  const env = isolated(data);
  let app = await launch(request, env);
  try {
    let page = app.page;
    await expect(page.getByRole("heading", { name: "Your bookmarks will live here" })).toBeVisible({ timeout: 15000 });
    await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      for (const n of [1, 2, 3])
        await invoke("add_bookmark", { url: `https://triage.invalid/${n}`, title: `Triage ${n}`, collectionId: null, tags: [] });
    });
    const db = new DatabaseSync(path.join(data, "netamipin.db"), { readOnly: true });
    const rows = () =>
      db
        .prepare(
          `SELECT b.url, c.name AS collection, b.triaged_at IS NOT NULL AS sorted, b.deleted_at IS NOT NULL AS trashed
           FROM bookmarks b LEFT JOIN collections c ON c.id = b.collection_id ORDER BY b.url`,
        )
        .all();
    const heading = page.getByRole("heading", { level: 1 });
    await page.getByRole("region", { name: "New bookmarks" }).getByRole("button", { name: "Sort" }).click();
    await expect(heading).toHaveText(/Sort inbox\s*1 of 3/);
    await expect(page.locator("[data-triage-card]")).toContainText("added by hand today at");

    // 1 files into the first collection of the sidebar, ← to the trash: written at once.
    await page.keyboard.press("1");
    await expect(heading).toHaveText(/2 of 3/);
    await page.keyboard.press("ArrowLeft");
    await expect(heading).toHaveText(/3 of 3/);
    await expect
      .poll(rows)
      .toEqual([
        { url: "https://triage.invalid/1", collection: null, sorted: 0, trashed: 0 },
        { url: "https://triage.invalid/2", collection: null, sorted: 0, trashed: 1 },
        { url: "https://triage.invalid/3", collection: "Articles / To read", sorted: 1, trashed: 0 },
      ]);
    // A link saved meanwhile joins the end.
    await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("add_bookmark", { url: "https://triage.invalid/4", title: "Triage 4", collectionId: null, tags: [] }),
    );
    await expect(heading).toHaveText(/3 of 4\s*\+1 new/);

    // Quit in the middle; nothing decided is lost, the rest waits.
    void page.evaluate(() => window.__TAURI_INTERNALS__.invoke("quit_app")).catch(() => {});
    await app.exited;
    await app.browser.close().catch(() => {});
    app = await launch(request, env);
    page = app.page;
    await expect(page.getByRole("button", { name: "Inbox 2", exact: true })).toBeVisible({ timeout: 15000 });
    await page.getByRole("region", { name: "New bookmarks" }).getByRole("button", { name: "Sort" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Sort inbox\s*1 of 2/);
    await expect(page.locator("[data-triage-card] h2")).toHaveText("Triage 4");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("heading", { name: "Inbox sorted" })).toBeVisible();
    await expect.poll(() => (rows() as { sorted: number }[]).filter((r) => r.sorted).length).toBe(3);
    db.close();
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
  }
});
test("triage suggests a collection by the site from SQLite and changes nothing until chosen", async ({ request }) => {
  const data = await folder("suggest");
  const app = await launch(request, isolated(data));
  try {
    const page = app.page;
    await expect(page.getByRole("heading", { name: "Your bookmarks will live here" })).toBeVisible({ timeout: 15000 });
    const id = await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const collections: { id: number; name: string }[] = await invoke("get_collections");
      const shelf = collections.find((c) => c.name === "Articles / To read")!;
      for (const n of [1, 2]) {
        const { bookmark } = await invoke("add_bookmark", { url: `https://suggest.invalid/${n}`, title: `Article ${n}`, collectionId: null, tags: [] });
        await invoke("update_bookmark", { id: bookmark.id, patch: { collection: { action: "set", id: shelf.id } } });
      }
      const { bookmark } = await invoke("add_bookmark", { url: "https://suggest.invalid/new", title: "New article", collectionId: null, tags: [] });
      return bookmark.id;
    });
    const db = new DatabaseSync(path.join(data, "netamipin.db"), { readOnly: true });
    const row = () => db.prepare("SELECT collection_id IS NULL AS free, triaged_at IS NULL AS inbox FROM bookmarks WHERE id = ?").get(id);
    await page.getByRole("region", { name: "New bookmarks" }).getByRole("button", { name: "Sort" }).click();
    const offered = page.locator("[data-suggested]");
    await expect(offered).toHaveText(/1\s*Articles \/ To read\s*suggested/);
    expect(row()).toEqual({ free: 1, inbox: 1 });
    await page.keyboard.press("1");
    await expect(page.getByRole("heading", { name: "Inbox sorted" })).toBeVisible();
    await expect.poll(row).toEqual({ free: 0, inbox: 0 });
    db.close();
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
  }
});
test("security boundaries: CSP, narrow permissions, no HTTP port", async ({ request }) => {
  const data = await folder("boundaries");
  const env = isolated(data);
  const app = await launch(request, env);
  try {
    const refused: string[] = [];
    app.page.on("console", (message) => {
      if (/Content Security Policy|Refused to/i.test(message.text())) refused.push(message.text());
    });
    // The first load finishes before the reload: a reload during it can leave the page without its interface.
    const empty = app.page.getByRole("heading", { name: "Your bookmarks will live here" });
    await expect(empty).toBeVisible({ timeout: 15000 });
    await app.page.reload();
    await expect(empty).toBeVisible({ timeout: 15000 });
    // The interface itself breaks no rule of its policy.
    expect(refused).toEqual([]);
    const checks = await app.page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const outcome = (promise: Promise<unknown>) => promise.then(() => "answered", () => "refused");
      // A script from elsewhere is blocked by the policy.
      const blocked = await new Promise<string>((resolve) => {
        document.addEventListener("securitypolicyviolation", (event) => resolve(event.violatedDirective), { once: true });
        const script = document.createElement("script");
        script.src = "https://example.invalid/injected.js";
        document.head.append(script);
        setTimeout(() => resolve("not blocked"), 3000);
      });
      let evaluated = "ran";
      try {
        new Function("return 1")();
      } catch {
        evaluated = "blocked";
      }
      return {
        blocked,
        evaluated,
        version: await outcome(invoke("plugin:app|version")),
        opener: await outcome(invoke("plugin:opener|open_url", { url: "https://example.com" })),
        title: await outcome(invoke("plugin:window|set_title", { label: "main", value: "x" })),
        own: await outcome(invoke("get_counts")),
      };
    });
    expect(checks).toEqual({
      blocked: "script-src-elem",
      evaluated: "blocked",
      version: "answered",
      opener: "refused",
      title: "refused",
      own: "answered",
    });
    // The bookmarklet's HTTP server is gone (Р-19): nothing listens on its port.
    const port = await new Promise<string>((resolve) => {
      const socket = net.connect(28765, "127.0.0.1");
      socket.on("connect", () => (socket.destroy(), resolve("open")));
      socket.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
    });
    expect(port).toBe("ECONNREFUSED");
  } finally {
    await app.browser.close().catch(() => {});
    app.processHandle.kill();
  }
});