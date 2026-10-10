// Extension smoke (NP-016, NP-017): the built package in a Chromium browser,
// talking to Koona Pin through the real native host. The run registers a host
// name of its own, so an installed app's registration stays untouched.
//
//   bun scripts/smoke-extension.mjs [chromium|chrome|edge]
//
// chromium is Chrome for Testing from Playwright; chrome and edge are the
// installed browsers (KOONAPIN_CHROME / KOONAPIN_EDGE point to another copy).
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync } from "node:fs";
import http from "node:http";
import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { buildExtension } from "./build-extension.mjs";
import { assertNoOtherApp, hostBinary, moveLibrary, pipeReady, startedSince, testPipe } from "./lib/native-host.mjs";

assertNoOtherApp();

const targets = {
  // Chrome for Testing reads the Chromium key (checked in NP-016).
  chromium: { name: "Chrome for Testing", source: "chrome", package: "chrome", key: "Chromium", launch: { channel: "chromium" } },
  chrome: {
    name: "Chrome",
    source: "chrome",
    package: "chrome",
    key: "Google\\Chrome",
    launch: { executablePath: process.env.KOONAPIN_CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  },
  edge: {
    name: "Edge",
    source: "edge",
    package: "edge",
    key: "Microsoft\\Edge",
    launch: {
      executablePath: process.env.KOONAPIN_EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    },
  },
};
const targetName = process.argv[2] || "chromium";
const target = targets[targetName];
if (!target) throw new Error(`Unknown browser ${targetName}: use ${Object.keys(targets).join(", ")}`);
if (target.launch.executablePath && !existsSync(target.launch.executablePath))
  throw new Error(`${target.name} not found at ${target.launch.executablePath}`);

const HOST = "app.koona.pin.test";
const KEY = `HKCU\\Software\\${target.key}\\NativeMessagingHosts\\${HOST}`;
const directory = path.resolve(".test-data", `extension-${targetName}-${Date.now()}`);
await mkdir(directory, { recursive: true });
const extension = path.join(directory, "unpacked-extension");
const built = await buildExtension({ log: () => {} });
await cp(built.unpacked[target.package], extension, { recursive: true });
// Playwright does not expose toolbar clicks. Only the isolated test copy gets
// a reference to the exact handler registered with chrome.action.onClicked.
await appendFile(
  path.join(extension, "worker.js"),
  "\nglobalThis.__captureForTest = captureTab;\nglobalThis.__openSearchForTest = openSearch;\n",
);
// The click grants activeTab; without a click the test copy may script the
// local test page (NP-080, the message on the page).
const testManifest = path.join(extension, "manifest.json");
await writeFile(
  testManifest,
  JSON.stringify(
    (() => {
      const m = JSON.parse(readFileSync(testManifest, "utf8"));
      // A person grants the optional tabs permission with a click (NP-083); the copy has it from the start.
      return { ...m, permissions: [...m.permissions, "tabs"], host_permissions: ["http://127.0.0.1/*"] };
    })(),
    null,
    2,
  ),
);
const version = path.join(extension, "version.js");
await writeFile(version, (await readFile(version, "utf8")).replace('"app.koona.pin"', JSON.stringify(HOST)));

const pipe = testPipe("extension");
const env = {
  ...process.env,
  KOONAPIN_DATA_DIR: directory,
  WEBVIEW2_USER_DATA_FOLDER: path.join(directory, "webview"),
  KOONAPIN_PIPE: pipe,
};
// Linux (NP-054): no registry — Chromium reads a user's hosts from `NativeMessagingHosts` in its profile, so
// the test host lives in the run's own profile and the person's browsers never see it. Registered there is
// the file itself; on Windows the key points to it.
const linux = process.platform === "linux";
const manifest = linux
  ? path.join(directory, "profile", "NativeMessagingHosts", `${HOST}.json`)
  : path.join(directory, `${HOST}.json`);
const unregistered = `${manifest}.off`;
const writeManifest = async (origin) => {
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(
    existsSync(unregistered) ? unregistered : manifest,
    JSON.stringify({ name: HOST, description: "Koona Pin test", path: hostBinary(), type: "stdio", allowed_origins: [origin] }),
  );
};
const register = linux
  ? () => existsSync(unregistered) && renameSync(unregistered, manifest)
  : () => execFileSync("reg", ["add", KEY, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"], { stdio: "ignore" });
const unregister = () => {
  try {
    if (linux) renameSync(manifest, unregistered);
    else execFileSync("reg", ["delete", KEY, "/f"], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
};
await writeManifest(`chrome-extension://${built.devId}/`);
register();

// A missing app is calm on Linux: the browser may be a sandbox that keeps an installed app out (sheet 40).
const missingState = linux ? "unreachable" : "missing";
const apps = startedSince();
const library = path.join(directory, "koonapin.db");
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
const capture = (url, title, id) =>
  worker.evaluate(async ({ url, title, id }) => globalThis.__captureForTest({ url, title, id }), { url, title, id });
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
  await page.getByText("Koona Pin закрыт").waitFor();
  assert.equal(await pipeReady(pipe), false, "hello must not start the app");

  // A browser page cannot be saved: the button says so, nothing is queued.
  assert.equal(await capture("chrome://extensions/", "Расширения"), "failed");
  assert.equal((await waiting()).length, 0);

  // A capture starts the app in the tray and saves, under this browser's name.
  const started = performance.now();
  assert.equal(await capture("https://example.invalid/extension-capture", `Настоящий ${target.name}`), "saved");
  const coldMs = Math.round(performance.now() - started);
  assert.equal((await waiting()).length, 0);
  assert.equal(apps.ours().length, 1, "the host started the app");
  assert.deepEqual(rows("SELECT title, source FROM bookmarks"), [{ title: `Настоящий ${target.name}`, source: target.source }]);
  const [{ request_id: firstId }] = rows("SELECT request_id FROM capture_receipts");
  await page.getByRole("button", { name: "Проверить снова" }).click();
  await page.locator('#status[data-state="connected"]').waitFor();
  await page.getByText("Подключено к Koona Pin").waitFor();

  // A duplicate: existing, the title stays.
  assert.equal(await capture("https://example.invalid/extension-capture", "Заголовок дубликата"), "existing");
  assert.equal((await waiting()).length, 0);
  assert.deepEqual(rows("SELECT title FROM bookmarks"), [{ title: `Настоящий ${target.name}` }]);

  // The library cannot open: the link stays in the queue.
  apps.stop();
  await until(async () => !(await pipeReady(pipe)), "app stopped");
  await moveLibrary(library, `${library}.kept`);
  await writeFile(library, "not a database");
  assert.equal(await capture("https://example.invalid/library-failed", "Ждёт в очереди"), "queued");
  const queued = await waiting();
  assert.equal(queued.length, 1);
  assert.match(queued[0].error, /не ответил/);
  // Every tab shows the clock while a link waits; the title follows a successful setIcon.
  assert.match(await worker.evaluate(() => chrome.action.getTitle({})), /ожидают передачи 1/);
  assert.ok(await worker.evaluate(() => chrome.alarms.get("koonapin-delivery")));
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
  await moveLibrary(`${library}.kept`, library);
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
  await page.locator(`#status[data-state="${missingState}"]`).waitFor();
  register();
  await page.getByRole("button", { name: "Отправить сейчас" }).click();
  await until(async () => (await waiting()).length === 0, "delivery after the host came back");

  // The host refuses an extension id it does not list: the browser says «forbidden»,
  // and the extension says that, not «not installed» — a download does not help (NP-113).
  await writeManifest("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/");
  await capture("https://example.invalid/foreign-id", "Чужой ID");
  refused = await waiting();
  assert.equal(refused.length, 1);
  assert.equal(refused[0].code, "host_forbidden");
  assert.match(refused[0].error, /не принимает/);
  await page.reload();
  await page.locator('#status[data-state="forbidden"]').waitFor();
  await page.getByText("Koona Pin не принимает это расширение").waitFor();
  await page.locator("#status").getByRole("button", { name: "Проверить снова" }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Скачать Koona Pin" }).count(), 0);
  await writeManifest(`chrome-extension://${built.devId}/`);
  await page.getByRole("button", { name: "Отправить сейчас" }).click();
  await until(async () => (await waiting()).length === 0, "delivery after registration came back");
  assert.equal(rows("SELECT count(*) AS n FROM bookmarks")[0].n, 4);

  // NP-080: the answer on the page and on the button. The page forbids every
  // script and style of its own; the message is built from nodes in a shadow root.
  const site = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'" });
    response.end("<!doctype html><title>Отклик</title><h1>Страница для отклика</h1>");
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  try {
    const pageUrl = `http://127.0.0.1:${site.address().port}/feedback`;
    const tab = await browser.newPage();
    await tab.goto(pageUrl);
    const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, pageUrl);
    assert.ok(Number.isInteger(tabId), "the test page is a tab");
    const title = () => worker.evaluate((tabId) => chrome.action.getTitle({ tabId }), tabId);
    const message = tab.locator("#koonapin-feedback");
    assert.equal(await capture(pageUrl, "Отклик", tabId), "saved");
    await tab.locator('#koonapin-feedback[data-state="saved"]').waitFor();
    assert.equal(await title(), "Сохранено в Koona Pin");
    await sleep(400); // the message fades in
    await tab.screenshot({ path: path.join(directory, "feedback-saved-light.png") });
    await message.waitFor({ state: "detached", timeout: 6000 }); // leaves by itself after 3 s
    await tab.emulateMedia({ colorScheme: "dark" });
    assert.equal(await capture(pageUrl, "Отклик", tabId), "existing");
    await tab.locator('#koonapin-feedback[data-state="existing"]').waitFor();
    assert.equal(await title(), "Эта ссылка уже есть в Koona Pin");
    await sleep(400);
    await tab.screenshot({ path: path.join(directory, "feedback-existing-dark.png") });
    await tab.mouse.click(1100, 40); // a click closes it
    await message.waitFor({ state: "detached", timeout: 2000 });
    // «After saving» off: only the button answers.
    await worker.evaluate(() => chrome.storage.local.set({ feedback: { message: false, animate: false } }));
    assert.equal(await capture(pageUrl, "Отклик", tabId), "existing");
    await sleep(800);
    assert.equal(await message.count(), 0, "no message when it is turned off");
    assert.equal(await title(), "Эта ссылка уже есть в Koona Pin");
    await worker.evaluate(() => chrome.storage.local.remove("feedback"));
    await tab.close();

    // NP-083: with «show that a page is already saved» on, a saved page gets
    // the soft check as it loads, without a click; another page does not.
    await worker.evaluate(() => chrome.storage.local.set({ feedback: { known: true } }));
    const again = await browser.newPage();
    await again.goto(pageUrl);
    const againId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, pageUrl);
    await until(
      async () => (await worker.evaluate((tabId) => chrome.action.getTitle({ tabId }), againId)) === "Эта ссылка уже есть в Koona Pin",
      "a saved page is marked on load",
    );
    const otherUrl = pageUrl.replace("/feedback", "/not-saved");
    const other = await browser.newPage();
    await other.goto(otherUrl);
    const otherId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, otherUrl);
    await sleep(1000);
    assert.notEqual(await worker.evaluate((tabId) => chrome.action.getTitle({ tabId }), otherId), "Эта ссылка уже есть в Koona Pin");
    // An address the page rewrites itself (history.replaceState: tracking
    // parameters dropped, an app's route) is asked about too: Chrome reports
    // it as loading and complete, with no network load.
    const rewrittenUrl = pageUrl.replace("/feedback", "/rewritten");
    const rewritten = await browser.newPage();
    await rewritten.goto(rewrittenUrl);
    const rewrittenId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, rewrittenUrl);
    await sleep(500);
    await rewritten.evaluate(() => history.replaceState(null, "", "/feedback"));
    await until(
      async () => (await worker.evaluate((tabId) => chrome.action.getTitle({ tabId }), rewrittenId)) === "Эта ссылка уже есть в Koona Pin",
      "a page rewritten to a saved address is marked",
    );
    await worker.evaluate(() => chrome.storage.local.remove("feedback"));
    await Promise.all([again.close(), other.close(), rewritten.close()]);
  } finally {
    site.close();
  }
  assert.equal(rows("SELECT count(*) AS n FROM bookmarks")[0].n, 5);

  // NP-082: the quick search. The popup's page opened as a tab talks to the
  // app the same way; the shortcut is the browser's, the popup is set only
  // for one opening.
  const commands = await worker.evaluate(() => chrome.commands.getAll());
  assert.equal(commands.find((c) => c.name === "quick-search")?.shortcut, "Alt+Shift+D");
  await worker.evaluate(() => globalThis.__openSearchForTest());
  assert.equal(await worker.evaluate(() => chrome.action.getPopup({})), "", "the button saves again after the search");
  const search = await browser.newPage();
  await search.goto(`chrome-extension://${id}/search.html`);
  const results = search.locator("#results li");
  await search.getByText("Недавно сохранённые").waitFor();
  assert.equal(await results.count(), 5, "an empty query lists the latest saved");
  await search.getByRole("button", { name: "Входящие 5" }).waitFor();
  await search.locator("#query").fill("очереди");
  await search.locator("#results li", { hasText: "Ждёт в очереди" }).waitFor();
  await until(async () => (await results.count()) === 1, "one match");
  await search.getByRole("button", { name: "Все 1" }).waitFor();
  await search.locator("#query").fill("нет такого слова");
  await search.getByText("По «нет такого слова» ничего не нашлось").waitFor();
  await search.locator("#query").fill("Отклик");
  await search.locator("#results li", { hasText: "Отклик" }).waitFor();
  await search.screenshot({ path: path.join(directory, "search-results.png") });
  // The page closes itself after opening, as the popup does; the new tab has the link.
  const opened = () =>
    worker.evaluate(async () =>
      (await chrome.tabs.query({})).some((tab) => /^http:\/\/127\.0\.0\.1:\d+\/feedback$/.test(tab.pendingUrl || tab.url || "")),
    );
  // The page may close before Playwright sees the press end: only that error is expected.
  await search
    .locator("#query")
    .press("Enter")
    .catch((error) => {
      if (!/has been closed/.test(error.message)) throw error;
    });
  await until(opened, "Enter opens the link in a new tab");
  await search.close().catch(() => {});

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
    await page.screenshot({ path: path.join(directory, "chrome-options.jpg"), fullPage: true });
    await page.emulateMedia({ colorScheme: "dark" });
    await sleep(400); // buttons change colour with a transition
    await page.screenshot({ path: path.join(directory, "chrome-options-dark.png"), fullPage: true });
  } else await page.screenshot({ path: path.join(directory, `${targetName}-options.png`), fullPage: true });
  console.log(`${target.name}: ${userAgent.match(/(Edg|Chrome)\/[\d.]+/g)?.join(" ")}; ${notes.join("; ") || "extension loaded over CDP"}`);
  console.log(`cold capture (app started by the host) ${coldMs} ms; alarm delivered the queued link in ${retryS} s`);
  console.log(
    `PASS ${target.name}: built MV3 package, native host, hello without starting the app, capture starts the app, duplicate, queue when the library fails, browser restart, delivery by the alarm, host not registered, foreign id, send now, browser record, save feedback on the button and the page, already saved before a click, quick search`,
  );
} finally {
  await browser?.close().catch(() => {});
  apps.stop();
  unregister();
}
