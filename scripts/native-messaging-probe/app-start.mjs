// NP-014: how long a host would wait when it starts a closed Netami Pin.
// Starts the release build hidden (`--autostart`, as the host would) on an
// isolated library and measures the time until the library is open and the
// capture server answers. A test data folder keeps the autostart registry
// value untouched.
//
//   cargo build --release --features custom-protocol --locked --manifest-path src-tauri/Cargo.toml
//   node scripts/native-messaging-probe/app-start.mjs
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const binary = path.resolve(process.env.NETAMIPIN_TEST_BINARY || "src-tauri/target/release/netamipin.exe");
const root = path.resolve(".test-data", `app-start-${Date.now()}`);
const runs = 5;

async function ready() {
  try {
    const response = await fetch("http://127.0.0.1:28765/api/health", { signal: AbortSignal.timeout(200) });
    return response.ok;
  } catch {
    return false;
  }
}
async function once(dataDir) {
  const started = performance.now();
  const app = spawn(binary, ["--autostart"], {
    env: { ...process.env, NETAMIPIN_DATA_DIR: dataDir, WEBVIEW2_USER_DATA_FOLDER: path.join(dataDir, "webview") },
    stdio: "ignore",
  });
  try {
    while (!(await ready())) {
      if (performance.now() - started > 30000) throw new Error("not ready in 30 s");
      await sleep(10);
    }
    return performance.now() - started;
  } finally {
    execFileSync("taskkill", ["/F", "/T", "/PID", String(app.pid)], { stdio: "ignore" });
    while (await ready()) await sleep(50);
  }
}

if (await ready()) throw new Error("Port 28765 is busy: close Netami Pin first");
function report(label, times) {
  times.sort((a, b) => a - b);
  const ms = times.map(Math.round);
  console.log(`${label}: median ${ms[Math.floor(ms.length / 2)]} ms, max ${ms.at(-1)} ms (${ms.join(", ")})`);
}

// First start: a new folder each time, the library is created.
const created = [];
for (let i = 0; i < runs; i++) created.push(await once(path.join(root, `new-${i}`)));
report("new library", created);

// Later starts on an existing library. The 100 000 one comes from
// `cargo run --example test_libraries` and is migrated by the first start.
for (const [label, source] of [["empty library", null], ["100 000 bookmarks", "library-100k-v1.db"]]) {
  const dataDir = path.join(root, label.replace(/\W+/g, "-"));
  await mkdir(dataDir, { recursive: true });
  if (source) await copyFile(path.resolve(".test-data/libraries", source), path.join(dataDir, "netamipin.db"));
  await once(dataDir);
  const times = [];
  for (let i = 0; i < runs; i++) times.push(await once(dataDir));
  report(label, times);
}
