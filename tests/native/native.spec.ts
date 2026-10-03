import { test, expect, chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rename, access } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import http from "node:http";

test("real WebView2, SQLite, HTTP events, close-to-tray and single instance", async ({
  request,
}) => {
  try {
    await request.get("http://127.0.0.1:28765/api/health", { timeout: 500 });
    throw new Error(
      "Port 28765 already occupied; existing process is left untouched",
    );
  } catch (error) {
    if (String(error).includes("already occupied")) throw error;
  }
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
      page.getByRole("heading", { name: "Здесь будет ваша библиотека" }),
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
    await page.locator("[data-bookmark-id] summary").click();
    await page
      .getByRole("button", { name: "Редактировать", exact: true })
      .click();
    await page.getByLabel("Коллекция", { exact: true }).selectOption("");
    await page.getByRole("button", { name: "Сохранить изменения" }).click();
    await expect(page.locator("[data-bookmark-id] footer")).toContainText(
      "Без коллекции",
    );
    await page.getByRole("button", { name: "Подключить браузер" }).click();
    await expect(
      page.getByLabel("Токен подключения", { exact: true }),
    ).toHaveValue(/^[a-f0-9]{64}$/);
    const token = await page
      .getByLabel("Токен подключения", { exact: true })
      .inputValue();
    const captured = await request.post(
      "http://127.0.0.1:28765/api/v1/capture",
      {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          request_id: "webview-incoming",
          url: "https://example.invalid/native-http",
          title: "Из браузера",
        },
      },
    );
    expect(captured.ok()).toBe(true);
    await page.getByRole("button", { name: "Закрыть", exact: true }).click();
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
    await page.screenshot({ path: "doc/concepts/native-webview2.jpg" });
    await page
      .getByRole("button", { name: "Закрыть окно", exact: true })
      .click();
    expect((await request.get("http://127.0.0.1:28765/api/health")).ok()).toBe(
      true,
    );
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
    await page
      .getByLabel("При закрытии окна оставлять приложение в трее")
      .uncheck();
    await expect(
      page.getByLabel("При закрытии окна оставлять приложение в трее"),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Закрыть", exact: true }).click();
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

test("occupied port is reported while local library remains usable", async ({
  request,
}) => {
  // The app probes the port with a request; an unread request would keep the
  // socket and server.close() pending, so the connection is dropped at once.
  const occupied = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(28765, "127.0.0.1", resolve);
  });
  const data = path.resolve(".test-data", `occupied-${Date.now()}`);
  await mkdir(data, { recursive: true });
  const processHandle = spawn(
    path.resolve(
      process.env.NETAMIPIN_TEST_BINARY ||
        "src-tauri/target/debug/netamipin.exe",
    ),
    [],
    {
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        NETAMIPIN_DATA_DIR: data,
        WEBVIEW2_USER_DATA_FOLDER: path.join(data, "webview"),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9225",
      },
    },
  );
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
    const page = browser.contexts()[0].pages()[0];
    await page.getByRole("button", { name: "Подключить браузер" }).click();
    await expect(page.locator(".connection-status")).not.toHaveClass(
      /connected/,
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__TAURI_INTERNALS__.invoke("get_server_status"),
        ),
      )
      .toMatchObject({ running: false, error: expect.any(String) });
    await page.getByRole("button", { name: "Закрыть", exact: true }).click();
    await page
      .getByRole("button", { name: "Добавить ссылку", exact: true })
      .first()
      .click();
    await page
      .getByLabel("Ссылка", { exact: true })
      .fill("https://example.invalid/without-http");
    await page.getByRole("button", { name: "Сохранить ссылку" }).click();
    await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  } finally {
    await browser?.close();
    processHandle.kill();
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
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
  await expect
    .poll(
      async () => {
        try {
          await request.get("http://127.0.0.1:9225/json/version", {
            timeout: 500,
          });
          return false;
        } catch {
          return true;
        }
      },
      { timeout: 15000 },
    )
    .toBe(true);
  const processHandle = spawn(binary(), [], {
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

test("upgrade from OddClicks keeps library, token, theme, view and tray setting", async ({
  request,
}) => {
  const root = path.resolve(".test-data", `upgrade-${Date.now()}`);
  const legacy = path.join(root, "legacy");
  const current = path.join(root, "current");
  await mkdir(legacy, { recursive: true });
  await mkdir(current, { recursive: true });

  // Prepare a library the way OddClicks left it: same schema, old file and key names.
  const old = await launch(request, {
    NETAMIPIN_DATA_DIR: legacy,
    WEBVIEW2_USER_DATA_FOLDER: path.join(legacy, "webview"),
  });
  let token: string;
  try {
    await old.page
      .getByRole("button", { name: "Добавить ссылку", exact: true })
      .first()
      .click();
    await old.page
      .getByLabel("Ссылка", { exact: true })
      .fill("https://example.invalid/from-oddclicks");
    await old.page.getByLabel("Название", { exact: true }).fill("Из OddClicks");
    await old.page.getByRole("button", { name: "Сохранить ссылку" }).click();
    await expect(old.page.locator("[data-bookmark-id]")).toHaveCount(1);
    const settings = await old.page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("get_app_settings"),
    );
    token = (settings as { capture_token: string }).capture_token;
    await old.page.evaluate(async () => {
      await window.__TAURI_INTERNALS__.invoke("set_close_to_tray", {
        enabled: false,
      });
      localStorage.removeItem("netamipin.theme");
      localStorage.removeItem("netamipin.view");
      localStorage.setItem("oddclicks.theme", "dark");
      localStorage.setItem("oddclicks.view", "list");
    });
    // Chromium writes localStorage to disk with a delay of a few seconds.
    await old.page.waitForTimeout(6000);
    await old.page
      .getByRole("button", { name: "Закрыть окно", exact: true })
      .click();
    await old.exited;
  } finally {
    await old.browser.close().catch(() => {});
    old.processHandle.kill();
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    await rename(
      path.join(legacy, `netamipin.db${suffix}`),
      path.join(legacy, `oddclicks.db${suffix}`),
    ).catch(() => {});
  }

  const app = await launch(request, {
    NETAMIPIN_DATA_DIR: current,
    NETAMIPIN_LEGACY_DIR: legacy,
    WEBVIEW2_USER_DATA_FOLDER: path.join(current, "webview"),
  });
  try {
    await expect(app.page.locator("[data-bookmark-id]")).toHaveCount(1);
    await expect(app.page.locator("[data-bookmark-id]")).toContainText(
      "Из OddClicks",
    );
    expect(
      await app.page.evaluate(() => ({
        theme: document.documentElement.dataset.studyTheme,
        view: localStorage.getItem("netamipin.view"),
      })),
    ).toEqual({ theme: "dark", view: "list" });
    expect(
      await app.page.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke("get_app_settings"),
      ),
    ).toEqual({ capture_token: token, close_to_tray: false });
    await access(path.join(current, "netamipin.db"));
    await access(path.join(legacy, "oddclicks.db"));
  } finally {
    await app.browser.close();
    app.processHandle.kill();
  }
});

test("running OddClicks on the capture port is reported", async ({
  request,
}) => {
  const oddclicks = http.createServer((_, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ status: "ok", app: "OddClicks", protocol: 1 }));
  });
  await new Promise<void>((resolve, reject) => {
    oddclicks.once("error", reject);
    oddclicks.listen(28765, "127.0.0.1", resolve);
  });
  const data = path.resolve(".test-data", `legacy-port-${Date.now()}`);
  await mkdir(data, { recursive: true });
  const app = await launch(request, {
    NETAMIPIN_DATA_DIR: data,
    WEBVIEW2_USER_DATA_FOLDER: path.join(data, "webview"),
  });
  try {
    await expect(app.page.getByRole("alert")).toContainText(
      "занят прежней версией OddClicks",
    );
  } finally {
    await app.browser.close();
    app.processHandle.kill();
    await new Promise<void>((resolve) => oddclicks.close(() => resolve()));
  }
});