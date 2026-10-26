// Writes release.json, what koona.app/pin shows of a release (its pages read it at request time through
// Caddy templates: the version, the packages to download, the changelog), and signs it with the update key:
//   bun scripts/build-release-data.mjs                     this checkout's version, signed
//   bun scripts/build-release-data.mjs --no-sign           unsigned: tests, a look at the output
//   bun scripts/build-release-data.mjs --version 0.12.0 --updates <dir> --changelog <dir> --macos <dir>
// Takes release/publish/updates/<version>/ as build-latest.mjs leaves it (the packages with their .sig,
// latest.json, SHA256SUMS.txt) and changelog/, and writes release.json and release.json.sig into the same
// folder. The macOS disk image, when release/publish/macos/<version>/arm64/ (--macos) has
// koonapin-<version>-macos-arm64.dmg, is copied into that folder and signed there with the update key,
// bound to the version like the packages: latest.json does not name the DMG (the Mac's updater takes the
// .app.tar.gz), but koona-deploy wants a .sig of every file release.json lists. SHA256SUMS.txt (build-latest.mjs) does
// not list the DMG either; release.json carries its sha256, and the release has SHA256SUMS-macos.txt. release.yml's finalize runs it after build:latest, uploads both to the release and deploys the
// folder to koona.app (unit «app» of koona-deploy, andmetoo/koona-site), which checks the same things
// again against the update key's public half before it serves anything.
//
// release.json, schema 1 (the site's templates read exactly these fields; a change is a new schema):
//   { "schema": 1, "version", "date" (YYYY-MM-DD), "published" (ISO, latest.json's pub_date),
//     "files": { windows?, deb?, rpm?, appimage?, macosUpdate?, macos?, sums: { "name", "size", "sha256" } },
//     "changelog": [ { "version", "date", "changes": [...] } ]  every version up to this one, newest first }
// A file's address is /pin/downloads/<version>/<name>. `windows` is absent from a Linux-only release,
// `macos` (koonapin-<version>-macos-arm64.dmg) from a release without the DMG. `macosUpdate`
// (koonapin-<version>-macos-arm64.app.tar.gz, NP-051) is the Mac's package of latest.json: the site's pages
// do not show it, but it is in release.json so that koona-deploy serves it next to the others.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { entries, folder as changelogFolder } from "./lib/changelog.mjs";
import { publish, root, shown } from "./lib/paths.mjs";
import { hasUpdateKey, signFile } from "./lib/sign.mjs";
import { SITE } from "./lib/site.mjs";

const dotenv = path.join(root, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const sign = !process.argv.includes("--no-sign");
const updates = path.resolve(arg("--updates") ?? publish.updates);
const changelog = path.resolve(arg("--changelog") ?? changelogFolder);
const version = arg("--version") ?? JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`«${version}» is not x.y.z`);
const macos = path.resolve(arg("--macos") ?? publish.macos(version, "arm64"));
if (sign && !hasUpdateKey()) fail("The update key is not set: TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH (NP-042, .env.example); --no-sign for a test.");

const folder = path.join(updates, version);
const where = shown(folder);
if (!existsSync(path.join(folder, "latest.json"))) fail(`${where}/latest.json is missing: bun run build:latest`);
const latest = JSON.parse(await readFile(path.join(folder, "latest.json"), "utf8"));
if (latest.version !== version) fail(`${where}/latest.json announces ${latest.version}, not ${version}`);

const sha256 = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
/** A file of the folder as release.json lists it. */
const described = async (name) => ({ name, size: (await stat(path.join(folder, name))).size, sha256: await sha256(path.join(folder, name)) });

// The packages are the ones latest.json names: each under this version's address, here, with the
// signature it quotes as its .sig (the same checks koona-deploy makes; build-site.mjs made them before).
const prefix = `${SITE}/downloads/${version}/`;
const names = new Set();
for (const [target, { url, signature }] of Object.entries(latest.platforms ?? {})) {
  if (!url.startsWith(prefix)) fail(`latest.json: ${target} points at ${url}, not under ${prefix}`);
  const name = decodeURIComponent(url.slice(prefix.length));
  const sig = path.join(folder, `${name}.sig`);
  if (!existsSync(path.join(folder, name)) || !existsSync(sig)) fail(`latest.json: ${name} or its .sig is not in ${where}`);
  if ((await readFile(sig, "utf8")).trim() !== signature) fail(`latest.json: the signature of ${name} is not its .sig`);
  names.add(name);
}
if (!names.size) fail(`${where}/latest.json names no package`);

/** release.json's key of a package, by the names build-latest.mjs publishes. */
const kind = (name) =>
  name.endsWith("-setup.exe") ? "windows" : name.endsWith(".deb") ? "deb" : name.endsWith(".rpm") ? "rpm" : name.endsWith(".AppImage") ? "appimage"
    : name.endsWith(".app.tar.gz") ? "macosUpdate" : null;

// SHA256SUMS.txt is offered for download next to the packages: it must say what release.json says.
if (!existsSync(path.join(folder, "SHA256SUMS.txt"))) fail(`${where}/SHA256SUMS.txt is missing: bun run build:latest`);
const sums = Object.fromEntries(
  (await readFile(path.join(folder, "SHA256SUMS.txt"), "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.match(/^([0-9a-f]{64}) [ *](.+)$/)?.slice(1) ?? fail(`SHA256SUMS.txt: «${line}» is not «<sha256>  <name>»`))
    .map(([hash, name]) => [name, hash]),
);

// In the order of the schema: windows, deb, rpm, appimage, macosUpdate, macos, sums.
const order = ["windows", "deb", "rpm", "appimage", "macosUpdate"];
const files = {};
for (const name of [...names].sort((a, b) => order.indexOf(kind(a)) - order.indexOf(kind(b)))) {
  const key = kind(name);
  if (!key) fail(`latest.json: ${name} is no package release.json knows (windows, deb, rpm, appimage, macosUpdate)`);
  if (files[key]) fail(`latest.json: two ${key} packages, ${files[key].name} and ${name}`);
  files[key] = await described(name);
  if (sums[name] !== files[key].sha256) fail(`SHA256SUMS.txt: ${name} ${sums[name] ? `is listed as ${sums[name]}, the file is ${files[key].sha256}` : "is not listed"}`);
}

// The macOS disk image: no updater entry, a download of the site. Its .sig is made here, so that one of
// another file or version never passes for it.
const dmg = `koonapin-${version}-macos-arm64.dmg`;
await rm(path.join(folder, dmg), { force: true });
await rm(path.join(folder, `${dmg}.sig`), { force: true });
if (existsSync(path.join(macos, dmg))) {
  await copyFile(path.join(macos, dmg), path.join(folder, dmg));
  if (sign) {
    if (!signFile(path.join(folder, dmg), { version })) fail(`Signing ${dmg} failed (the key or its password).`);
    console.log(`signed ${where}/${dmg}`);
  }
  files.macos = await described(dmg);
} else {
  console.warn(`No ${dmg} in ${shown(macos)}: release.json without macos`);
}
files.sums = await described("SHA256SUMS.txt");

let log;
try {
  log = entries(version, changelog);
} catch (error) {
  fail(error.message);
}
if (log[0]?.version !== version) fail(`changelog/${version}.md is missing: write what changed in ${version} first`);

const published = latest.pub_date;
if (!/^\d{4}-\d{2}-\d{2}T/.test(published ?? "")) fail(`latest.json: pub_date «${published}» is not an ISO time`);
const release = { schema: 1, version, date: published.slice(0, 10), published, files, changelog: log };

const out = path.join(folder, "release.json");
await writeFile(out, `${JSON.stringify(release, null, 2)}\n`);
// An earlier signature of another release.json must not stay next to this one.
await rm(`${out}.sig`, { force: true });
if (sign) {
  if (!signFile(out, { version })) fail("Signing release.json failed (the key or its password).");
  console.log(`signed ${where}/release.json`);
} else {
  console.log(`--no-sign: release.json${files.macos ? " and the DMG have" : " has"} no .sig, koona-deploy refuses ${files.macos ? "them" : "it"}`);
}
console.log(`${where}/release.json: ${version}, ${Object.keys(files).join(", ")}; changelog of ${log.length} versions`);
