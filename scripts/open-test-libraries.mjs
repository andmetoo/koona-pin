// Opens every test library with the built app (NP-005) and reports what happened.
// Prepare: cargo run --example test_libraries --manifest-path src-tauri/Cargo.toml
// Run:     node scripts/open-test-libraries.mjs
import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { appBinary, pipeReady, testPipe } from "./lib/native-host.mjs";

const libraries = path.resolve(".test-data", "libraries");
const binary = appBinary();

function inspect(file) {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    const version = db.prepare("PRAGMA user_version").get().user_version;
    const id = db.prepare("PRAGMA application_id").get().application_id;
    const check = db.prepare("PRAGMA quick_check").get().quick_check;
    const count = db.prepare("SELECT count(*) AS n FROM bookmarks").get().n;
    db.close();
    return `схема ${version}, application_id 0x${(id >>> 0).toString(16)}, ${count} закладок, quick_check ${check}`;
  } catch (error) {
    return `не читается: ${error.message}`;
  }
}

async function open(name, env) {
  const app = spawn(binary, [], { env: { ...process.env, ...env }, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  app.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => app.once("exit", (code) => resolve(code)));
  const started = Date.now();
  let result = "нет ответа за 20 с";
  while (Date.now() - started < 20000) {
    if (app.exitCode !== null) {
      const reason = stderr.split("\n").find((line) => line.includes("panicked")) || stderr.trim().split("\n").pop();
      result = `завершилось с кодом ${app.exitCode}: ${reason?.trim() ?? ""}`;
      break;
    }
    // The capture pipe opens only once the library is open.
    if (await pipeReady(env.NETAMIPIN_PIPE)) {
      result = `открыто за ${Date.now() - started} мс`;
      break;
    }
    // The app reports a refused library on stderr and shows the error screen.
    const refused = stderr.split("\n").find((line) => line.includes("Cannot open the library"));
    if (refused) {
      result = `экран ошибки за ${Date.now() - started} мс: ${refused.trim()}`;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  app.kill();
  await exited;
  console.log(`${name.padEnd(30)} ${result}`);
}

const stamp = Date.now();
for (const name of (await readdir(libraries)).filter((file) => file.endsWith(".db"))) {
  const data = path.resolve(".test-data", `open-${stamp}`, name);
  await mkdir(data, { recursive: true });
  await copyFile(path.join(libraries, name), path.join(data, "netamipin.db"));
  await open(name, {
    NETAMIPIN_DATA_DIR: data,
    WEBVIEW2_USER_DATA_FOLDER: path.join(data, "webview"),
    NETAMIPIN_PIPE: testPipe("library"),
  });
  const moved = (await readdir(data)).filter((file) => file.startsWith("netamipin.old-"));
  console.log(`${"".padEnd(30)} после: ${inspect(path.join(data, "netamipin.db"))}${moved.length ? `; прежняя перенесена: ${moved.join(", ")}` : ""}`);
}
