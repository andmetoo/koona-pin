// Helpers for tests that talk to Koona Pin the way a browser does: through
// koonapin-host and the capture pipe — a Unix socket on Linux (Р-17, NP-016, NP-099).
import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { rename } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const DEV_ORIGIN = "chrome-extension://iibgiagcbediajombmkohanobgicbepn/";

const windows = process.platform === "win32";
const exe = windows ? ".exe" : "";

/** The test binary, as the native tests and smoke scripts pick it. */
export const appBinary = () =>
  path.resolve(process.env.KOONAPIN_TEST_BINARY || `src-tauri/target/debug/koonapin${exe}`);

/** The host is built next to the app. */
export const hostBinary = (app = appBinary()) => path.join(path.dirname(app), `koonapin-host${exe}`);

/**
 * A pipe name of its own for each run (`KOONAPIN_PIPE`): a running Koona Pin
 * keeps its pipe and the test app does not fight it.
 */
export const testPipe = (label = "test") => `koonapin-${label}-${process.pid}-${Date.now()}`;

/** The user's own folder of the system on macOS (`_CS_DARWIN_USER_DIR`), where the capture socket lives. */
const darwinUserDir = () => execFileSync("getconf", ["DARWIN_USER_DIR"], { encoding: "utf8" }).trim();

/** Where the app listens for `KOONAPIN_PIPE=name` (pipe_name.rs). */
export const pipePath = (name, env = process.env) =>
  windows
    ? `\\\\.\\pipe\\${name}`
    : path.join(process.platform === "darwin" ? darwinUserDir() : (env.XDG_RUNTIME_DIR ?? ""), "koonapin", `${name}.sock`);

/** The app answers on its pipe once the library is open. */
export const pipeReady = (name, env = process.env) =>
  new Promise((resolve) => {
    const socket = net.connect(pipePath(name, env));
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });

/**
 * One message through koonapin-host.exe, framed as the browser frames it.
 * `args` default to what Chrome passes; Firefox passes the manifest path and the add-on id.
 */
export function hostMessage(message, { env = process.env, host = hostBinary(), args = [DEV_ORIGIN, "--parent-window=0"] } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(host, args, { env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const chunks = [];
    // "close" waits for the host's stdout to close everywhere: an app that
    // inherited it would keep a browser waiting the same way (NP-014).
    const hung = setTimeout(
      () => reject(new Error("The host's stdout stayed open: a process it started holds the browser's pipe")),
      30_000,
    );
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(hung);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(hung);
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

/** The user's own processes on Linux: pid, executable and arguments from /proc. */
function linuxProcesses() {
  const processes = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      processes.push({
        pid: Number(entry),
        exe: readlinkSync(`/proc/${entry}/exe`),
        args: readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0"),
      });
    } catch {
      // Another user's process, or one that has just exited.
    }
  }
  return processes;
}

/** Apps the host started (`--autostart`) from the binary under test. */
export function hostStartedApps(binary = appBinary()) {
  if (process.platform === "darwin") {
    const real = realpathSync(binary);
    return execFileSync("ps", ["-axo", "pid=,args="], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim().match(/^(\d+) (.+)$/))
      .filter((m) => m && m[2].startsWith(real) && m[2].includes("--autostart"))
      .map((m) => Number(m[1]));
  }
  if (!windows) {
    const real = realpathSync(binary);
    return linuxProcesses()
      .filter((p) => p.exe === real && p.args.includes("--autostart"))
      .map((p) => p.pid);
  }
  const quoted = binary.replaceAll("'", "''");
  const out = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='koonapin.exe'" | Where-Object { $_.ExecutablePath -eq '${quoted}' -and $_.CommandLine -match '--autostart' } | Select-Object -ExpandProperty ProcessId`,
    ],
    { encoding: "utf8" },
  );
  return out.split(/\s+/).filter(Boolean).map(Number);
}

/**
 * One Koona Pin per Windows user (per session bus on Linux; single instance):
 * while another one runs, an app the test starts hands over to it and exits,
 * and the host waits for nothing. Stop early with the reason instead.
 */
export function assertNoOtherApp() {
  if (process.platform === "darwin") {
    // The app's executable: koonapin in a build, «Koona Pin» inside an installed .app.
    const others = execFileSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim().match(/^(\d+) (.+)$/))
      .filter((m) => m && ["koonapin", "Koona Pin"].includes(path.basename(m[2])));
    if (others.length)
      throw new Error(
        `Quit Koona Pin before this check (menu bar → Quit): only one instance runs per user, so the test app would exit at once.\n${others.map((m) => `${m[1]} ${m[2]}`).join("\n")}`,
      );
    return;
  }
  if (!windows) {
    const others = linuxProcesses().filter((p) => path.basename(p.exe) === "koonapin");
    if (others.length)
      throw new Error(
        `Quit Koona Pin before this check (tray menu → Exit): only one instance runs per session, so the test app would exit at once.\n${others.map((p) => `${p.pid} ${p.exe}`).join("\n")}`,
      );
    return;
  }
  const out = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='koonapin.exe'" | ForEach-Object { "$($_.ProcessId) $($_.ExecutablePath)" }`,
    ],
    { encoding: "utf8" },
  ).trim();
  if (out)
    throw new Error(
      `Quit Koona Pin before this check (tray menu → Exit): only one instance runs per user, so the test app would exit at once.\n${out}`,
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
      for (const pid of ours()) {
        if (windows) execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
        // WebKit's processes end with their app.
        else process.kill(pid, "SIGKILL");
      }
    },
  };
}

/**
 * Moves a library with its -wal and -shm to another name, aside or back. Windows lets go of a
 * killed app's files a moment after taskkill returns: a busy file is tried again for 10 s, and a
 * file that stays busy fails the run. Skipping it left the library whole, and the capture meant to
 * wait in the queue was saved. Only -wal and -shm may be missing.
 */
export async function moveLibrary(from, to) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        await rename(from + suffix, to + suffix);
        break;
      } catch (error) {
        if (error.code === "ENOENT" && suffix) break;
        if (!["EBUSY", "EPERM", "EACCES"].includes(error.code) || Date.now() > deadline) throw error;
        await sleep(100);
      }
    }
  }
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
