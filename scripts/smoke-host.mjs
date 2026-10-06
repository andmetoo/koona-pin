// Native messaging smoke (NP-016): the built koonapin-host.exe and app on an
// isolated library and pipe, driven the way a browser drives the host.
//
//   cargo build --manifest-path src-tauri/Cargo.toml
//   node scripts/smoke-host.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { assertNoOtherApp, capture, hello, hostMessage, pipeReady, startedSince, testPipe } from "./lib/native-host.mjs";

assertNoOtherApp();

const data = path.resolve(".test-data", `host-${Date.now()}`);
await mkdir(data, { recursive: true });
const pipe = testPipe("smoke");
const env = {
  ...process.env,
  KOONAPIN_DATA_DIR: data,
  WEBVIEW2_USER_DATA_FOLDER: path.join(data, "webview"),
  KOONAPIN_PIPE: pipe,
};
const send = (message, options) => hostMessage(message, { env, ...options });

const apps = startedSince();

try {
  // A hello does not start an app the user closed.
  const closed = await send(hello());
  assert.equal(closed.reply.code, "app_unavailable");
  await sleep(500);
  assert.equal(await pipeReady(pipe), false, "hello must not start the app");

  // A capture starts it hidden, in the tray, and saves.
  const first = capture("smoke-1", "https://example.invalid/koonapin-smoke", "Smoke");
  const saved = await send(first);
  assert.equal(saved.reply.ok, true, JSON.stringify(saved.reply));
  assert.equal(saved.reply.outcome, "created");
  assert.equal(apps.ours().length, 1, "one app started by the host");
  console.log(`capture with the app closed: ${saved.ms} ms`);

  // The receipt: the same request again changes nothing.
  assert.deepEqual((await send(first)).reply, saved.reply);
  // The same address with a new request: existing, the title stays.
  const duplicate = await send(capture("smoke-2", first.url, "Should not overwrite"));
  assert.equal(duplicate.reply.outcome, "existing");
  assert.equal((await send(capture("smoke-3", "chrome://settings", "x"))).reply.code, "invalid_request");
  assert.equal((await send(capture("smoke-1", "https://other.invalid/", "x"))).reply.code, "request_id_conflict");

  const db = new DatabaseSync(path.join(data, "koonapin.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  assert.deepEqual({ ...db.prepare("SELECT title, source FROM bookmarks").get() }, { title: "Smoke", source: "chrome" });
  // A replay after deletion does not bring the bookmark back.
  db.exec("DELETE FROM bookmarks");
  assert.deepEqual((await send(first)).reply, saved.reply);
  assert.equal(db.prepare("SELECT count(*) AS n FROM bookmarks").get().n, 0);

  // Firefox passes the manifest path and the add-on id.
  const firefox = await send(hello("firefox"), { args: [path.join(data, "app.koona.pin.firefox.json"), "pin@koona.app"] });
  assert.equal(firefox.reply.ok, true);
  assert.equal(firefox.reply.name, "Koona Pin");
  // An extension of another protocol is refused, with the app's protocol and version.
  const old = await send(hello("edge", 1));
  assert.equal(old.reply.code, "incompatible_protocol");
  assert.equal(old.reply.protocol, 2);
  assert.ok(old.reply.version);

  const connections = JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key='capture_connections'").get().value);
  assert.deepEqual(Object.keys(connections.browsers).sort(), ["chrome", "edge", "firefox"]);
  assert.equal(connections.browsers.edge.protocol, 1);
  assert.equal(connections.last_capture.browser, "chrome");
  db.close();
  const running = await send(hello());
  console.log(`hello with the app running: ${running.ms} ms`);
  console.log(
    "PASS: hello keeps a closed app closed, capture starts it in the tray, receipts, duplicates, validation, conflict, replay after deletion, Firefox arguments, protocol check, browser records",
  );
} finally {
  apps.stop();
}
