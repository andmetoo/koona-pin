// NP-014 prototype run: registers the probe host for the current user, drives
// the installed Chrome, Edge and Firefox headless with a test extension and
// writes results.json. Registry keys are removed at the end.
//
//   cargo build --release --manifest-path scripts/native-messaging-probe/Cargo.toml
//   node scripts/native-messaging-probe/run.mjs [chrome] [edge] [firefox] [firefox-msix]
import { chromium } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const hostName = "app.koona.pin.probe";
const firefoxId = "probe@koona.pin";
const firefoxUuid = crypto.randomUUID();
const root = path.resolve(".test-data", `native-messaging-${Date.now()}`);
const hostDir = path.join(root, "host");
const exe = path.join(hostDir, "koonapin-probe.exe");
const logPath = path.join(hostDir, "probe.log");
const source = path.resolve("scripts/native-messaging-probe");
const appData = process.env.APPDATA;

const browsers = {
  chrome: { kind: "chromium", exe: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", key: "Google\\Chrome" },
  // A copy of the Application folder starts where a redirector (an IFEO
  // debugger such as MSEdgeRedirect) intercepts the installed msedge.exe.
  edge: {
    kind: "chromium",
    exe: process.env.KOONAPIN_PROBE_EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    key: "Microsoft\\Edge",
  },
  firefox: { kind: "firefox", exe: path.join(process.env.USERPROFILE, "scoop\\apps\\firefox\\current\\firefox.exe"), key: "Mozilla" },
  "firefox-msix": { kind: "firefox", exe: msixFirefox(), key: "Mozilla" },
};
const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(browsers);

function msixFirefox() {
  try {
    const location = execFileSync("powershell", ["-NoProfile", "-Command", "(Get-AppxPackage Mozilla.Firefox).InstallLocation"], { encoding: "utf8" }).trim();
    return location && path.join(location, "VFS\\ProgramFiles\\Firefox Package Root\\firefox.exe");
  } catch {
    return undefined;
  }
}

// --- setup ----------------------------------------------------------------

const keys = [];
function register(browserKey, manifest) {
  const key = `HKCU\\Software\\${browserKey}\\NativeMessagingHosts\\${hostName}`;
  execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"], { stdio: "ignore" });
  if (!keys.includes(key)) keys.push(key);
  return key;
}
function unregister(key) {
  try {
    execFileSync("reg", ["delete", key, "/f"], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}

/** A fixed public key pins the Chromium extension id, as a store listing does. */
function extensionKey() {
  const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" });
  const id = [...crypto.createHash("sha256").update(der).digest("hex").slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join("");
  return { key: der.toString("base64"), id };
}

async function setup() {
  await fs.mkdir(hostDir, { recursive: true });
  await fs.copyFile(path.join(source, "target/release/native-messaging-probe.exe"), exe);
  const { key, id } = extensionKey();
  const common = { name: hostName, description: "Koona Pin NP-014 probe", path: "koonapin-probe.exe", type: "stdio" };
  const manifests = {
    chromium: path.join(hostDir, "chromium.json"),
    firefox: path.join(hostDir, "firefox.json"),
  };
  const chromiumManifest = { ...common, allowed_origins: [`chrome-extension://${id}/`] };
  const firefoxManifest = { ...common, allowed_extensions: [firefoxId] };
  await fs.writeFile(manifests.chromium, JSON.stringify(chromiumManifest, null, 2));
  await fs.writeFile(manifests.firefox, JSON.stringify(firefoxManifest, null, 2));

  const extension = { chromium: path.join(root, "ext-chromium"), firefox: path.join(root, "ext-firefox") };
  for (const dir of Object.values(extension)) {
    await fs.mkdir(dir, { recursive: true });
    for (const file of ["probe.js", "probe.html"]) await fs.copyFile(path.join(source, "extension", file), path.join(dir, file));
  }
  const base = { manifest_version: 3, name: "Koona Pin probe", version: "0.0.1", permissions: ["nativeMessaging"] };
  await fs.writeFile(
    path.join(extension.chromium, "manifest.json"),
    JSON.stringify({ ...base, key, background: { service_worker: "probe.js" } }, null, 2),
  );
  await fs.writeFile(
    path.join(extension.firefox, "manifest.json"),
    JSON.stringify(
      { ...base, browser_specific_settings: { gecko: { id: firefoxId } }, background: { scripts: ["open.js"] } },
      null,
      2,
    ),
  );
  // WebDriver BiDi may not navigate to moz-extension:, the extension opens its page itself.
  await fs.writeFile(path.join(extension.firefox, "open.js"), 'browser.tabs.create({ url: "probe.html" });\n');
  return { id, manifests, chromiumManifest, firefoxManifest, extension };
}

// --- helpers --------------------------------------------------------------

const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}
const pipeReady = () =>
  new Promise((resolve) => {
    const socket = net.connect("\\\\.\\pipe\\koonapin-probe");
    socket.on("connect", () => {
      socket.end(JSON.stringify({ cmd: "noop" }) + "\n");
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
async function startApp() {
  spawn(exe, ["app"], { detached: true, stdio: "ignore" }).unref();
  await until(pipeReady, "probe app pipe");
}
async function stopApps() {
  try {
    execFileSync("taskkill", ["/F", "/IM", "koonapin-probe.exe"], { stdio: "ignore" });
  } catch {
    /* none running */
  }
  await until(async () => !(await pipeReady()), "probe app stopped");
}
async function readLog() {
  const text = await fs.readFile(logPath, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  const round = (x) => Math.round(x * 10) / 10;
  return { n: times.length, first: round(times[0]), median: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1)) };
}
const appStart = async (pid) => (await readLog()).find((e) => e.role === "app" && e.event === "start" && e.pid === pid);
/** A browser that does not exit is a finding, not a reason to hang the run. */
async function closeWithin(b, ms = 15000) {
  const closed = await Promise.race([b.close().then(() => true), sleep(ms).then(() => false)]);
  return closed;
}
/** Where the probe app's %APPDATA% write really landed. */
async function marker(pid) {
  if (!pid) return null;
  const direct = path.join(appData, "koonapin-probe", `app-${pid}.txt`);
  if (existsSync(direct)) return "real %APPDATA%";
  const packages = path.join(process.env.LOCALAPPDATA, "Packages");
  for (const dir of await fs.readdir(packages).catch(() => [])) {
    if (existsSync(path.join(packages, dir, "LocalCache\\Roaming\\koonapin-probe", `app-${pid}.txt`)))
      return `redirected to Packages\\${dir}\\LocalCache`;
  }
  return "not found";
}

// --- browsers -------------------------------------------------------------

async function openChromium(name, setupResult) {
  const context = await chromium.launchPersistentContext(path.join(root, `profile-${name}-${Date.now()}`), {
    executablePath: browsers[name].exe,
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging"],
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: setupResult.extension.chromium });
  if (id !== setupResult.id) throw new Error(`Extension id ${id} differs from the pinned ${setupResult.id}`);
  const worker =
    context.serviceWorkers().find((w) => w.url().includes(id)) ??
    (await context.waitForEvent("serviceworker", { predicate: (w) => w.url().includes(id) }));
  return {
    run: (fn, arg) => worker.evaluate(fn, arg),
    close: () => context.close(),
  };
}

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

async function openFirefox(name, setupResult) {
  const profile = path.join(root, `profile-${name}-${Date.now()}`);
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(
    path.join(profile, "user.js"),
    [
      `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [firefoxId]: firefoxUuid }))});`,
      `user_pref("browser.shell.checkDefaultBrowser", false);`,
      `user_pref("datareporting.policy.dataSubmissionEnabled", false);`,
      `user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);`,
    ].join("\n"),
  );
  const proc = spawn(browsers[name].exe, ["--headless", "--no-remote", "--profile", profile, "--remote-debugging-port", "0", "--remote-allow-system-access"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", (chunk) => (output += chunk));
  proc.stderr.on("data", (chunk) => (output += chunk));
  const url = await until(() => output.match(/WebDriver BiDi listening on (ws:\/\/\S+)/)?.[1], `${name} BiDi`, 30000);
  const session = await bidi(`${url}/session`);
  await session.send("session.new", { capabilities: {} });
  await session.send("webExtension.install", { extensionData: { type: "path", path: setupResult.extension.firefox } });
  const page = `moz-extension://${firefoxUuid}/probe.html`;
  const context = await until(async () => {
    const { contexts } = await session.send("browsingContext.getTree", {});
    return contexts.find((c) => c.url === page)?.context;
  }, `${name} probe page`);
  return {
    async run(fn, arg) {
      const { result, exceptionDetails } = await session.send("script.evaluate", {
        expression: `(${fn})(${JSON.stringify(arg)}).then((r) => JSON.stringify(r))`,
        target: { context },
        awaitPromise: true,
      });
      if (exceptionDetails) throw new Error(exceptionDetails.text);
      return JSON.parse(result.value);
    },
    async close() {
      await session.send("browser.close", {}).catch(() => {});
      session.close();
      if (proc.exitCode === null) await new Promise((resolve) => proc.once("exit", resolve));
    },
  };
}

// --- scenario -------------------------------------------------------------

const send = (message) => globalThis.probe.send(message);
const sendTo = ([name, message]) => globalThis.probe.send(message, name);
const port = (count) => globalThis.probe.port(count);

async function scenario(name, setupResult) {
  const open = () => (browsers[name].kind === "chromium" ? openChromium : openFirefox)(name, setupResult);
  const manifest = browsers[name].kind === "chromium" ? setupResult.manifests.chromium : setupResult.manifests.firefox;
  const key = register(browsers[name].key, manifest);
  const logFrom = (await readLog()).length;
  const result = { browser: name };
  await stopApps();
  let b = await open();
  try {
    result.ping = (await b.run(send, { cmd: "ping" })).reply?.host;

    result.app_closed = await b.run(send, { cmd: "capture", url: "https://example.invalid/closed", spawn: "none" });
    result.app_closed = { outcome: result.app_closed.reply?.outcome, ms: Math.round(result.app_closed.ms), error: result.app_closed.error };

    await startApp();
    const times = [];
    for (let i = 0; i < 20; i++) {
      const r = await b.run(send, { cmd: "capture", url: `https://example.invalid/send/${i}` });
      if (!r.reply?.ok) throw new Error(`capture failed: ${JSON.stringify(r)}`);
      times.push(r.ms);
    }
    result.send_native_message = stats(times);

    const p = await b.run(port, 20);
    await sleep(3000);
    result.connect_native = { ...stats(p.times), host_exited_3s_after_disconnect: !alive(p.hostPid) };

    for (const mode of ["plain", "breakaway"]) {
      await stopApps();
      const r = await b.run(send, { cmd: "capture", url: `https://example.invalid/spawn/${mode}`, spawn: mode, wait_ms: 8000 });
      await sleep(3000);
      const pid = r.reply?.spawned?.pid;
      result[`host_starts_app_${mode}`] = {
        outcome: r.reply?.outcome ?? r.error,
        ms: Math.round(r.ms),
        spawn_error: r.reply?.spawned?.error,
        app_package: r.reply?.app?.package ?? null,
        app_in_browser_job: (await appStart(pid))?.in_job ?? null,
        app_alive_3s_after_host_exit: alive(pid),
        appdata_write: await marker(pid),
      };
    }

    result.errors = {
      unknown_host: (await b.run(sendTo, ["app.koona.pin.missing", { cmd: "ping" }])).error,
    };
    const original = await fs.readFile(manifest, "utf8");
    const parsed = JSON.parse(original);
    if (parsed.allowed_origins) parsed.allowed_origins = ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"];
    else parsed.allowed_extensions = ["other@koona.pin"];
    await fs.writeFile(manifest, JSON.stringify(parsed));
    result.errors.forbidden = (await b.run(send, { cmd: "ping" })).error;
    await fs.writeFile(manifest, JSON.stringify({ ...parsed, path: "missing.exe", allowed_origins: JSON.parse(original).allowed_origins, allowed_extensions: JSON.parse(original).allowed_extensions }));
    result.errors.missing_binary = (await b.run(send, { cmd: "ping" })).error;
    await fs.writeFile(manifest, original);
    unregister(key);
    result.errors.not_registered = (await b.run(send, { cmd: "ping" })).error;
    register(browsers[name].key, manifest);

    // Does an app started by the host survive the browser itself?
    result.browser_exit = {};
    for (const mode of ["plain", "breakaway"]) {
      await stopApps();
      b ??= await open();
      const r = await b.run(send, { cmd: "capture", url: `https://example.invalid/exit/${mode}`, spawn: mode, wait_ms: 8000 });
      const closed = await closeWithin(b);
      b = null;
      await sleep(3000);
      result.browser_exit[mode] = {
        outcome: r.reply?.outcome ?? r.error,
        browser_closed_in_15s: closed,
        app_alive_3s_after_browser_exit: alive(r.reply?.spawned?.pid),
      };
    }
  } catch (error) {
    result.failure = String(error?.stack ?? error);
  } finally {
    if (b) await closeWithin(b).catch(() => {});
    await stopApps();
  }
  const entries = (await readLog()).slice(logFrom);
  const hosts = entries.filter((e) => e.role === "host" && e.event === "start");
  result.host_processes = hosts.length;
  result.host_exits_logged = entries.filter((e) => e.role === "host" && e.event === "exit").length;
  return result;
}

/** Edge with no key of its own falls back to Chrome's registration. */
async function edgeFallback(setupResult) {
  for (const key of keys.filter((k) => k.includes("Microsoft\\Edge"))) unregister(key);
  register(browsers.chrome.key, setupResult.manifests.chromium);
  const b = await openChromium("edge", setupResult);
  try {
    const r = await b.run(send, { cmd: "ping" });
    return { ok: !!r.reply?.ok, error: r.error };
  } finally {
    await b.close();
  }
}

const setupResult = await setup();
// Job flags of a child of this driver, for the record. Node puts its children
// in its own kill-on-close job with silent breakaway, so the browser's children
// leave it. A shell job that forbids breakaway (terminals, agent sandboxes)
// would be inherited by the browser and its hosts: then run through wmi.ps1.
execFileSync(exe, ["baseline"], { input: "" });
const baseline = (await readLog()).find((e) => e.info?.args?.[0] === "baseline")?.info;
const results = {
  date: new Date().toISOString(),
  extension_id: setupResult.id,
  driver_child_job: {
    in_job: baseline?.in_job,
    breakaway_ok: baseline?.job_breakaway_ok,
    silent_breakaway: baseline?.job_silent_breakaway,
  },
  runs: [],
};
try {
  for (const name of selected) {
    if (!browsers[name].exe || !existsSync(browsers[name].exe)) {
      results.runs.push({ browser: name, skipped: "not installed" });
      continue;
    }
    console.log(`--- ${name}`);
    const r = await scenario(name, setupResult);
    console.log(JSON.stringify(r, null, 2));
    results.runs.push(r);
  }
  if (selected.includes("edge")) {
    results.edge_fallback_to_chrome_key = await edgeFallback(setupResult);
    console.log("edge via Chrome key:", results.edge_fallback_to_chrome_key);
  }
} finally {
  for (const key of keys) unregister(key);
  await stopApps().catch(() => {});
  await fs.writeFile(path.join(root, "results.json"), JSON.stringify(results, null, 2));
  console.log(`Results: ${path.join(root, "results.json")}`);
}
