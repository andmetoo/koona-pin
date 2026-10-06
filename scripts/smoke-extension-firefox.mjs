// Firefox smoke (NP-015, NP-018): the built package talks to Koona Pin through
// the real native host, as the Chromium smoke does.
//
//   node scripts/smoke-extension-firefox.mjs [release|esr]
//
// release is the current Firefox, esr is Firefox ESR 140 (scoop installs;
// KOONAPIN_FIREFOX points to another copy). Firefox is driven over WebDriver
// BiDi with a temporary add-on, which a browser restart removes: the restart is
// checked by hand with the signed XPI (doc/testing.md).
import { spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildExtension, geckoId } from "./build-extension.mjs";
import { assertNoOtherApp, hostBinary, pipeReady, startedSince, testPipe } from "./lib/native-host.mjs";

assertNoOtherApp();

const flavor = process.argv[2] || "release";
const scoop = (app) => path.join(process.env.USERPROFILE ?? "", "scoop", "apps", app, "current", "firefox.exe");
const firefox = process.env.KOONAPIN_FIREFOX || scoop(flavor === "esr" ? "firefox-esr" : "firefox");
if (!["release", "esr"].includes(flavor)) throw new Error(`Unknown Firefox ${flavor}: use release or esr`);
if (!existsSync(firefox)) throw new Error(`Firefox not found: ${firefox}. Set KOONAPIN_FIREFOX.`);

const HOST = "app.koona.pin.test";
const KEY = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST}`;
const directory = path.resolve(".test-data", `extension-firefox-${flavor}-${Date.now()}`);
const profile = path.join(directory, "profile");
await mkdir(profile, { recursive: true });
const built = await buildExtension({ log: () => {} });
const extension = path.join(directory, "unpacked-extension");
await cp(built.unpacked.firefox, extension, { recursive: true });
// No toolbar clicks over BiDi: the test copy exposes the click handler. BiDi
// pages may not open moz-extension: and ESR 140 has no chrome scope, so the
// copy opens its options page itself.
await appendFile(
  path.join(extension, "worker.js"),
  `
globalThis.__captureForTest = captureTab;
ext.storage.session.get("testOptionsOpened").then(async ({ testOptionsOpened }) => {
  if (testOptionsOpened) return;
  await ext.storage.session.set({ testOptionsOpened: true });
  await ext.runtime.openOptionsPage();
});
`,
);
const version = path.join(extension, "version.js");
await writeFile(version, (await readFile(version, "utf8")).replace('"app.koona.pin"', JSON.stringify(HOST)));

// A fixed internal UUID gives the options page a known moz-extension: address.
const uuid = randomUUID();
await writeFile(
  path.join(profile, "user.js"),
  [
    `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [geckoId]: uuid }))});`,
    `user_pref("browser.shell.checkDefaultBrowser", false);`,
    `user_pref("datareporting.policy.dataSubmissionEnabled", false);`,
  ].join("\n"),
);

const pipe = testPipe("firefox");
const env = {
  ...process.env,
  KOONAPIN_DATA_DIR: directory,
  WEBVIEW2_USER_DATA_FOLDER: path.join(directory, "webview"),
  KOONAPIN_PIPE: pipe,
};
const manifest = path.join(directory, `${HOST}.json`);
const writeManifest = (id) =>
  writeFile(
    manifest,
    JSON.stringify({ name: HOST, description: "Koona Pin test", path: hostBinary(), type: "stdio", allowed_extensions: [id] }),
  );
const register = () => execFileSync("reg", ["add", KEY, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"], { stdio: "ignore" });
const unregister = () => {
  try {
    execFileSync("reg", ["delete", KEY, "/f"], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
};
await writeManifest(geckoId);
register();

const apps = startedSince();
const library = path.join(directory, "koonapin.db");
async function until(check, label, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`Timed out: ${label}`);
}
function rows(sql) {
  const db = new DatabaseSync(library, { readOnly: true });
  try {
    return db.prepare(sql).all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`Cannot connect ${url}`));
  });
  let next = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.type === "error") waiter.reject(new Error(`${message.error}: ${message.message}`));
    else waiter.resolve(message.result);
  };
  return {
    // A call into a page that went away never answers: fail instead of hanging.
    send: (method, params = {}, ms = 60000) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`BiDi ${method} did not answer in ${ms} ms`));
        }, ms);
        pending.set(id, {
          resolve: (value) => (clearTimeout(timer), resolve(value)),
          reject: (error) => (clearTimeout(timer), reject(error)),
        });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    close: () => ws.close(),
  };
}

const optionsUrl = `moz-extension://${uuid}/options.html`;
let output = "";
const proc = spawn(
  firefox,
  ["--headless", "--no-remote", "--profile", profile, "--remote-debugging-port", "0", "--remote-allow-system-access"],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
proc.stdout.on("data", (chunk) => (output += chunk));
proc.stderr.on("data", (chunk) => (output += chunk));
// Whatever happens, the run ends: a stuck browser fails the check, not the terminal.
const limit = setTimeout(() => {
  console.error("FAIL: the run took longer than 10 minutes");
  proc.kill();
  apps.stop();
  unregister();
  process.exit(1);
}, 10 * 60 * 1000);

let session, page;
/** Runs an async function body in the options page; returns its JSON result. */
async function run(body, arg = null) {
  const { result, exceptionDetails } = await session.send("script.evaluate", {
    expression: `(async (arg) => { ${body} })(${JSON.stringify(arg)}).then((r) => JSON.stringify(r ?? null))`,
    target: { context: page },
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text);
  return JSON.parse(result.value);
}
const capture = (url, title) =>
  run("const bg = await browser.runtime.getBackgroundPage(); await bg.__captureForTest(arg); return true;", { url, title });
const waiting = () => run('return (await browser.storage.local.get("captureQueue")).captureQueue || [];');
const status = () => run('return document.getElementById("status").dataset.state;');
const reload = () => run("setTimeout(() => location.reload(), 0); return true;");
// The page may be reloading (a reload, or the extension opening its settings
// for host_missing): the button is waited for, not clicked blindly.
const click = (label) =>
  until(
    () =>
      run(
        "const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === arg); if (!b) return false; b.click(); return true;",
        label,
      ).catch(() => false),
    `button «${label}»`,
    5000,
  );

try {
  const url = await until(() => output.match(/WebDriver BiDi listening on (ws:\/\/\S+)/)?.[1], "Firefox BiDi");
  session = await connect(`${url}/session`);
  const { capabilities } = await session.send("session.new", { capabilities: {} });
  const { extension: id } = await session.send("webExtension.install", { extensionData: { type: "path", path: extension } });
  assert.equal(id, geckoId);
  page = await until(async () => {
    const { contexts } = await session.send("browsingContext.getTree", {});
    return contexts.find((c) => c.url === optionsUrl)?.context;
  }, "options page");

  // A hello does not start the app the user closed.
  await until(async () => (await status()) === "closed", "status closed");
  assert.equal(await pipeReady(pipe), false, "hello must not start the app");

  // A capture starts the app in the tray and saves under the name firefox.
  const started = performance.now();
  await capture("https://example.invalid/firefox-capture", "Настоящий Firefox");
  const coldMs = Math.round(performance.now() - started);
  const first = await waiting();
  assert.equal(first.length, 0, JSON.stringify(first));
  assert.equal(apps.ours().length, 1, "the host started the app");
  assert.deepEqual(rows("SELECT title, source FROM bookmarks"), [{ title: "Настоящий Firefox", source: "firefox" }]);
  const [{ request_id: firstId }] = rows("SELECT request_id FROM capture_receipts");
  await reload();
  await until(async () => (await status()) === "connected", "status connected");

  // A duplicate: existing, the title stays.
  await capture("https://example.invalid/firefox-capture", "Заголовок дубликата");
  assert.equal((await waiting()).length, 0);
  assert.deepEqual(rows("SELECT title FROM bookmarks"), [{ title: "Настоящий Firefox" }]);

  // The library cannot open: the link stays in the queue.
  apps.stop();
  await until(async () => !(await pipeReady(pipe)), "app stopped");
  for (const suffix of ["", "-wal", "-shm"]) await rename(library + suffix, `${library}.kept${suffix}`).catch(() => {});
  await writeFile(library, "not a database");
  await capture("https://example.invalid/library-failed", "Ждёт в очереди");
  const queued = await waiting();
  assert.equal(queued.length, 1);
  assert.match(queued[0].error, /didn't answer|не ответил/);
  // NP-080: the event page draws the clock into the icon; the title is set only after setIcon succeeds.
  assert.match(await run("return browser.action.getTitle({});"), /waiting to be sent|ожидают передачи/);
  assert.ok(await run('return !!(await browser.alarms.get("koonapin-delivery"));'));

  // The library is back: the delivery alarm brings the link without a click.
  apps.stop();
  await until(async () => !(await pipeReady(pipe)), "no app left");
  await rm(library);
  for (const suffix of ["", "-wal", "-shm"]) await rename(`${library}.kept${suffix}`, library + suffix).catch(() => {});
  const retried = performance.now();
  await until(async () => (await waiting()).length === 0, "delivery by the alarm", 150000);
  const retryS = Math.round((performance.now() - retried) / 1000);
  assert.equal(rows("SELECT count(*) AS n FROM bookmarks")[0].n, 2);
  const receipts = rows("SELECT request_id, outcome FROM capture_receipts");
  assert.equal(receipts.length, 3);
  assert.ok(receipts.some((r) => r.request_id === firstId && r.outcome === "created"));
  assert.ok(receipts.some((r) => r.request_id === queued[0].request_id && r.outcome === "created"));

  // The host is not registered: the link waits, the page offers the download.
  unregister();
  await capture("https://example.invalid/not-registered", "Host не зарегистрирован");
  let refused = await waiting();
  assert.equal(refused.length, 1);
  assert.equal(refused[0].code, "host_missing", refused[0].error);
  await reload();
  await until(async () => (await status()) === "missing", "status missing");
  register();
  await click("Send now");
  await until(async () => (await waiting()).length === 0, "delivery after the host came back");

  // The host lists another add-on id: Firefox refuses to start it.
  await writeManifest("other@koona.app");
  await capture("https://example.invalid/foreign-id", "Чужой ID");
  refused = await waiting();
  assert.equal(refused.length, 1);
  assert.equal(refused[0].code, "host_missing", refused[0].error);
  await writeManifest(geckoId);
  await reload();
  await until(async () => (await status()) === "connected", "status after the id came back");
  await click("Send now");
  await until(async () => (await waiting()).length === 0, "delivery after the id came back");
  assert.equal(rows("SELECT count(*) AS n FROM bookmarks")[0].n, 4);

  // The app keeps a record of Firefox for its status.
  const connections = JSON.parse(rows("SELECT value FROM app_settings WHERE key='capture_connections'")[0].value);
  assert.ok(connections.browsers.firefox, "the app knows Firefox");
  assert.deepEqual([...new Set(rows("SELECT source FROM bookmarks").map((r) => r.source))], ["firefox"]);
  console.log(`Firefox ${capabilities.browserVersion} (${flavor}); cold capture ${coldMs} ms; alarm delivered the queued link in ${retryS} s`);
  console.log(
    `PASS Firefox ${flavor}: native host, hello without starting the app, capture starts the app, duplicate, queue when the library fails, delivery by the alarm, host not registered, foreign id, send now, browser record, the queue clock drawn into the icon`,
  );
} catch (error) {
  // Firefox prints what the native host writes to stderr.
  console.error(output.slice(-2000));
  throw error;
} finally {
  clearTimeout(limit);
  await session?.send("browser.close", {}, 10000).catch(() => {});
  session?.close();
  if (proc.exitCode === null) await Promise.race([new Promise((resolve) => proc.once("exit", resolve)), sleep(15000)]);
  if (proc.exitCode === null) proc.kill();
  apps.stop();
  unregister();
}
