// Signs the packages of a release for the built-in updater and writes latest.json (NP-038, NP-102, Р-60):
//   bun run build:latest                 every package of this version: the Windows installer and the .deb and .rpm
//   bun run build:latest -- --only linux  only the Linux packages (a Linux-only release: Windows keeps the last one)
//   bun run build:latest -- --only windows
//   bun run build:latest -- --unsigned-windows  the installer without Certum, from release/test (test releases only)
// Takes the files of release/publish/windows/<version>/ (bun run build:installer -- --sign) and
// release/publish/linux/<version>/ (bun run build:linux), signs each with the update key bound to the
// version (`tauri signer sign --app-version`, the app checks it: `requireSignedVersion`), and copies
// it with its <file>.sig into release/publish/updates/<version>/, next to latest.json and
// SHA256SUMS.txt. The key comes from the environment or .env: TAURI_SIGNING_PRIVATE_KEY (or
// TAURI_SIGNING_PRIVATE_KEY_PATH); the password is typed into TAURI_SIGNING_PRIVATE_KEY_PASSWORD for
// the run and not kept in .env (NP-042).
//
// The site serves that folder (Р-60): the packages at https://koona.app/pin/downloads/<version>/,
// latest.json at https://koona.app/pin/updates/latest.json, where the app reads it
// (bun run site:build takes the newest version). The AUR package is not in it: pacman updates it (Р-55).
// `notes` are the changes of site/changelog/<version>.md, one per line: the update dialog lists
// them (NP-040); without that file there is no release.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { entry } from "../site/src/changelog.mjs";
import { SITE } from "../site/src/content.mjs";
import { publish, root, test } from "./lib/paths.mjs";

const dotenv = path.join(root, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
if (only && !["windows", "linux"].includes(only)) {
  console.error("--only takes windows or linux");
  process.exit(1);
}
const unsignedWindows = process.argv.includes("--unsigned-windows");
if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
  console.error("The update key is not set: TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH (NP-042, doc/release-checklist.md).");
  process.exit(1);
}

const conf = JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
let changes;
try {
  changes = entry(version).changes;
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
// The updater reads latest.json of the site (tauri.conf.json); the packages lie next to their version.
const download = (file) => `${SITE}/downloads/${version}/${encodeURIComponent(file)}`;

/** The packages of this version: [updater target keys, folder, file]. */
const packages = [];
const find = async (folder, test) => (existsSync(folder) ? (await readdir(folder)).filter(test) : []);
if (only !== "linux") {
  // A test release may go without Certum (SmartScreen warns on a fresh install); the update key
  // signs it all the same, and the updater checks only that one.
  const windows = unsignedWindows ? test.windows(version) : publish.windows(version);
  const [installer, ...more] = await find(windows, (f) => f.endsWith("-setup.exe") && f.includes(`_${version}_`));
  if (!installer || more.length) {
    const how = unsignedWindows ? "bun run build:installer" : "bun run build:installer -- --sign";
    console.error(`Expected one ${unsignedWindows ? "unsigned" : "signed"} installer of ${version} in ${path.relative(root, windows)}: ${how}`);
    process.exit(1);
  }
  if (unsignedWindows) console.warn(`The installer of ${version} has no Certum signature: a test release, not one for people.`);
  // The NSIS build looks for windows-x86_64-nsis; a build without a bundle type for windows-x86_64.
  packages.push([["windows-x86_64-nsis", "windows-x86_64"], windows, installer]);
}
if (only !== "windows") {
  const deb = (await find(publish.linux(version), (f) => f === `koonapin_${version}_amd64.deb`))[0];
  const rpm = (await find(publish.linux(version), (f) => f === `koonapin-${version}-1.x86_64.rpm`))[0];
  if (!deb || !rpm) {
    console.error(`Expected the .deb and the .rpm of ${version} in ${path.relative(root, publish.linux(version))}: bun run build:linux`);
    process.exit(1);
  }
  // No plain linux-x86_64: an app with an unknown bundle type must not get a package it cannot install.
  packages.push([["linux-x86_64-deb"], publish.linux(version), deb], [["linux-x86_64-rpm"], publish.linux(version), rpm]);
}

const out = path.join(publish.updates, version);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const tauri = path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const platforms = {};
const sums = [];
for (const [targets, folder, file] of packages) {
  const signed = spawnSync(process.execPath, [tauri, "signer", "sign", "--app-version", version, path.join(folder, file)], {
    cwd: root,
    stdio: ["inherit", "ignore", "inherit"],
  });
  if (signed.status !== 0) {
    console.error(`Signing ${file} failed (the key or its password).`);
    process.exit(signed.status ?? 1);
  }
  const signature = (await readFile(path.join(folder, `${file}.sig`), "utf8")).trim();
  for (const target of targets) platforms[target] = { url: download(file), signature };
  await copyFile(path.join(folder, file), path.join(out, file));
  await copyFile(path.join(folder, `${file}.sig`), path.join(out, `${file}.sig`));
  sums.push(`${createHash("sha256").update(await readFile(path.join(out, file))).digest("hex")}  ${file}`);
  console.log(`signed ${path.relative(root, path.join(folder, file))}`);
}

const latest = {
  version,
  notes: changes.map((c) => `- ${c}`).join("\n"),
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms,
};
await writeFile(path.join(out, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
await writeFile(path.join(out, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);
console.log(`\n${path.relative(root, path.join(out, "latest.json"))}: ${Object.keys(platforms).join(", ")}`);
// Entries of an earlier version cannot be carried over: each signature is bound to its version. The
// other system finds no entry and stays up to date until a release has its package.
if (only) console.log(`Only ${only}: the other system sees no update in this release.`);
