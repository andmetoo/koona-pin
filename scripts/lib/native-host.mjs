// Helpers for tests that talk to Netami Pin the way a browser does: through
// netamipin-host.exe and the capture pipe (Р-17, NP-016).
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

export const DEV_ORIGIN = "chrome-extension://iibgiagcbediajombmkohanobgicbepn/";

/** The test binary, as the native tests and smoke scripts pick it. */
export const appBinary = () =>
  path.resolve(process.env.NETAMIPIN_TEST_BINARY || "src-tauri/target/debug/netamipin.exe");

/** The host is built next to the app. */
export const hostBinary = (app = appBinary()) => path.join(path.dirname(app), "netamipin-host.exe");

/**
 * A pipe name of its own for each run (`NETAMIPIN_PIPE`): a running Netami Pin
 * keeps its pipe and the test app does not fight it.
 */
export const testPipe = (label = "test") => `netamipin-${label}-${process.pid}-${Date.now()}`;

/** The app answers on its pipe once the library is open. */
export const pipeReady = (name) =>
  new Promise((resolve) => {
    const socket = net.connect(`\\\\.\\pipe\\${name}`);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });

/**
 * One message through netamipin-host.exe, framed as the browser frames it.
 * `args` default to what Chrome passes; Firefox passes the manifest path and the add-on id.
 */
export function hostMessage(message, { env = process.env, host = hostBinary(), args = [DEV_ORIGIN, "--parent-window=0"] } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(host, args, { env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", () => {
      const out = Buffer.concat(chunks);
      if (out.length < 4) return reject(new Error("The host did not answer"));
      const length = out.readUInt32LE(0);
      resolve({ reply: JSON.parse(out.subarray(4, 4 + length).toString()), ms: Math.round(performance.now() - started) });
    });
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    child.stdin.end(Buffer.concat([header, body]));
  });
}

/** Apps the host started (`--autostart`) from the binary under test. */
export function hostStartedApps(binary = appBinary()) {
  const quoted = binary.replaceAll("'", "''");
  const out = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='netamipin.exe'" | Where-Object { $_.ExecutablePath -eq '${quoted}' -and $_.CommandLine -match '--autostart' } | Select-Object -ExpandProperty ProcessId`,
    ],
    { encoding: "utf8" },
  );
  return out.split(/\s+/).filter(Boolean).map(Number);
}

/**
 * One Netami Pin per Windows user (single instance): while another one runs,
 * an app the test starts hands over to it and exits, and the host waits for
 * nothing. Stop early with the reason instead.
 */
export function assertNoOtherApp() {
  const out = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='netamipin.exe'" | ForEach-Object { "$($_.ProcessId) $($_.ExecutablePath)" }`,
    ],
    { encoding: "utf8" },
  ).trim();
  if (out)
    throw new Error(
      `Quit Netami Pin before this check (tray menu → Exit): only one instance runs per user, so the test app would exit at once.\n${out}`,
    );
}

/**
 * Remembers the apps running now; `stop()` ends only those started since,
 * so an app the user runs from the same folder stays.
 */
export function startedSince() {
  const before = new Set(hostStartedApps());
  const ours = () => hostStartedApps().filter((pid) => !before.has(pid));
  return {
    ours,
    stop() {
      for (const pid of ours()) execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    },
  };
}

export const hello = (browser = "chrome", protocol = 2) => ({ type: "hello", protocol, version: "0.5.0", browser });
export const capture = (request_id, url, title, browser = "chrome") => ({
  type: "capture",
  protocol: 2,
  version: "0.5.0",
  browser,
  request_id,
  url,
  title,
});
