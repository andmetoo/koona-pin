// Signs the packages of a release for the built-in updater and writes latest.json (NP-038, NP-102, Р-60):
//   npm run build:latest                 every package of this version: the Windows installer and the .deb and .rpm
//   npm run build:latest -- --only linux  only the Linux packages (a Linux-only release: Windows keeps the last one)
//   npm run build:latest -- --only windows
// Takes the files of release/publish/windows/<version>/ (npm run build:installer -- --sign) and
// release/publish/linux/<version>/ (npm run build:linux), signs each with the update key bound to the
// version (`tauri signer sign --app-version`, the app checks it: `requireSignedVersion`), and writes
// <file>.sig next to it and release/publish/updates/<version>/latest.json. The key comes from the
// environment or .env: TAURI_SIGNING_PRIVATE_KEY (or TAURI_SIGNING_PRIVATE_KEY_PATH); the password is
// typed into TAURI_SIGNING_PRIVATE_KEY_PASSWORD for the run and not kept in .env (NP-042).
//
// latest.json goes to the release as an asset next to the packages: the app reads
// https://github.com/andmetoo/koona-pin/releases/latest/download/latest.json. The AUR package is not
// in it: pacman updates it (Р-55).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { publish, release, root } from "./lib/paths.mjs";

const dotenv = path.join(root, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
if (only && !["windows", "linux"].includes(only)) {
  console.error("--only takes windows or linux");
  process.exit(1);
}
if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
  console.error("The update key is not set: TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH (NP-042, doc/release-checklist.md).");
  process.exit(1);
}

const conf = JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
// GitHub turns spaces of an uploaded asset's name into dots: «Koona Pin_0.3.0_x64-setup.exe» is
// served as «Koona.Pin_0.3.0_x64-setup.exe».
const asset = (file) => file.replaceAll(" ", ".");
const download = (file) => `https://github.com/andmetoo/koona-pin/releases/download/v${version}/${encodeURIComponent(asset(file))}`;

/** The packages of this version: [updater target keys, folder, file]. */
const packages = [];
const find = async (folder, test) => (existsSync(folder) ? (await readdir(folder)).filter(test) : []);
if (only !== "linux") {
  const [installer, ...more] = await find(publish.windows(version), (f) => f.endsWith("-setup.exe") && f.includes(`_${version}_`));
  if (!installer || more.length) {
    console.error(`Expected one signed installer of ${version} in ${path.relative(root, publish.windows(version))}: npm run build:installer -- --sign`);
    process.exit(1);
  }
  // The NSIS build looks for windows-x86_64-nsis; a build without a bundle type for windows-x86_64.
  packages.push([["windows-x86_64-nsis", "windows-x86_64"], publish.windows(version), installer]);
}
if (only !== "windows") {
  const deb = (await find(publish.linux(version), (f) => f === `koonapin_${version}_amd64.deb`))[0];
  const rpm = (await find(publish.linux(version), (f) => f === `koonapin-${version}-1.x86_64.rpm`))[0];
  if (!deb || !rpm) {
    console.error(`Expected the .deb and the .rpm of ${version} in ${path.relative(root, publish.linux(version))}: npm run build:linux`);
    process.exit(1);
  }
  // No plain linux-x86_64: an app with an unknown bundle type must not get a package it cannot install.
  packages.push([["linux-x86_64-deb"], publish.linux(version), deb], [["linux-x86_64-rpm"], publish.linux(version), rpm]);
}

const tauri = path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const platforms = {};
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
  console.log(`signed ${path.relative(root, path.join(folder, file))}`);
}

const latest = {
  version,
  notes: `https://github.com/andmetoo/koona-pin/releases/tag/v${version}`,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms,
};
const out = path.join(release, "publish", "updates", version);
await mkdir(out, { recursive: true });
await writeFile(path.join(out, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
console.log(`\n${path.relative(root, path.join(out, "latest.json"))}: ${Object.keys(platforms).join(", ")}`);
// Entries of an earlier version cannot be carried over: each signature is bound to its version. The
// other system finds no entry and stays up to date until a release has its package.
if (only) console.log(`Only ${only}: the other system sees no update in this release.`);
