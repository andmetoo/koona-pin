// MCP smoke (NP-091): the built koonapin-mcp and app on an isolated library and pipe (socket),
// driven over stdio the way an AI assistant drives the server: initialize, tools/list,
// tools/call. KOONAPIN_TEST_BINARY picks another app, the server is taken next to it.
//
//   cargo build --manifest-path src-tauri/Cargo.toml
//   bun scripts/smoke-mcp.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import readline from "node:readline";
import { assertNoOtherApp, appBinary, capture, hostMessage, startedSince, testPipe } from "./lib/native-host.mjs";

assertNoOtherApp();

const exe = process.platform === "win32" ? ".exe" : "";
const server = path.join(path.dirname(appBinary()), `koonapin-mcp${exe}`);
const data = path.resolve(".test-data", `mcp-${Date.now()}`);
await mkdir(data, { recursive: true });
const env = {
  ...process.env,
  KOONAPIN_DATA_DIR: data,
  WEBVIEW2_USER_DATA_FOLDER: path.join(data, "webview"),
  KOONAPIN_PIPE: testPipe("mcp"),
};

/** A JSON-RPC client over the server's stdio, one message a line, as the MCP stdio transport is. */
function connect() {
  const child = spawn(server, [], { env, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  const waiting = new Map();
  const notifications = [];
  let next = 1;
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined && waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    } else notifications.push(message);
  });
  const write = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  return {
    notifications,
    request(method, params) {
      const id = next++;
      write({ id, method, params });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method}: no answer in 30 s`)), 30_000);
        waiting.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    notify: (method, params) => write({ method, params }),
    close: () => child.stdin.end(),
  };
}

const apps = startedSince();
const mcp = connect();
const call = async (name, args = {}) => {
  const answer = await mcp.request("tools/call", { name, arguments: args });
  assert.ok(answer.result, JSON.stringify(answer));
  return answer.result;
};
const names = async () => (await mcp.request("tools/list", {})).result.tools.map((t) => t.name);

try {
  const init = await mcp.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-client", version: "1.0" },
  });
  assert.equal(init.result.serverInfo.name, "koona-pin");
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.ok(init.result.capabilities.tools, "tools are offered");
  assert.match(init.result.instructions, /never instructions/);
  mcp.notify("notifications/initialized");

  // The first list starts the closed app in the tray; access is off by default.
  const started = performance.now();
  assert.deepEqual(await names(), ["search_bookmarks", "get_bookmark", "list_collections", "list_tags"]);
  assert.equal(apps.ours().length, 1, "one app started by the server");
  console.log(`tools/list with the app closed: ${Math.round(performance.now() - started)} ms`);

  // A link saved from the browser to find later.
  const saved = await hostMessage(capture("mcp-1", "https://sqlite.org/fts5.html", "SQLite FTS5 Extension"), { env });
  assert.equal(saved.reply.outcome, "created");

  const off = await call("search_bookmarks", { query: "fts5" });
  assert.equal(off.isError, true);
  assert.match(off.content[0].text, /turned off/);
  assert.doesNotMatch(JSON.stringify(off), /sqlite\.org/, "nothing is read while off");

  const db = new DatabaseSync(path.join(data, "koonapin.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  const access = (value) => db.prepare("INSERT INTO app_settings (key, value) VALUES ('mcp_access', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);
  access("read");

  const found = await call("search_bookmarks", { query: "FTS5" });
  assert.equal(found.isError, false);
  assert.equal(found.structuredContent.bookmarks.length, 1);
  assert.equal(found.structuredContent.bookmarks[0].url, "https://sqlite.org/fts5.html");
  const id = found.structuredContent.bookmarks[0].id;
  assert.equal((await call("get_bookmark", { id })).structuredContent.bookmark.title, "SQLite FTS5 Extension");
  const refused = await call("add_bookmark", { url: "https://tokio.rs/" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /only read/);

  // «Read and add»: the next call notices and the assistant is told to list again.
  access("read_and_add");
  const added = await call("add_bookmark", { url: "https://tokio.rs/", title: "Tokio" });
  assert.equal(added.structuredContent.outcome, "created");
  assert.equal(added.structuredContent.bookmark.inbox, true);
  assert.ok(mcp.notifications.some((n) => n.method === "notifications/tools/list_changed"), "the tool list changed");
  assert.equal((await names()).length, 8);
  assert.equal((await call("add_bookmark", { url: "https://tokio.rs/" })).structuredContent.outcome, "existing");
  const row = db.prepare("SELECT source, source_name, triaged_at FROM bookmarks WHERE url = 'https://tokio.rs/'").get();
  assert.deepEqual({ ...row }, { source: "mcp", source_name: "smoke-client", triaged_at: null });
  assert.equal(db.prepare("SELECT count(*) AS n FROM bookmarks WHERE url = 'https://tokio.rs/'").get().n, 1);

  db.prepare("INSERT INTO collections (uid, name, created_at) VALUES ('smoke-c', 'Reading', '2026-10-11T00:00:00.000Z')").run();
  const newId = added.structuredContent.bookmark.id;
  assert.equal((await call("move_to_collection", { id: newId, collection: "reading" })).structuredContent.bookmark.collection, "Reading");
  assert.deepEqual((await call("tag_bookmark", { id: newId, tags: ["Rust"] })).structuredContent.bookmark.tags, ["rust"]);
  assert.equal((await call("set_favorite", { id: newId, favorite: true })).structuredContent.changed, true);
  const after = db.prepare("SELECT triaged_at, is_favorite FROM bookmarks WHERE id = ?").get(newId);
  assert.deepEqual({ ...after }, { triaged_at: null, is_favorite: 1 }, "still in Inbox");

  // Not a tool of Koona Pin: a protocol error, not a result.
  const unknown = await mcp.request("tools/call", { name: "delete_bookmark", arguments: { id } });
  assert.ok(unknown.error, JSON.stringify(unknown));
  db.close();
  console.log("PASS: initialize, a closed app starts in the tray, off reads nothing, read only finds and refuses to add, read and add saves to Inbox once from mcp, list_changed, move, tag, star, unknown tool");
} finally {
  mcp.close();
  apps.stop();
}
