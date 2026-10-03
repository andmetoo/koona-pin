// Builds the browser extension for Chrome, Edge and Firefox from extension/src
// (NP-015). One command, three results:
//
//   extension/build/<browser>/        unpacked, for "Load unpacked" and tests
//   release/netamipin-chrome.zip      Chrome Web Store
//   release/netamipin-edge.zip        Edge Add-ons
//   release/netamipin-firefox.xpi     Firefox (unsigned until NP-018)
//
// The unpacked Chrome and Edge folders carry the development key
// (extension/dev-key.txt), so their extension id is the same on every machine:
// a native messaging registration can name it. Store packages are built
// without it: the store assigns its own id.
import { crc32, deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "extension", "src");
const { VERSION } = await import(pathToFileURL(path.join(source, "version.js")).href);

export const geckoId = "pin@netami.app";
export const browsers = ["chrome", "edge", "firefox"];

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
    permissions: ["activeTab", "storage", "alarms", "nativeMessaging"],
    action: { default_title: "__MSG_actionTitle__", default_icon: icons },
    icons,
    options_ui: { page: "options.html", open_in_tab: true },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'",
    },
  };
  if (browser === "firefox")
    return {
      ...common,
      // Firefox has no extension service workers: an event page instead.
      background: { scripts: ["worker.js"], type: "module" },
      browser_specific_settings: {
        gecko: {
          id: geckoId,
          strict_min_version: "140.0",
          // Links go only to the app on this computer.
          data_collection_permissions: { required: ["none"] },
        },
      },
    };
  return {
    ...common,
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
  for (const font of ["inter-latin-wght-normal.woff2", "inter-cyrillic-wght-normal.woff2"])
    files.push({ name: `fonts/${font}`, data: await readFile(path.join(fonts, font)) });
  const release = path.join(root, "release");
  await mkdir(release, { recursive: true });
  const result = { version: VERSION, devId: extensionId(key), unpacked: {}, packages: {} };
  for (const browser of browsers) {
    // Unpacked: the folder is emptied, not replaced, so a browser that loaded
    // it keeps the same path.
    const unpacked = path.join(root, "extension", "build", browser);
    await mkdir(unpacked, { recursive: true });
    for (const entry of await readdir(unpacked)) await rm(path.join(unpacked, entry), { recursive: true });
    for (const { name, data } of files) {
      await mkdir(path.dirname(path.join(unpacked, name)), { recursive: true });
      await writeFile(path.join(unpacked, name), data);
    }
    await writeFile(path.join(unpacked, "manifest.json"), json(manifest(browser, { dev: true, key })));
    result.unpacked[browser] = unpacked;

    const archive = path.join(release, `netamipin-${browser}.${browser === "firefox" ? "xpi" : "zip"}`);
    await writeFile(archive, zip([...files, { name: "manifest.json", data: json(manifest(browser)) }]));
    result.packages[browser] = archive;
  }
  log(`Netami Pin extension ${VERSION}, development id ${result.devId}`);
  for (const browser of browsers)
    log(`  ${browser}: ${path.relative(root, result.unpacked[browser])}, ${path.relative(root, result.packages[browser])}`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildExtension();
