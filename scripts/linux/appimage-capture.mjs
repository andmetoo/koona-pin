// The AppImage's capture with the app closed (NP-116), as a browser does it: the host the manifest
// names (copied out of the image) gets a capture, starts the app through the link to the AppImage file
// and the link is saved. Run by ci-appimage.sh in a fresh home, after a first start registered the host.
//   bun scripts/linux/appimage-capture.mjs <host>
import assert from "node:assert/strict";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { capture, hello, hostMessage } from "../lib/native-host.mjs";

const host = process.argv[2];
const manifest = JSON.parse(readFileSync(path.join(process.env.HOME, ".config/google-chrome/NativeMessagingHosts/app.koona.pin.json"), "utf8"));
assert.equal(manifest.path, host, "Chrome's manifest names the host copied out of the image");

const closed = await hostMessage(hello(), { host });
assert.equal(closed.reply.code, "app_unavailable", "hello keeps the closed app closed");
const saved = await hostMessage(capture("appimage-1", "https://example.invalid/koonapin-appimage", "AppImage"), { host });
assert.equal(saved.reply.ok, true, JSON.stringify(saved.reply));
assert.equal(saved.reply.outcome, "created");
console.log(`ok: capture with the app closed: the host started the AppImage and saved (${saved.ms} ms)`);

const db = new DatabaseSync(path.join(process.env.HOME, ".local/share/Koona/Pin/koonapin.db"));
db.exec("PRAGMA busy_timeout = 5000");
assert.deepEqual({ ...db.prepare("SELECT title, source FROM bookmarks WHERE url LIKE '%koonapin-appimage%'").get() }, { title: "AppImage", source: "chrome" });
db.close();
// Firefox passes the manifest's path and the add-on id.
const firefox = JSON.parse(readFileSync(path.join(process.env.HOME, ".mozilla/native-messaging-hosts/app.koona.pin.json"), "utf8"));
assert.equal(firefox.path, host, "Firefox's manifest names the same host");
const reply = await hostMessage(hello("firefox"), { host, args: [path.join(process.env.HOME, ".mozilla/native-messaging-hosts/app.koona.pin.json"), "pin@koona.app"] });
assert.equal(reply.reply.ok, true, JSON.stringify(reply.reply));
await sleep(200);
console.log("ok: Firefox's hello through the same host");

// The app the host started ends here: the image unpacked into /tmp, `koonapin --autostart` inside it.
for (const entry of readdirSync("/proc").filter((e) => /^\d+$/.test(e))) {
  try {
    const args = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
    if (path.basename(readlinkSync(`/proc/${entry}/exe`)) === "koonapin" && args.includes("--autostart")) process.kill(Number(entry), "SIGTERM");
  } catch {
    // Another user's process, or one that has just exited.
  }
}
