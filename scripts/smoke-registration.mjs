// The development registration on Linux (NP-100, Р-53, п. 3): the app's own `--register-host` writes the
// manifests into a temporary home, and the distribution's Chromium and Firefox find them there — a capture
// sent by the extension goes through koonapin-host into the library and starts the closed app;
// `--unregister-host` takes the manifests back. The button flows of the extension are the extension smoke's.
//
//   node scripts/smoke-registration.mjs
//
// Needs a display (the app), Chromium and Firefox: scripts/linux/ci-check.sh runs it with Debian's chromium
// and firefox-esr; KOONAPIN_CHROMIUM and KOONAPIN_FIREFOX point to others.
import { chromium } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, cp, mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildExtension, geckoId } from "./build-extension.mjs";
import { appBinary, assertNoOtherApp, capture, hostBinary, startedSince, testPipe } from "./lib/native-host.mjs";

if (process.platform !== "linux") throw new Error("The development registration of Linux: run it on Linux");
assertNoOtherApp();
const chromiumPath = process.env.KOONAPIN_CHROMIUM || "/usr/bin/chromium";
const firefoxPath = process.env.KOONAPIN_FIREFOX || "/usr/bin/firefox-esr";
for (const browser of [chromiumPath, firefoxPath]) if (!existsSync(browser)) throw new Error(`Not found: ${browser}`);

const directory = path.resolve(".test-data", `registration-${Date.now()}`);
const home = path.join(directory, "home");
const config = path.join(home, ".config");
await mkdir(config, { recursive: true });
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: config,
  KOONAPIN_DATA_DIR: directory,
  KOONAPIN_PIPE: testPipe("registration"),
};
const library = path.join(directory, "koonapin.db");
const rows = (sql) => {
  const db = new DatabaseSync(library, { readOnly: true });
  try {
    return db.prepare(sql).all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
};
async function until(check, label, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check().catch(() => null);
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`Timed out: ${label}`);
}

// The app registers itself, as a development build does with KOONAPIN_REGISTER_HOST=1.
execFileSync(appBinary(), ["--register-host"], { env, stdio: "inherit" });
const manifests = {
  chromium: path.join(config, "chromium", "NativeMessagingHosts", "app.koona.pin.json"),
  firefox: path.join(home, ".mozilla", "native-messaging-hosts", "app.koona.pin.json"),
};
for (const file of Object.values(manifests)) assert.equal(JSON.parse(readFileSync(file, "utf8")).path, hostBinary());

const built = await buildExtension({ log: () => {} });
const apps = startedSince();
let context, firefox;
try {
  // Chromium of the distribution, its usual profile under ~/.config/chromium: it reads NativeMessagingHosts there.
  context = await chromium.launchPersistentContext(path.join(config, "chromium"), {
    executablePath: chromiumPath,
    headless: true,
    env,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging"],
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: built.unpacked.chrome });
  assert.equal(id, built.devId, "the development key pins the extension id");
  const worker =
    context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${id}/`)) ??
    (await context.waitForEvent("serviceworker", { predicate: (w) => w.url().startsWith(`chrome-extension://${id}/`) }));
  const fromChromium = await worker.evaluate(
    (message) => chrome.runtime.sendNativeMessage("app.koona.pin", message),
    capture("registration-chromium", "https://example.invalid/chromium", "Chromium of the distribution"),
  );
  assert.equal(fromChromium.ok, true, JSON.stringify(fromChromium));
  assert.equal(fromChromium.outcome, "created");
  assert.equal(apps.ours().length, 1, "the host started the closed app");
  console.log(`ok: Chromium ${context.browser().version()} found the manifest, the capture is in the library`);

  // Firefox of the distribution with the same home: it reads ~/.mozilla/native-messaging-hosts.
  const profile = path.join(directory, "firefox-profile");
  await mkdir(profile, { recursive: true });
  const uuid = randomUUID();
  await writeFile(
    path.join(profile, "user.js"),
    [
      `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [geckoId]: uuid }))});`,
      `user_pref("browser.shell.checkDefaultBrowser", false);`,
      `user_pref("datareporting.policy.dataSubmissionEnabled", false);`,
    ].join("\n"),
  );
  // BiDi cannot open a moz-extension: page; the test copy opens its options page itself.
  const extension = path.join(directory, "firefox-extension");
  await cp(built.unpacked.firefox, extension, { recursive: true });
  await appendFile(path.join(extension, "worker.js"), "\next.runtime.openOptionsPage();\n");
  let output = "";
  firefox = spawn(
    firefoxPath,
    ["--headless", "--no-remote", "--profile", profile, "--remote-debugging-port", "0", "--remote-allow-system-access"],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  firefox.stdout.on("data", (chunk) => (output += chunk));
  firefox.stderr.on("data", (chunk) => (output += chunk));
  const url = await until(async () => output.match(/WebDriver BiDi listening on (ws:\/\/\S+)/)?.[1], "Firefox BiDi");
  const session = await bidi(`${url}/session`);
  await session.send("session.new", { capabilities: {} });
  await session.send("webExtension.install", { extensionData: { type: "path", path: extension } });
  const page = await until(async () => {
    const { contexts } = await session.send("browsingContext.getTree", {});
    return contexts.find((c) => c.url === `moz-extension://${uuid}/options.html`)?.context;
  }, "options page");
  const message = capture("registration-firefox", "https://example.invalid/firefox", "Firefox of the distribution", "firefox");
  const { result, exceptionDetails } = await session.send("script.evaluate", {
    expression: `browser.runtime.sendNativeMessage("app.koona.pin", ${JSON.stringify(message)}).then(JSON.stringify)`,
    target: { context: page },
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text);
  const fromFirefox = JSON.parse(result.value);
  assert.equal(fromFirefox.ok, true, JSON.stringify(fromFirefox));
  assert.equal(fromFirefox.outcome, "created");
  session.close();
  console.log("ok: Firefox found the manifest in ~/.mozilla, the capture is in the library");

  assert.deepEqual(rows("SELECT title, source FROM bookmarks ORDER BY id"), [
    { title: "Chromium of the distribution", source: "chrome" },
    { title: "Firefox of the distribution", source: "firefox" },
  ]);
} finally {
  firefox?.kill();
  await context?.close().catch(() => {});
  apps.stop();
}

// --unregister-host takes back what points at this host, and only that.
execFileSync(appBinary(), ["--unregister-host"], { env, stdio: "inherit" });
for (const file of Object.values(manifests)) assert.equal(existsSync(file), false, `${file} stays after --unregister-host`);
console.log("PASS: --register-host for the user, Chromium and Firefox of the distribution capture through the host, --unregister-host");

/** A WebDriver BiDi connection: send(method, params) answers with the result. */
async function bidi(url) {
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
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    close: () => ws.close(),
  };
}
