// Extension smoke (NP-016): the built Chrome package in Chrome for Testing,
// talking to Netami Pin through the real native host. The run registers a host
// name of its own, so an installed app's registration stays untouched.
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { appendFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { buildExtension } from "./build-extension.mjs";
import { hostBinary, pipeReady, startedSince, testPipe } from "./lib/native-host.mjs";

const HOST = "app.netami.pin.test";
// Chrome for Testing reads the Chromium key (checked in NP-016).
const KEY = `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST}`;
const directory = path.resolve(".test-data", `extension-${Date.now()}`);
await mkdir(directory, { recursive: true });
const extension = path.join(directory, "unpacked-extension");
const built = await buildExtension({ log: () => {} });
await cp(built.unpacked.chrome, extension, { recursive: true });
// Playwright does not expose toolbar clicks. Only the isolated test copy gets
// a reference to the exact handler registered with chrome.action.onClicked.
await appendFile(path.join(extension, "worker.js"), "\nglobalThis.__captureForTest = captureTab;\n");
const version = path.join(extension, "version.js");
await writeFile(version, (await readFile(version, "utf8")).replace('"app.netami.pin"', JSON.stringify(HOST)));

const pipe = testPipe("extension");
const env = {
  ...process.env,
  NETAMIPIN_DATA_DIR: directory,
  WEBVIEW2_USER_DATA_FOLDER: path.join(directory, "webview"),
  NETAMIPIN_PIPE: pipe,
};
const manifest = path.join(directory, `${HOST}.json`);
const register = (origin) =>
  writeFile(
    manifest,
    JSON.stringify({ name: HOST, description: "Netami Pin test", path: hostBinary(), type: "stdio", allowed_origins: [origin] }),
  );
await register(`chrome-extension://${built.devId}/`);
execFileSync("reg", ["add", KEY, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"], { stdio: "ignore" });

const apps = startedSince();
const library = path.join(directory, "netamipin.db");
let browser, worker;
async function until(check, label, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(150);
  }
  throw new Error(`Timed out: ${label}`);
}
async function startBrowser() {
  browser = await chromium.launchPersistentContext(path.join(directory, "chrome"), {
    channel: "chromium",
    headless: true,
    env,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      // The extension speaks the browser's language; the assertions are Russian.
      "--lang=ru",
    ],
  });
  worker = browser.serviceWorkers()[0] || (await browser.waitForEvent("serviceworker"));
  const id = worker.url().split("/")[2];
  assert.equal(id, built.devId, "Development key pins the extension id");
  return id;
}
const capture = (url, title) =>
  worker.evaluate(async ({ url, title }) => globalThis.__captureForTest({ url, title }), { url, title });
const waiting = () => worker.evaluate(async () => (await chrome.storage.local.get("captureQueue")).captureQueue || []);
function rows(sql) {
  const db = new DatabaseSync(library, { readOnly: true });
  try {
    return db.prepare(sql).all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}
async function options(id) {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  return page;
}

try {
  let id = await startBrowser();
  // A hello does not start the app the user closed.
  let page = await options(id);
  await page.locator('#status[data-state="closed"]').waitFor();
  await page.getByText("Netami Pin закрыт").waitFor();
  assert.equal(await pipeReady(pipe), false, "hello must not start the app");

  // A capture starts the app in the tray and saves.
  await capture("https://example.invalid/extension-capture", "Настоящий Chrome worker");
  assert.equal((await waiting()).length, 0);
  assert.equal(apps.ours().length, 1, "the host started the app");
  assert.deepEqual(rows("SELECT title, source FROM bookmarks"), [{ title: "Настоящий Chrome worker", source: "chrome" }]);
  const [{ request_id: firstId }] = rows("SELECT request_id FROM capture_receipts");
  await page.getByRole("button", { name: "Проверить снова" }).click();
  await page.locator('#status[data-state="connected"]').waitFor();
  await page.getByText("Подключено к Netami Pin").waitFor();

  // A duplicate: existing, the title stays.
  await capture("https://example.invalid/extension-capture", "Заголовок дубликата");
  assert.equal((await waiting()).length, 0);
  assert.deepEqual(rows("SELECT title FROM bookmarks"), [{ title: "Настоящий Chrome worker" }]);

  // The library cannot open: the link stays in the queue.
  apps.stop();
  await until(async () => !(await pipeReady(pipe)), "app stopped");
  for (const suffix of ["", "-wal", "-shm"])
    await rename(library + suffix, `${library}.kept${suffix}`).catch(() => {});
  await writeFile(library, "not a database");
  await capture("https://example.invalid/library-failed", "Ждёт в очереди");
  const queued = await waiting();
  assert.equal(queued.length, 1);
  assert.match(queued[0].error, /не ответил/);
  assert.ok(await worker.evaluate(() => chrome.alarms.get("netamipin-delivery")));
  apps.stop();

  // The queue survives a browser restart with the same request id.
  await browser.close();
  id = await startBrowser();
  assert.equal((await waiting())[0].request_id, queued[0].request_id, "Request survives Chrome restart");

  // The library is back: «Send now» delivers.
  await rm(library);
  for (const suffix of ["", "-wal", "-shm"])
    await rename(`${library}.kept${suffix}`, library + suffix).catch(() => {});
  page = await options(id);
  await page.getByRole("button", { name: "Отправить сейчас" }).click();
  await until(async () => (await waiting()).length === 0, "delivery after the library came back");
  assert.equal(rows("SELECT count(*) AS n FROM bookmarks")[0].n, 2);
  // Receipts: the first capture, the duplicate (existing) and the queued one.
  const receipts = rows("SELECT request_id, outcome FROM capture_receipts");
  assert.equal(receipts.length, 3);
  assert.ok(receipts.some((r) => r.request_id === firstId && r.outcome === "created"));
  assert.ok(receipts.some((r) => r.request_id === queued[0].request_id && r.outcome === "created"));

  // The host refuses an extension id it does not list: the browser says «forbidden».
  await register("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/");
  await capture("https://example.invalid/foreign-id", "Чужой ID");
  const refused = await waiting();
  assert.equal(refused.length, 1);
  assert.equal(refused[0].code, "host_missing");
  assert.match(refused[0].error, /не установлен/);
  await page.reload();
  await page.locator('#status[data-state="missing"]').waitFor();
  await page.getByRole("link", { name: "Скачать Netami Pin" }).waitFor();
  await register(`chrome-extension://${built.devId}/`);
  await page.getByRole("button", { name: "Отправить сейчас" }).click();
  await until(async () => (await waiting()).length === 0, "delivery after registration came back");

  // The app keeps a record of this browser for its status.
  const connections = JSON.parse(rows("SELECT value FROM app_settings WHERE key='capture_connections'")[0].value);
  assert.ok(connections.browsers.chrome, "the app knows Chrome");
  await page.reload();
  await page.locator('#status[data-state="connected"]').waitFor();
  await page.screenshot({ path: "doc/concepts/chrome-options.jpg", fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await sleep(400); // buttons change colour with a transition
  await page.screenshot({ path: path.join(directory, "chrome-options-dark.png"), fullPage: true });
  console.log(
    "PASS: built MV3 package, native host, hello without starting the app, capture starts the app, duplicate, queue when the library fails, Chrome restart, send now, foreign id, browser record",
  );
} finally {
  await browser?.close().catch(() => {});
  apps.stop();
  execFileSync("reg", ["delete", KEY, "/f"], { stdio: "ignore" });
}
