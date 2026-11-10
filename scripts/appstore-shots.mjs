// Fills Koona Pin in the iOS Simulator with the sample library of the site's shots, for the App Store
// screenshots (src-tauri/store/appstore/README.md), as doc/play/shots.mjs does on an Android emulator.
// The screens are reached by hand afterwards (the Simulator, or `xcrun simctl io` taps from a tool):
// the app has no deep links, and WKWebView has no DevTools a script could drive.
//
//   bun scripts/appstore-shots.mjs                    restore the sample library, its pictures and the feeds
//   bun scripts/appstore-shots.mjs --demo             only the status bar (9:41, full battery and signal)
//   bun scripts/appstore-shots.mjs --shoot <file.png> a screenshot of the screen as it is now
//   … --device <name or UDID>                          another Simulator (default: "iPhone 17 Pro Max")
//   … --app <Koona Pin.app>                            install this build first (`bun run build:ios:sim`)
//
// The device is an iPhone 17 Pro Max (6.9-inch, 1320 × 2868), made with `xcrun simctl create` when
// missing and booted. What it writes, with the app stopped (`xcrun simctl terminate`):
// - the library: the sample copy (copyOf of scripts/lib/shots.mjs) through the app's own restore, and
//   the feeds of scripts/shots/feeds.json, by the example src-tauri/examples/shots_library.rs on the
//   app's data container (`xcrun simctl get_app_container … data`): the library is in Tauri's app
//   data folder, Library/Application Support/app.koona.pin;
// - the previews: straight into the picture cache (thumbs.rs: thumbs/<aa>/<sha256>.jpg in the app's
//   cache folder, Library/Caches/app.koona.pin), under the addresses the restored library names, so
//   the made-up sites of the sample are never asked.
// The Supporter sheet's prices come from src-tauri/gen/apple/Supporter.storekit, which only a Debug Run
// from Xcode gives (the scheme): after filling, `bun run tauri ios dev --open --features store-appstore`
// and Run the scheme koonapin_iOS on this device (the data container stays); cancel the purchase sheet.
// Then `git checkout -- src-tauri/gen/apple`: the dev build writes its versions into the Info.plists.
// Needs oxipng for --shoot (`brew install oxipng`) and cargo for the fill.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { root } from "./lib/paths.mjs";
import { copyOf, feedsSql, library, previews, shotsDir, until } from "./lib/shots.mjs";

if (process.platform !== "darwin") throw new Error("appstore-shots.mjs drives the iOS Simulator: run it on a Mac with Xcode");

const BUNDLE = "app.koona.pin";
const MODEL = "iPhone 17 Pro Max";
const MODEL_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max";
// Not fetched: the pictures are in the cache before the library names them (as doc/play/shots.mjs).
const BASE = "https://koona.app/pin/shots";
const work = path.join(root, ".test-data", "appstore-shots");

const { values: args } = parseArgs({
  strict: true,
  options: {
    demo: { type: "boolean", default: false },
    shoot: { type: "string" },
    device: { type: "string", default: MODEL },
    app: { type: "string" },
  },
});

const simctl = (...a) => execFileSync("xcrun", ["simctl", ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** The Simulator to use, booted: by name or UDID; the model is made on the newest iOS when missing. */
function device(wanted) {
  const all = Object.entries(JSON.parse(simctl("list", "devices", "available", "-j")).devices)
    .filter(([runtime]) => runtime.includes(".iOS-"))
    .flatMap(([runtime, list]) => list.map((d) => ({ ...d, runtime })));
  let found = all.find((d) => d.udid === wanted) ?? all.filter((d) => d.name === wanted).sort((a, b) => (a.state === "Booted" ? -1 : b.state === "Booted" ? 1 : 0))[0];
  if (!found) {
    if (wanted !== MODEL) throw new Error(`No Simulator named ${wanted}: xcrun simctl list devices`);
    // The newest runtime that has the model: not every one lists every device type.
    const runtimes = JSON.parse(simctl("list", "runtimes", "-j")).runtimes.filter(
      (r) => r.isAvailable && r.platform === "iOS" && r.supportedDeviceTypes?.some((t) => t.identifier === MODEL_TYPE),
    );
    const runtime = runtimes.sort((a, b) => a.version.localeCompare(b.version, "en", { numeric: true })).at(-1);
    if (!runtime) throw new Error(`No iOS Simulator runtime with the ${MODEL}: install one in Xcode`);
    const udid = simctl("create", MODEL, MODEL_TYPE, runtime.identifier).trim();
    console.log(`Made ${MODEL} (iOS ${runtime.version}): ${udid}`);
    found = { udid, name: MODEL, state: "Shutdown" };
  }
  if (found.state !== "Booted") simctl("boot", found.udid);
  simctl("bootstatus", found.udid, "-b");
  english(found.udid);
  return found.udid;
}

/**
 * English (U.S.) only, as the listing: a new Simulator takes the Mac's region and languages, and a
 * region with a 24-hour clock shows 09:41. A change takes a restart of the device.
 */
function english(udid) {
  const read = (key) => {
    try {
      return simctl("spawn", udid, "defaults", "read", "-g", key).replace(/\s+/g, "");
    } catch {
      return "";
    }
  };
  if (read("AppleLocale") === "en_US" && read("AppleLanguages") === '("en-US")') return;
  simctl("spawn", udid, "defaults", "write", "-g", "AppleLocale", "en_US");
  simctl("spawn", udid, "defaults", "write", "-g", "AppleLanguages", "-array", "en-US");
  simctl("shutdown", udid);
  simctl("boot", udid);
  simctl("bootstatus", udid, "-b");
}

/**
 * The status bar of the shots: 9:41, a full battery (not charging: a charged one still shows the
 * bolt), full Wi-Fi and cellular bars, no carrier.
 */
function demoMode(udid) {
  simctl(
    "status_bar", udid, "override", "--time", "9:41", "--dataNetwork", "wifi", "--wifiMode", "active", "--wifiBars", "3",
    "--cellularMode", "active", "--cellularBars", "4", "--operatorName", "", "--batteryState", "discharging", "--batteryLevel", "100",
  );
}

/** The app's folders in its data container: the library's (Tauri's app data) and the picture cache. */
function folders(udid) {
  const container = simctl("get_app_container", udid, BUNDLE, "data").trim();
  return {
    data: path.join(container, "Library", "Application Support", BUNDLE),
    thumbs: path.join(container, "Library", "Caches", BUNDLE, "thumbs"),
  };
}

/** The app stopped; `terminate` fails when it is not running, which is as good. */
function stop(udid) {
  try {
    simctl("terminate", udid, BUNDLE);
  } catch {}
}

/** The sample's previews in the picture cache, under the addresses the restored library names. */
async function pictures(thumbs) {
  for (const b of library.bookmarks) {
    const key = createHash("sha256").update(`${BASE}/${b.preview}`).digest("hex");
    await mkdir(path.join(thumbs, key.slice(0, 2)), { recursive: true });
    await copyFile(path.join(previews, b.preview), path.join(thumbs, key.slice(0, 2), `${key}.jpg`));
  }
}

/** The library and the feeds, written by the app's own code (examples/shots_library.rs) with the app stopped. */
async function fill(data) {
  const now = Date.now();
  const sample = JSON.parse(await readFile(path.join(shotsDir, "feeds.json"), "utf8"));
  // Without the feed whose made-up name carries another company's brand: no third-party names on
  // the store's pictures.
  const left = sample.feeds.filter((f) => f.uid !== "shots-feed-circuit");
  const feeds = { feeds: left, posts: sample.posts.filter((p) => left.some((f) => f.uid === p.feed)) };
  const sql = await feedsSql(feeds, { now });
  const files = { copy: path.join(work, "library.json"), library: path.join(work, "library.sql"), cache: path.join(work, "feeds.sql") };
  await writeFile(files.copy, JSON.stringify(copyOf(BASE, now)));
  // One collection inside another, for the nested chips, as on Play: Inspiration inside Design.
  await writeFile(files.library, `${sql.library}\nUPDATE collections SET parent_id = (SELECT id FROM collections WHERE uid = 'site-collection-0') WHERE uid = 'site-collection-2';\n`);
  await writeFile(files.cache, sql.cache);
  // A fresh library and feed cache each time (the example makes both through the app's migrations):
  // nothing of an earlier fill or of a session by hand stays.
  for (const name of ["koonapin.db", "feeds.db"]) for (const suffix of ["", "-wal", "-shm"]) await rm(path.join(data, name + suffix), { force: true });
  execFileSync(
    "cargo",
    ["run", "--quiet", "--example", "shots_library", "--manifest-path", path.join(root, "src-tauri", "Cargo.toml"), "--", data, files.copy, files.library, files.cache],
    { cwd: root, stdio: "inherit" },
  );
  return feeds;
}

const udid = device(args.device);
if (args.demo) {
  demoMode(udid);
  process.exit(0);
}
if (args.shoot) {
  // The framebuffer without the screen's rounded mask: a full rectangle, as App Store Connect wants.
  await mkdir(path.dirname(path.resolve(args.shoot)), { recursive: true });
  const file = path.resolve(args.shoot);
  simctl("io", udid, "screenshot", "--type=png", "--mask=ignored", file);
  // simctl writes RGBA though every pixel is opaque; App Store Connect refuses alpha. oxipng
  // (`brew install oxipng`) drops the channel without changing a pixel.
  execFileSync("oxipng", ["-q", "-o", "2", "--strip", "safe", file]);
  const info = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", file], { encoding: "utf8" });
  console.log(info.trim());
  if (/hasAlpha: yes/.test(info)) throw new Error(`${args.shoot} still has alpha: a pixel is not opaque`);
  process.exit(0);
}

if (args.app) simctl("install", udid, path.resolve(args.app));
await mkdir(work, { recursive: true });
demoMode(udid);
// Started once, the app has made its folders and its library; then it is stopped for the writes.
simctl("launch", udid, BUNDLE);
const { data, thumbs } = folders(udid);
await until(async () => existsSync(path.join(data, "koonapin.db")), "the app's library (is the app installed?)", 60000);
await new Promise((r) => setTimeout(r, 2000));
stop(udid);
const feeds = await fill(data);
await pictures(thumbs);
simctl("launch", udid, BUNDLE);
console.log(`Filled: ${library.bookmarks.length} bookmarks, ${feeds.feeds.length} feeds, ${feeds.posts.length} posts (${data}, ${thumbs})`);
