// Firefox check of the built package (NP-015): release/netamipin-firefox.xpi
// installs as a temporary add-on, its background event page (an ES module)
// answers the options page, and the page is translated.
//
// Firefox is driven over WebDriver BiDi. Path: NETAMIPIN_FIREFOX, otherwise
// the scoop install. Netami Pin need not run: the page reports it as missing.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildExtension, geckoId } from "./build-extension.mjs";

const firefox =
  process.env.NETAMIPIN_FIREFOX ||
  path.join(process.env.USERPROFILE ?? "", "scoop", "apps", "firefox", "current", "firefox.exe");
if (!existsSync(firefox)) throw new Error(`Firefox not found: ${firefox}. Set NETAMIPIN_FIREFOX.`);

const built = await buildExtension({ log: () => {} });
const profile = path.resolve(".test-data", `extension-firefox-${Date.now()}`);
await mkdir(profile, { recursive: true });
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

async function until(check, label, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
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
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    close: () => ws.close(),
  };
}

const browser = spawn(
  firefox,
  ["--headless", "--no-remote", "--profile", profile, "--remote-debugging-port", "0", "--remote-allow-system-access"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
browser.stdout.on("data", (chunk) => (output += chunk));
browser.stderr.on("data", (chunk) => (output += chunk));
let session;
try {
  const url = await until(() => output.match(/WebDriver BiDi listening on (ws:\/\/\S+)/)?.[1], "Firefox BiDi");
  session = await connect(`${url}/session`);
  await session.send("session.new", { capabilities: {} });
  const { extension } = await session.send("webExtension.install", {
    extensionData: { type: "archivePath", path: built.packages.firefox },
  });
  assert.equal(extension, geckoId);

  // Pages may not navigate to moz-extension:, the browser window opens the tab.
  const page = `moz-extension://${uuid}/options.html`;
  const { contexts: windows } = await session.send("browsingContext.getTree", { "moz:scope": "chrome" });
  await session.send("script.evaluate", {
    expression: `gBrowser.selectedTab = gBrowser.addTab(${JSON.stringify(page)}, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    }); true`,
    target: { context: windows[0].context },
    awaitPromise: false,
  });
  const context = await until(async () => {
    const { contexts } = await session.send("browsingContext.getTree", {});
    return contexts.find((c) => c.url === page)?.context;
  }, "options page");
  const read = async () => {
    const { result } = await session.send("script.evaluate", {
      expression: `JSON.stringify({
        lang: document.documentElement.lang,
        heading: document.querySelector("h1").textContent,
        status: document.getElementById("status").dataset.state,
        count: document.getElementById("count").textContent,
        empty: document.querySelector("#queue .empty")?.textContent ?? null,
        message: document.getElementById("message").textContent,
      })`,
      target: { context },
      awaitPromise: false,
    });
    return JSON.parse(result.value);
  };
  // The queue and the status come from the background page; the status from
  // a hello through native messaging.
  const state = await until(async () => {
    const s = await read();
    return s.empty && s.status !== "checking" ? s : null;
  }, "answer from the background page");
  assert.equal(state.message, "", `options page error: ${state.message}`);
  assert.equal(state.count, "0");
  assert.equal(state.heading, "Netami Pin extension");
  // Which state depends on whether this computer registered the host; any of
  // them means the background page talked to the browser's native messaging.
  assert.ok(["missing", "closed", "connected", "update"].includes(state.status), state.status);
  console.log(
    `PASS: Firefox temporary install of ${path.basename(built.packages.firefox)}, background module, native messaging hello (${state.status}), options page (${state.lang})`,
  );
} finally {
  await session?.send("browser.close", {}).catch(() => {});
  session?.close();
  if (browser.exitCode === null) await new Promise((resolve) => browser.once("exit", resolve));
}
