import { test, expect, chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9225 --lang=ru",
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
      page.getByRole("heading", { name: "Здесь будут ваши закладки" }),
    ).toBeVisible({ timeout: 15000 });
    await page
      .getByRole("button", { name: "Добавить ссылку", exact: true })
      .first()
      .click();
    await page
      .getByLabel("Ссылка", { exact: true })
      .fill("https://example.invalid/native-ui");
    await page.getByLabel("Название", { exact: true }).fill("Проверка SQLite");
    await page
      .getByLabel("Коллекция", { exact: true })
      .selectOption({ label: "Разработка" });
    await page.getByRole("button", { name: "Сохранить ссылку" }).click();
    await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
    await page.locator("[data-bookmark-id]").hover();
    await page.getByRole("button", { name: /^Действия:/ }).click();
    await page.getByRole("menuitem", { name: "Изменить…" }).click();
    await page.getByLabel("Коллекция", { exact: true }).selectOption("");
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    await page.getByRole("button", { name: "Список", exact: true }).click();
    await expect(page.locator("[data-bookmark-id] [data-collection]")).toContainText(
      "Без коллекции",
    );
    // The link added by hand waited in the inbox; saving it in the editor sorted it.
    await expect(page.getByRole("button", { name: "Входящие", exact: true })).toBeVisible();
    // Nothing has written yet: the browser is not connected.
    await expect(page.getByRole("button", { name: "Браузер не подключён" })).toBeVisible();
    const captured = await hostMessage(
      capture("webview-incoming", "https://example.invalid/native-host", "Из браузера", "edge"),
      { env },
    );
    expect(captured.reply).toMatchObject({ ok: true, outcome: "created" });
    await expect(page.locator("[data-bookmark-id]")).toHaveCount(2);
    // The capture tells the app about the browser; the status updates by itself.
    await expect(page.getByRole("button", { name: "Браузер подключён" })).toBeVisible();
    // The capture waits in the inbox at once: badge, banner, section.
    await expect(page.getByRole("button", { name: "Входящие 1", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Новые закладки" })).toContainText("1 новая закладка ждёт разбора");
    await page.getByRole("button", { name: "Входящие 1", exact: true }).click();
    await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
    await expect(page.locator("[data-bookmark-id]")).toContainText("Из браузера");
    await page.getByRole("button", { name: "Все закладки" }).click();
    // FTS5 through IPC: the capture is in the index, case folds.
    const search = page.getByRole("textbox", { name: "Поиск в библиотеке" });
    await search.fill("БРАУЗЕРА native");
    await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
    await expect(page.getByText("1 из 2")).toBeVisible();
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
    await page.getByRole("button", { name: "Развернуть", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Восстановить", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Восстановить", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Развернуть", exact: true }),
    ).toBeVisible();
    // The restored window can land a row under the cursor; the docs show the list at rest.
    await page.mouse.move(1, 1);
    await page.waitForTimeout(300);
    await page.screenshot({ path: "doc/concepts/native-webview2.jpg" });
    await page
      .getByRole("button", { name: "Закрыть окно", exact: true })
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
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    // Edge saved; the hello above came from Chrome.
    await expect(page.locator('[data-capture="connected"]')).toContainText("Подключено: Chrome, Edge");
    await expect(page.locator('[data-capture="connected"]')).toContainText(/Последнее сохранение — сегодня в .* из Edge/);
    // A launch from the host (--autostart) does not show the window.
    await page.getByRole("button", { name: "Закрыть окно", exact: true }).click();
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
      name: "При закрытии окна оставлять приложение в трее",
    });
    await expect(tray).toHaveAttribute("aria-checked", "true");
    await tray.click();
    await expect(tray).toHaveAttribute("aria-checked", "false");
    await expect(tray).toBeEnabled();
    const exited = new Promise<void>((resolve) =>
      processHandle.once("exit", () => resolve()),
    );
    await page
      .getByRole("button", { name: "Закрыть окно", exact: true })
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
    await expect(page.getByRole("button", { name: "Захват не работает" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("alert").filter({ hasText: "не смог открыть канал захвата" })).toBeVisible();
    await page.getByRole("button", { name: "Подробнее", exact: true }).click();
    const block = page.locator('[data-capture="failing"]');
    await expect(block).toContainText("Netami Pin не смог открыть канал захвата");
    await page.screenshot({ path: "test-results/capture-failing.png" });
    // The other program leaves: «Повторить» opens the pipe.
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    await block.getByRole("button", { name: "Повторить", exact: true }).click();
    await expect(page.locator('[data-capture="none"]')).toBeVisible();
    await expect.poll(() => pipeReady(name)).toBe(true);
    // The library worked all along.
    await page.getByRole("button", { name: "Все закладки" }).click();
    await page.getByRole("button", { name: "Добавить ссылку", exact: true }).first().click();
    await page.getByLabel("Ссылка", { exact: true }).fill("https://example.invalid/while-held");
    await page.getByRole("button", { name: "Сохранить ссылку" }).click();
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
  const processHandle = spawn(binary(), [], {
    env: {
      ...process.env,
      ...env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9225 --lang=ru",
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
      app.page.getByRole("heading", { name: "Здесь будут ваши закладки" }),
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
      first.page.getByRole("heading", { name: "Здесь будут ваши закладки" }),
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
    insert.run(randomUUID(), `https://example.invalid/${i}`, `Ссылка ${i}`, "example.invalid", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
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
    await expect(app.page.getByRole("alert").filter({ hasText: "Библиотека повреждена" })).toBeVisible({ timeout: 15000 });
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
      app.page.getByRole("heading", { name: "Здесь будут ваши закладки" }),
    ).toBeVisible({ timeout: 15000 });
    const result = await app.page.evaluate(async () => {
      let html = "<DL>";
      for (let i = 0; i < 10000; i++)
        html += `<DT><A HREF="https://example.invalid/${i}">Link ${i}</A>`;
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const started = performance.now();
      let finished = 0;
      const importing = invoke("import_html_bookmarks", { htmlContent: html }).then(
        (summary: { imported: number; in_trash: number }) => {
          finished = performance.now();
          return summary.imported;
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
      app.page.getByRole("heading", { name: "Здесь будут ваши закладки" }),
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
      app.page.getByRole("heading", { name: "Здесь будут ваши закладки" }),
    ).toBeVisible({ timeout: 15000 });
    await app.page.evaluate(async () => {
      let html = "<DL>";
      for (let i = 0; i < 10000; i++)
        html += `<DT><A HREF="https://site${i % 300}.invalid/${i}">Закладка ${i} · Архитектура и интерфейсы</A>`;
      await window.__TAURI_INTERNALS__.invoke("import_html_bookmarks", { htmlContent: html });
    });
    await expect(app.page.locator("h1")).toContainText("10000", { timeout: 15000 });
    for (const view of ["Сетка", "Список"]) {
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
    await expect(page.getByRole("heading", { name: "Здесь будут ваши закладки" })).toBeVisible({ timeout: 15000 });
    await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const shelf = await invoke("create_collection", { name: "Полка", color: null, icon: null });
      const add = (url: string, title: string, tags: string[], collectionId: number | null) =>
        invoke("add_bookmark", { url, title, collectionId, tags });
      await add("https://site-a.invalid/1", "Ёлочные игрушки", ["праздник"], shelf.id);
      await add("https://site-a.invalid/2", "Гирлянды", [], shelf.id);
      await add("https://site-b.invalid/3", "Рецепт пирога", ["кухня"], null);
    });
    const cards = page.locator("[data-bookmark-id]");
    await expect(cards).toHaveCount(3);

    // Search through IPC and FTS5: «елочн» finds «Ёлочные».
    const search = page.getByRole("textbox", { name: "Поиск в библиотеке" });
    await search.fill("елочн");
    await expect(cards).toHaveCount(1);
    await search.press("Escape");
    await expect(cards).toHaveCount(3);

    // The site filter is exact and shows a chip.
    await page.getByRole("button", { name: "Только закладки с site-a.invalid" }).first().click();
    await expect(cards).toHaveCount(2);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("2 из 3");
    await page.getByRole("button", { name: "Убрать фильтр по сайту site-a.invalid" }).click();

    // The editor writes title and tags to SQLite.
    const card = page.locator("[data-bookmark-id]", { hasText: "Рецепт пирога" });
    await card.hover();
    await card.getByRole("button", { name: /^Действия:/ }).click();
    await page.getByRole("menuitem", { name: "Изменить…" }).click();
    await page.getByLabel("Название", { exact: true }).fill("Пирог с яблоками");
    const tags = page.getByLabel("Теги", { exact: true });
    await tags.fill("выпечка");
    await tags.press("Control+Enter");
    await expect(page.getByRole("status")).toContainText("Изменения сохранены");
    const db = new DatabaseSync(path.join(data, "netamipin.db"), { readOnly: true });
    const saved = db
      .prepare(
        `SELECT b.title, group_concat(t.name, ',') AS tags FROM bookmarks b
         LEFT JOIN bookmark_tags bt ON bt.bookmark_id = b.id LEFT JOIN tags t ON t.id = bt.tag_id
         WHERE b.url = 'https://site-b.invalid/3' GROUP BY b.id`,
      )
      .get() as { title: string; tags: string };
    expect(saved.title).toBe("Пирог с яблоками");
    expect(saved.tags.split(",").sort()).toEqual(["выпечка", "кухня"]);

    // Deleting a collection keeps its bookmarks, without a collection.
    await page.getByRole("button", { name: /^Полка/ }).hover();
    await page.getByRole("button", { name: "Удалить коллекцию Полка" }).click();
    await page.getByRole("button", { name: "Удалить", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Полка/ })).toHaveCount(0);
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
    await expect(page.getByRole("heading", { name: "Здесь будут ваши закладки" })).toBeVisible({ timeout: 15000 });
    await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const shelf = await invoke("create_collection", { name: "Полка", color: null, icon: null });
      const { bookmark } = await invoke("add_bookmark", { url: "https://trash.invalid/1", title: "В корзину и обратно", collectionId: shelf.id, tags: ["тег"] });
      await invoke("update_bookmark", { id: bookmark.id, patch: { notes: "Заметка", is_favorite: true, collection: { action: "keep" } } });
      for (const url of ["https://trash.invalid/old", "https://trash.invalid/recent"]) {
        const added = await invoke("add_bookmark", { url, title: null, collectionId: null, tags: [] });
        await invoke("trash_bookmark", { id: added.bookmark.id });
      }
    });
    const card = page.locator("[data-bookmark-id]");
    await expect(card).toHaveCount(1);
    // No confirmation: to the trash with an undo notice.
    await card.click({ button: "right" });
    await page.getByRole("menuitem", { name: "В корзину" }).click();
    await expect(page.locator(".fixed[role=status]")).toContainText("Перемещено в корзину");
    await expect(page.getByRole("button", { name: "Корзина 3", exact: true })).toBeVisible();

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
    await page.getByRole("button", { name: "Корзина 2", exact: true }).click({ timeout: 15000 });
    // «Удалить навсегда» through IPC: only from the trash, once.
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
    await expect(page.getByRole("button", { name: "Корзина 1", exact: true })).toBeVisible();
    const trashed = page.locator("[data-bookmark-id]");
    await expect(trashed).toHaveCount(1);
    await trashed.hover();
    await trashed.getByRole("button", { name: "Восстановить" }).click();
    await expect(page.getByRole("heading", { name: "Корзина пуста" })).toBeVisible();

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
    expect(back).toEqual({ deleted_at: null, notes: "Заметка", is_favorite: 1, collection: "Полка", tags: "тег" });
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
    await expect(page.getByRole("heading", { name: "Здесь будут ваши закладки" })).toBeVisible({ timeout: 15000 });
    await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      await invoke("add_bookmark", { url: "https://undo.invalid/1", title: "Решение", collectionId: null, tags: ["тег"] });
    });
    const db = new DatabaseSync(path.join(data, "netamipin.db"), { readOnly: true });
    const row = () =>
      db.prepare("SELECT is_favorite, triaged_at IS NULL AS inbox, deleted_at IS NULL AS live FROM bookmarks WHERE url = ?").get("https://undo.invalid/1");
    const card = page.locator("[data-bookmark-id]");
    await expect(card).toHaveCount(1);

    // The star is a decision; Ctrl Z takes it back, into the inbox again.
    await card.hover();
    await card.getByRole("button", { name: "В избранное" }).click();
    await expect.poll(row).toEqual({ is_favorite: 1, inbox: 0, live: 1 });
    await page.keyboard.press("Control+z");
    await expect(page.locator(".fixed[role=status]")).toContainText("Отменено: «Решение»");
    await expect.poll(row).toEqual({ is_favorite: 0, inbox: 1, live: 1 });
    await expect(page.getByRole("button", { name: "Входящие 1", exact: true })).toBeVisible();

    // To the trash and back with Ctrl Z.
    await card.click({ button: "right" });
    await page.getByRole("menuitem", { name: "В корзину" }).click();
    await expect.poll(row).toEqual({ is_favorite: 0, inbox: 1, live: 0 });
    await page.keyboard.press("Control+z");
    await expect(page.locator(".fixed[role=status]")).toContainText("Возвращено из корзины: «Решение»");
    await expect.poll(row).toEqual({ is_favorite: 0, inbox: 1, live: 1 });

    // Saved again from the trash after «to the trash»: the undo is refused, nothing is written.
    const outcome = await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const { items } = await invoke("get_bookmarks", { query: {} });
      const { command } = await invoke("trash_bookmark", { id: items[0].id });
      await invoke("add_bookmark", { url: "https://undo.invalid/1", title: null, collectionId: null, tags: [] });
      return invoke("undo", { command });
    });
    expect(outcome).toMatchObject({ outcome: "conflict", action: "trash", title: "Решение" });
    expect(row()).toEqual({ is_favorite: 0, inbox: 1, live: 1 });

    // The journal belongs to this run: after a restart there is nothing to undo.
    await card.hover();
    await card.getByRole("button", { name: "В избранное" }).click();
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
    await expect(page.locator(".fixed[role=status]")).toContainText("Отменять нечего");
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
    await expect(page.getByRole("heading", { name: "Здесь будут ваши закладки" })).toBeVisible({ timeout: 15000 });
    await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      for (const n of [1, 2, 3])
        await invoke("add_bookmark", { url: `https://triage.invalid/${n}`, title: `Разбор ${n}`, collectionId: null, tags: [] });
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
    await page.getByRole("region", { name: "Новые закладки" }).getByRole("button", { name: "Разобрать" }).click();
    await expect(heading).toHaveText(/Разбор входящих\s*1 из 3/);
    await expect(page.locator("[data-triage-card]")).toContainText("добавлено вручную сегодня в");

    // 1 files into the first collection of the sidebar, ← to the trash: written at once.
    await page.keyboard.press("1");
    await expect(heading).toHaveText(/2 из 3/);
    await page.keyboard.press("ArrowLeft");
    await expect(heading).toHaveText(/3 из 3/);
    await expect
      .poll(rows)
      .toEqual([
        { url: "https://triage.invalid/1", collection: null, sorted: 0, trashed: 0 },
        { url: "https://triage.invalid/2", collection: null, sorted: 0, trashed: 1 },
        { url: "https://triage.invalid/3", collection: "Дизайн & UI", sorted: 1, trashed: 0 },
      ]);
    // A link saved meanwhile joins the end.
    await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("add_bookmark", { url: "https://triage.invalid/4", title: "Разбор 4", collectionId: null, tags: [] }),
    );
    await expect(heading).toHaveText(/3 из 4\s*\+1 новая/);

    // Quit in the middle; nothing decided is lost, the rest waits.
    void page.evaluate(() => window.__TAURI_INTERNALS__.invoke("quit_app")).catch(() => {});
    await app.exited;
    await app.browser.close().catch(() => {});
    app = await launch(request, env);
    page = app.page;
    await expect(page.getByRole("button", { name: "Входящие 2", exact: true })).toBeVisible({ timeout: 15000 });
    await page.getByRole("region", { name: "Новые закладки" }).getByRole("button", { name: "Разобрать" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Разбор входящих\s*1 из 2/);
    await expect(page.locator("[data-triage-card] h2")).toHaveText("Разбор 4");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("heading", { name: "Входящие разобраны" })).toBeVisible();
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
    await expect(page.getByRole("heading", { name: "Здесь будут ваши закладки" })).toBeVisible({ timeout: 15000 });
    const id = await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const collections: { id: number; name: string }[] = await invoke("get_collections");
      const shelf = collections.find((c) => c.name === "Статьи / Читать")!;
      for (const n of [1, 2]) {
        const { bookmark } = await invoke("add_bookmark", { url: `https://suggest.invalid/${n}`, title: `Статья ${n}`, collectionId: null, tags: [] });
        await invoke("update_bookmark", { id: bookmark.id, patch: { collection: { action: "set", id: shelf.id } } });
      }
      const { bookmark } = await invoke("add_bookmark", { url: "https://suggest.invalid/new", title: "Новая статья", collectionId: null, tags: [] });
      return bookmark.id;
    });
    const db = new DatabaseSync(path.join(data, "netamipin.db"), { readOnly: true });
    const row = () => db.prepare("SELECT collection_id IS NULL AS free, triaged_at IS NULL AS inbox FROM bookmarks WHERE id = ?").get(id);
    await page.getByRole("region", { name: "Новые закладки" }).getByRole("button", { name: "Разобрать" }).click();
    const offered = page.locator("[data-suggested]");
    await expect(offered).toHaveText(/1\s*Статьи \/ Читать\s*предложено/);
    expect(row()).toEqual({ free: 1, inbox: 1 });
    await page.keyboard.press("1");
    await expect(page.getByRole("heading", { name: "Входящие разобраны" })).toBeVisible();
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
    await app.page.reload();
    await expect(app.page.getByRole("heading", { name: "Здесь будут ваши закладки" })).toBeVisible({ timeout: 15000 });
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