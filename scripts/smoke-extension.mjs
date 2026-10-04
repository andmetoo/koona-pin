// Extension smoke (NP-016, NP-017): the built package in a Chromium browser,
// talking to Netami Pin through the real native host. The run registers a host
// name of its own, so an installed app's registration stays untouched.
//
//   node scripts/smoke-extension.mjs [chromium|chrome|edge]
//
// chromium is Chrome for Testing from Playwright; chrome and edge are the
// installed browsers (NETAMIPIN_CHROME / NETAMIPIN_EDGE point to another copy).
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { buildExtension } from "./build-extension.mjs";
import { assertNoOtherApp, hostBinary, pipeReady, startedSince, testPipe } from "./lib/native-host.mjs";

assertNoOtherApp();

const targets = {
  // Chrome for Testing reads the Chromium key (checked in NP-016).
  chromium: { name: "Chrome for Testing", source: "chrome", package: "chrome", key: "Chromium", launch: { channel: "chromium" } },
  chrome: {
    name: "Chrome",
    source: "chrome",
    package: "chrome",
    key: "Google\\Chrome",
    launch: { executablePath: process.env.NETAMIPIN_CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  },
  // A copy of Edge's Application folder starts where a redirector (an IFEO
  // debugger such as MSEdgeRedirect) intercepts the installed msedge.exe.
  edge: {
    name: "Edge",
    source: "edge",
    package: "edge",
    key: "Microsoft\\Edge",
    launch: {
      executablePath: process.env.NETAMIPIN_EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    },
  },
};
const targetName = process.argv[2] || "chromium";
const target = targets[targetName];
if (!target) throw new Error(`Unknown browser ${targetName}: use ${Object.keys(targets).join(", ")}`);
if (target.launch.executablePath && !existsSync(target.launch.executablePath))
  throw new Error(`${target.name} not found at ${target.launch.executablePath}`);

const HOST = "app.netami.pin.test";
const KEY = `HKCU\\Software\\${target.key}\\NativeMessagingHosts\\${HOST}`;
const directory = path.resolve(".test-data", `extension-${targetName}-${Date.now()}`);
await mkdir(directory, { recursive: true });
const extension = path.join(directory, "unpacked-extension");
const built = await buildExtension({ log: () => {} });
await cp(built.unpacked[target.package], extension, { recursive: true });
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
const writeManifest = (origin) =>
  writeFile(
    manifest,
    JSON.stringify({ name: HOST, description: "Netami Pin test", path: hostBinary(), type: "stdio", allowed_origins: [origin] }),
  );
const register = () => execFileSync("reg", ["add", KEY, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"], { stdio: "ignore" });
const unregister = () => {
  try {
    execFileSync("reg", ["delete", KEY, "/f"], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
};
await writeManifest(`chrome-extension://${built.devId}/`);
register();

const apps = startedSince();
const library = path.join(directory, "netamipin.db");
let browser, worker;
const notes = [];
async function until(check, label, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(150);
  }
  throw new Error(`Timed out: ${label}`);
}
const ourWorker = () => browser.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${built.devId}/`));
async function startBrowser() {
  browser = await chromium.launchPersistentContext(path.join(directory, "profile"), {
    ...target.launch,
    headless: true,
    env,
    // Branded Chrome and Edge ignore --load-extension (Chrome 137+); an unpacked
    // extension is loaded over CDP instead (NP-014). One way for every browser.
    ignoreDefaultArgs: ["--disable-extensions"],
    // The extension speaks the browser's language; the assertions are Russian.
    args: ["--enable-unsafe-extension-debugging", "--lang=ru"],
  });
  worker = ourWorker() ?? (await browser.waitForEvent("serviceworker", { timeout: 3000 }).catch(() => null));
  if (worker && !worker.url().startsWith(`chrome-extension://${built.devId}/`)) worker = ourWorker();
  if (worker) notes.push("the profile kept the unpacked extension");
  else {
    const cdp = await browser.browser().newBrowserCDPSession();
    const { id } = await cdp.send("Extensions.loadUnpacked", { path: extension });
    assert.equal(id, built.devId, "Development key pins the extension id");
    worker =
      ourWorker() ??
      (await browser.waitForEvent("serviceworker", { predicate: (w) => w.url().startsWith(`chrome-extension://${id}/`) }));
  }
  return built.devId;
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
  const userAgent = await worker.evaluate(() => navigator.userAgent);
  // A hello does not start the app the user closed.
  let page = await options(id);
  await page.locator('#status[data-state="closed"]').waitFor();
  await page.getByText("Netami Pin закрыт").waitFor();
  assert.equal(await pipeReady(pipe), false, "hello must not start the app");

  // A capture starts the app in the tray and saves, under this browser's name.
  const started = performance.now();
  await capture("https://example.invalid/extension-capture", `Настоящий ${target.name}`);
  const coldMs = Math.round(performance.now() - started);
  assert.equal((await waiting()).length, 0);
  assert.equal(apps.ours().length, 1, "the host started the app");
  assert.deepEqual(rows("SELECT title, source FROM bookmarks"), [{ title: `Настоящий ${target.name}`, source: target.source }]);
  const [{ request_id: firstId }] = rows("SELECT request_id FROM capture_receipts");
  await page.getByRole("button", { name: "Проверить снова" }).click();
  await page.locator('#status[data-state="connected"]').waitFor();
  await page.getByText("Подключено к Netami Pin").waitFor();

  // A duplicate: existing, the title stays.
  await capture("https://example.invalid/extension-capture", "Заголовок дубликата");
  assert.equal((await waiting()).length, 0);
  assert.deepEqual(rows("SELECT title FROM bookmarks"), [{ title: `Настоящий ${target.name}` }]);

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
  apps.stop();
  id = await startBrowser();
  assert.equal((await waiting())[0].request_id, queued[0].request_id, `Request survives ${target.name} restart`);

  // The library is back: the delivery alarm (once a minute) brings the link
  // without anyone pressing a button. The startup delivery may have started
  // an app that could not open the library: it goes first.
  apps.stop();
  await until(async () => !(await pipeReady(pipe)), "no app left from the restart");
  await rm(library);
  for (const suffix of ["", "-wal", "-shm"])
    await rename(`${library}.kept${suffix}`, library + suffix).catch(() => {});
  const retried = performance.now();
  await until(async () => (await waiting()).length === 0, "delivery by the alarm", 150000);
  const retryS = Math.round((performance.now() - retried) / 1000);
  assert.equal(rows("SELECT count(*) AS n FROM bookmarks")[0].n, 2);
  // Receipts: the first capture, the duplicate (existing) and the queued one.
  const receipts = rows("SELECT request_id, outcome FROM capture_receipts");
  assert.equal(receipts.length, 3);
  assert.ok(receipts.some((r) => r.request_id === firstId && r.outcome === "created"));
  assert.ok(receipts.some((r) => r.request_id === queued[0].request_id && r.outcome === "created"));

  // The host is not registered: the link waits, the options page offers the download.
  page = await options(id);
  unregister();
  await capture("https://example.invalid/not-registered", "Host не зарегистрирован");
  let refused = await waiting();
  assert.equal(refused.length, 1);
  assert.equal(refused[0].code, "host_missing");
  await page.reload();
  await page.locator('#status[data-state="missing"]').waitFor();
  register();
  await page.getByRole("button", { name: "Отправить сейчас" }).click();
  await until(async () => (await waiting()).length === 0, "delivery after the host came back");

  // The host refuses an extension id it does not list: the browser says «forbidden».
  await writeManifest("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/");
  await capture("https://example.invalid/foreign-id", "Чужой ID");
  refused = await waiting();
  assert.equal(refused.length, 1);
  assert.equal(refused[0].code, "host_missing");
  assert.match(refused[0].error, /не установлен/);
  await page.reload();
  await page.locator('#status[data-state="missing"]').waitFor();
  await page.getByRole("link", { name: "Скачать Netami Pin" }).waitFor();
  await writeManifest(`chrome-extension://${built.devId}/`);
  await page.getByRole("button", { name: "Отправить сейчас" }).click();
  await until(async () => (await waiting()).length === 0, "delivery after registration came back");
  assert.equal(rows("SELECT count(*) AS n FROM bookmarks")[0].n, 4);

  // The app keeps a record of this browser for its status.
  const connections = JSON.parse(rows("SELECT value FROM app_settings WHERE key='capture_connections'")[0].value);
  assert.ok(connections.browsers[target.source], `the app knows ${target.name}`);
  assert.deepEqual(
    [...new Set(rows("SELECT source FROM bookmarks").map((r) => r.source))],
    [target.source],
    "every link carries this browser's name",
  );
  await page.reload();
  await page.locator('#status[data-state="connected"]').waitFor();
  if (targetName === "chromium") {
    await page.screenshot({ path: "doc/concepts/chrome-options.jpg", fullPage: true });
    await page.emulateMedia({ colorScheme: "dark" });
    await sleep(400); // buttons change colour with a transition
    await page.screenshot({ path: path.join(directory, "chrome-options-dark.png"), fullPage: true });
  } else await page.screenshot({ path: path.join(directory, `${targetName}-options.png`), fullPage: true });
  console.log(`${target.name}: ${userAgent.match(/(Edg|Chrome)\/[\d.]+/g)?.join(" ")}; ${notes.join("; ") || "extension loaded over CDP"}`);
  console.log(`cold capture (app started by the host) ${coldMs} ms; alarm delivered the queued link in ${retryS} s`);
  console.log(
    `PASS ${target.name}: built MV3 package, native host, hello without starting the app, capture starts the app, duplicate, queue when the library fails, browser restart, delivery by the alarm, host not registered, foreign id, send now, browser record`,
  );
} finally {
  await browser?.close().catch(() => {});
  apps.stop();
  unregister();
}
