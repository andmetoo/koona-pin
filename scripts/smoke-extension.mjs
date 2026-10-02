import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, cp, appendFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import assert from "node:assert/strict";
import http from "node:http";

const origin = "http://127.0.0.1:28765";
const directory = path.resolve(".test-data", `extension-${Date.now()}`);
await mkdir(directory, { recursive: true });
const extension = path.join(directory, "unpacked-extension");
await cp(path.resolve("extension/chrome"), extension, { recursive: true });
// Playwright does not expose toolbar clicks. Only the isolated test copy gets
// a reference to the exact handler registered with chrome.action.onClicked.
await appendFile(
  path.join(extension, "worker.js"),
  "\nglobalThis.__captureForTest = captureTab;\n",
);
const env = {
  ...process.env,
  ODDCLICKS_DATA_DIR: directory,
  WEBVIEW2_USER_DATA_FOLDER: path.join(directory, "webview"),
};
let app, browser, worker;
async function available() {
  return new Promise((resolve) => {
    const request = http.get(`${origin}/api/health`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(500, () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}
async function until(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out: ${label}`);
}
async function startApp() {
  app = spawn(
    path.resolve(
      process.env.ODDCLICKS_TEST_BINARY ||
        "src-tauri/target/debug/oddclicks.exe",
    ),
    [],
    {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  app.stdout.on("data", (chunk) => process.stdout.write(chunk));
  app.stderr.on("data", (chunk) => process.stderr.write(chunk));
  app.on("error", (error) =>
    console.error("Cannot start OddClicks:", error.message),
  );
  app.on("exit", (code) => {
    if (code) console.error("OddClicks exited:", code);
  });
  await until(available, "OddClicks startup");
}
async function stopApp() {
  if (!app || app.exitCode !== null) return;
  const exited = new Promise((resolve) => app.once("exit", resolve));
  app.kill();
  await exited;
  app = undefined;
}
async function startBrowser() {
  browser = await chromium.launchPersistentContext(
    path.join(directory, "chrome"),
    {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    },
  );
  worker =
    browser.serviceWorkers()[0] ||
    (await browser.waitForEvent("serviceworker"));
  return worker.url().split("/")[2];
}
async function capture(url, title) {
  await worker.evaluate(
    async ({ url, title }) => {
      await globalThis.__captureForTest({ url, title });
    },
    { url, title },
  );
}
const waiting = () =>
  worker.evaluate(
    async () =>
      (await chrome.storage.local.get("captureQueue")).captureQueue || [],
  );

assert.equal(
  await available(),
  false,
  "Port 28765 occupied: existing process left untouched",
);
try {
  await startApp();
  const db = new DatabaseSync(path.join(directory, "oddclicks.db"), {
    readOnly: true,
  });
  const token = db
    .prepare("SELECT value FROM app_settings WHERE key='capture_token'")
    .get().value;
  db.close();
  await stopApp();
  let id = await startBrowser();
  await worker.evaluate(
    (token) => chrome.storage.local.set({ captureToken: token }),
    token,
  );
  await capture(
    "https://example.invalid/extension-capture",
    "Настоящий Chrome worker",
  );
  const first = await waiting();
  assert.equal(first.length, 1);
  assert.ok(first[0].request_id);
  assert.match(first[0].error, /недоступен/);
  await capture(first[0].url, first[0].title);
  assert.equal((await waiting()).length, 1);
  await capture("chrome://settings", "Settings");
  assert.equal((await waiting()).length, 1);
  assert.ok(
    await worker.evaluate(() => chrome.alarms.get("oddclicks-delivery")),
  );
  await browser.close();
  browser = undefined;
  id = await startBrowser();
  assert.equal(
    (await waiting())[0].request_id,
    first[0].request_id,
    "Request survives Chrome restart",
  );
  await startApp();
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  await page.getByRole("button", { name: "Повторить передачу" }).click();
  await until(async () => (await waiting()).length === 0, "confirmed delivery");
  const stored = new DatabaseSync(path.join(directory, "oddclicks.db"), {
    readOnly: true,
  });
  assert.equal(
    stored.prepare("SELECT count(*) AS n FROM bookmarks").get().n,
    1,
  );
  assert.equal(
    stored.prepare("SELECT request_id FROM capture_receipts").get().request_id,
    first[0].request_id,
  );
  await capture(first[0].url, "Заголовок дубликата");
  assert.equal((await waiting()).length, 0);
  assert.equal(
    stored.prepare("SELECT count(*) AS n FROM bookmarks").get().n,
    1,
  );
  assert.equal(
    stored.prepare("SELECT title FROM bookmarks").get().title,
    first[0].title,
  );
  stored.close();
  await worker.evaluate(() =>
    chrome.storage.local.set({ captureToken: "0".repeat(64) }),
  );
  await capture(
    "https://example.invalid/incorrect-token",
    "Ожидает подключения",
  );
  assert.equal((await waiting()).length, 1);
  await page.reload();
  await page
    .getByRole("status")
    .filter({ hasText: "Токен не подходит" })
    .waitFor();
  await page.locator("#token").fill(token);
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await until(
    async () => (await waiting()).length === 0,
    "delivery after token correction",
  );
  await page.screenshot({
    path: "doc/concepts/chrome-options.jpg",
    fullPage: true,
  });
  console.log(
    "PASS: real MV3 worker, offline persistence, repeated captures, Chrome restart, alarms, authenticated SQLite delivery, duplicates and token correction",
  );
} finally {
  await browser?.close();
  await stopApp();
}
