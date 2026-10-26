// Builds the browser extension for Chrome, Edge, Firefox and Safari from
// extension/src (NP-015, NP-119). Results (folders: scripts/lib/paths.mjs):
//
//   release/dev/<browser>/                            unpacked, for «Load unpacked», Firefox's
//                                                     temporary add-on and tests
//   release/dev/safari/                               the web part of the Safari app extension:
//                                                     the Xcode build copies it in (local build only,
//                                                     no store package)
//   release/publish/chrome/<version>/koonapin-chrome.zip   Chrome Web Store
//   release/publish/edge/<version>/koonapin-edge.zip       Edge Add-ons
//   (Firefox: bun run extension:sign:firefox signs the unpacked folder on AMO.)
//
// The unpacked Chrome and Edge folders carry the development key
// (extension/dev-key.txt), so their extension id is the same on every machine:
// a native messaging registration can name it. Store packages are built
// without it: the store assigns its own id.
//
// With CHROME_STORE_PUBLIC_KEY (environment or .env; .env.example) there is one more:
// release/test/chrome-edge/<version>/koonapin-chrome-store-id.zip, the same extension with
// the Chrome Web Store's id, for testing the installer build before the store publishes it
// (NP-037). Not for upload: the store refuses a manifest with `key`.
import { crc32, deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dev, publish, root, test } from "./lib/paths.mjs";

const source = path.join(root, "extension", "src");
const { VERSION } = await import(pathToFileURL(path.join(source, "version.js")).href);

export const geckoId = "pin@koona.app";
/** The Chrome Web Store and Edge Add-ons ids (NP-017), as STORE_EXTENSION_IDS in native_host.rs. */
export const chromeStoreId = "dedcgklilbgbieabgpklellnaccpjhpc";
export const edgeStoreId = "ocdkndgdeagephdnlmofffbapdifhkho";
/** Self-hosted Firefox updates (NP-018); the file is published with the site. */
export const firefoxUpdateUrl = "https://koona.app/pin/firefox/updates.json";
export const firefoxDownloadBase = "https://koona.app/pin/firefox";
export const browsers = ["chrome", "edge", "firefox"];
/**
 * Built beside `browsers`, which the smoke tests and release scripts read as
 * the browsers they load and ship: Safari is a local build only (NP-119).
 */
export const localBrowsers = ["safari"];
/** Safari 18 ships with macOS 15, the oldest the Safari build supports (NP-119). */
export const safariMinVersion = "18.0";

const icons = { 16: "icons/16.png", 32: "icons/32.png", 48: "icons/48.png", 128: "icons/128.png" };

/** The manifest for one browser; `dev` adds the development key (Chromium). */
export function manifest(browser, { dev = false, key } = {}) {
  const common = {
    manifest_version: 3,
    name: "__MSG_extensionName__",
    description: "__MSG_extensionDescription__",
    version: VERSION,
    default_locale: "en",
    // Links go to the app only through its native messaging host (Р-17).
    // `scripting` with `activeTab`: the message after a click, on that tab only (NP-080, Р-39).
    permissions: ["activeTab", "scripting", "storage", "alarms", "nativeMessaging"],
    // «Show that a page is already saved» (NP-083): asked for only when the
    // person turns it on, so installing and updating show no warning.
    optional_permissions: ["tabs"],
    action: { default_title: "__MSG_actionTitle__", default_icon: icons },
    // Quick search (NP-082, Р-40). Ctrl+Shift+D is the browsers' own «bookmark all tabs».
    commands: {
      "quick-search": { suggested_key: { default: "Alt+Shift+D" }, description: "__MSG_commandSearch__" },
      // «Save to Reading» (NP-125); R as in the app. No browser has Alt+Shift+R.
      "save-to-reading": { suggested_key: { default: "Alt+Shift+R" }, description: "__MSG_commandReading__" },
    },
    icons,
    options_ui: { page: "options.html", open_in_tab: true },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'",
    },
  };
  if (browser === "firefox")
    return {
      ...common,
      // The toolbar button's right-click item to the settings page (Chrome
      // and Edge have «Options» there already).
      permissions: [...common.permissions, "menus"],
      // Firefox has no extension service workers: an event page instead.
      background: { scripts: ["worker.js"], type: "module" },
      browser_specific_settings: {
        gecko: {
          id: geckoId,
          strict_min_version: "140.0",
          // Links go only to the app on this computer.
          data_collection_permissions: { required: ["none"] },
          // The signed XPI has no AMO listing: Firefox looks for updates here
          // (NP-018). It must ship in the first signed version; added later it
          // reaches nobody without a manual reinstall.
          update_url: firefoxUpdateUrl,
        },
      },
    };
  if (browser === "safari")
    return {
      ...common,
      // The button's menu, with the settings item as in Firefox (worker.js);
      // Safari names it `menus` and keeps `contextMenus` as an alias.
      // unlimitedStorage: WebKit then skips its quota check, which refused
      // writes of a few hundred bytes with «Exceeded storage quota» (#315).
      permissions: [...common.permissions, "menus", "unlimitedStorage"],
      // In Manifest V3 Safari runs a background page as non-persistent, and it
      // has run `scripts` since Safari 14; its service worker was reported
      // killed for good on iOS 17 (developer.apple.com/forums/thread/758346).
      // worker.js already runs as Firefox's event page: one tested path (NP-119).
      background: { scripts: ["worker.js"], type: "module", persistent: false },
      browser_specific_settings: { safari: { strict_min_version: safariMinVersion } },
    };
  return {
    ...common,
    // «Find a link» in the button's menu (NP-082); Firefox has it as `menus`.
    permissions: [...common.permissions, "contextMenus"],
    ...(dev && key ? { key } : {}),
    minimum_chrome_version: "120",
    background: { service_worker: "worker.js", type: "module" },
  };
}

/** Chromium's extension id for a public key: SHA-256, first 16 bytes as a–p. */
export function extensionId(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex");
  return [...digest.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

async function sourceFiles(directory = source) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    // Tests stay in the repository.
    else if (!entry.name.includes(".test.")) files.push(full);
  }
  return files;
}

/** A ZIP with fixed timestamps and sorted names: the same input gives the same bytes. */
function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(0, 10); // 00:00
    header.writeUInt16LE(0x21, 12); // 1980-01-01
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4); // version made by
    header.copy(record, 6, 4, 30); // the same fields as the local header
    record.writeUInt16LE(0, 32); // comment
    record.writeUInt16LE(0, 34); // disk
    record.writeUInt16LE(0, 36); // internal attributes
    record.writeUInt32LE(0, 38); // external attributes
    record.writeUInt32LE(offset, 42);
    local.push(header, nameBytes, compressed);
    central.push(record, nameBytes);
    offset += header.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");

export async function buildExtension({ log = console.log } = {}) {
  const key = (await readFile(path.join(root, "extension", "dev-key.txt"), "utf8")).trim();
  const files = await Promise.all(
    (await sourceFiles()).map(async (file) => ({
      name: path.relative(source, file).split(path.sep).join("/"),
      data: await readFile(file),
    })),
  );
  // Inter, as in the app (SIL OFL 1.1): the options page needs no network.
  const fonts = path.join(root, "node_modules", "@fontsource-variable", "inter", "files");
  // latin-ext: Polish, Turkish and Serbian Latin letters (NP-089).
  for (const font of ["inter-latin-wght-normal.woff2", "inter-latin-ext-wght-normal.woff2", "inter-cyrillic-wght-normal.woff2"])
    files.push({ name: `fonts/${font}`, data: await readFile(path.join(fonts, font)) });
  // The button draws its frames from the micro mark, the page message shows the
  // mascot (NP-080): one source with the app's icons, design/brand.
  const brand = path.join(root, "design", "brand", "pin-spirit-flat");
  files.push({ name: "mark.svg", data: await readFile(path.join(brand, "pin-spirit-micro.svg")) });
  files.push({ name: "mascot.svg", data: await readFile(path.join(brand, "pin-spirit.svg")) });
  const result = { version: VERSION, devId: extensionId(key), unpacked: {}, packages: {} };
  const write = async (file, data) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  };
  for (const browser of [...browsers, ...localBrowsers]) {
    // Unpacked: the folder is emptied, not replaced, so a browser that loaded
    // it keeps the same path.
    const unpacked = dev.extension(browser);
    await mkdir(unpacked, { recursive: true });
    for (const entry of await readdir(unpacked)) await rm(path.join(unpacked, entry), { recursive: true });
    for (const { name, data } of files) await write(path.join(unpacked, name), data);
    await writeFile(path.join(unpacked, "manifest.json"), json(manifest(browser, { dev: true, key })));
    result.unpacked[browser] = unpacked;
  }
  for (const browser of ["chrome", "edge"]) {
    const archive = path.join(publish[browser](VERSION), `koonapin-${browser}.zip`);
    await write(archive, zip([...files, { name: "manifest.json", data: json(manifest(browser)) }]));
    result.packages[browser] = archive;
  }
  const shown = (file) => path.relative(root, file);
  log(`Koona Pin extension ${VERSION}, development id ${result.devId}`);
  for (const browser of [...browsers, ...localBrowsers]) log(`  ${browser}, unpacked: ${shown(result.unpacked[browser])}`);
  for (const browser of ["chrome", "edge"]) log(`  ${browser}, for the store: ${shown(result.packages[browser])}`);

  // The draft's public key (dashboard → Package → View public key): public, not a secret.
  const storeKey = process.env.CHROME_STORE_PUBLIC_KEY?.replace(/\s+/g, "");
  if (storeKey) {
    const id = extensionId(storeKey);
    if (id !== chromeStoreId)
      throw new Error(`CHROME_STORE_PUBLIC_KEY gives the id ${id}, not the Chrome Web Store's ${chromeStoreId}: copy the key of the Koona Pin item`);
    const archive = path.join(test.chromeEdge(VERSION), "koonapin-chrome-store-id.zip");
    await write(archive, zip([...files, { name: "manifest.json", data: json(manifest("chrome", { dev: true, key: storeKey })) }]));
    result.storeId = { id, archive };
    log(`  chrome and edge with the store id ${id}, for a test machine only: ${shown(archive)}`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dotenv = path.join(root, ".env");
  if (existsSync(dotenv)) process.loadEnvFile(dotenv);
  await buildExtension();
}
