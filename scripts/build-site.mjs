// Builds koona.app/pin/ into release/publish/site/ (doc/site.md, NP-115): Astro builds the pages
// (site/, its own config there), then this script adds what is not a page — the Firefox updates of
// NP-018 from release/publish/firefox, the app's newest release from release/publish/updates (Р-60)
// and the screenshots at the addresses AppStream points to.
//   bun scripts/build-site.mjs
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { FEEDBACK_ENDPOINT, SITE } from "../site/src/content.mjs";
import { newestRelease } from "../site/src/release.mjs";
import { publish, root } from "./lib/paths.mjs";

const out = publish.site;
const from = (...p) => path.join(root, ...p);

// Pages, stylesheet, fonts and their images (site/astro.config.mjs). Astro empties the folder first.
const astro = spawnSync(process.execPath, [from("node_modules/astro/bin/astro.mjs"), "build", "--silent"], { cwd: from("site"), stdio: "inherit" });
if (astro.status !== 0) process.exit(astro.status ?? 1);
if (!FEEDBACK_ENDPOINT) console.log("feedback: KOONAPIN_FEEDBACK_URL is not set, the form is left out and Support points at GitHub");
if (!newestRelease()) console.log("downloads: no release in release/publish/updates, the landing says «coming soon» and /downloads/ is left out");

const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(p);
    else files.push(path.relative(out, p).replaceAll("\\", "/"));
  }
}
await walk(out);
// The pages run no scripts (doc/site.md): only the beacon Cloudflare inserts on the server.
for (const file of files.filter((f) => f.endsWith(".html"))) {
  if (/<script\b/i.test(await readFile(path.join(out, file), "utf8"))) throw new Error(`${file}: a <script> in the page`);
}

// Screenshots under their own names too: the AppStream metainfo of the Linux packages links them
// (src-tauri/linux/app.koona.pin.metainfo.xml). The pages link the hashed copies of /_astro/.
await cp(from("site/src/shots"), path.join(out, "shots"), { recursive: true });

// Firefox updates (NP-018): the address is inside the signed XPI and must not move.
const firefox = publish.firefox;
if (existsSync(firefox)) {
  // Every update the manifest lists is here and has the hash Firefox will check.
  const manifest = JSON.parse(await readFile(path.join(firefox, "updates.json"), "utf8"));
  for (const u of Object.values(manifest.addons).flatMap((a) => a.updates)) {
    const file = path.join(firefox, path.basename(new URL(u.update_link).pathname));
    if (!u.update_link.startsWith(`${SITE}/firefox/`)) throw new Error(`updates.json: ${u.update_link} is not under ${SITE}/firefox/`);
    const hash = `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
    if (hash !== u.update_hash) throw new Error(`updates.json: ${path.basename(file)} has ${hash}, the manifest says ${u.update_hash}`);
  }
  await cp(firefox, path.join(out, "firefox"), { recursive: true });
  console.log("firefox:", (await readdir(firefox)).join(", "));
} else {
  console.log("firefox: release/publish/firefox not found, /firefox/ is left out (bun run extension:sign:firefox)");
}

// App updates (NP-038, NP-102, Р-60): the newest release of bun run build:latest. Its packages go to
// /downloads/<version>/, its latest.json to /updates/latest.json, where every installed app reads it.
// Older versions are not carried: the updater needs only the newest, and their signatures are bound
// to their own number.
const version = newestRelease();
if (version) {
  const folder = path.join(publish.updates, version);
  const latest = JSON.parse(await readFile(path.join(folder, "latest.json"), "utf8"));
  if (latest.version !== version) throw new Error(`updates/${version}/latest.json announces ${latest.version}`);
  // Every package the manifest names is here, under this version's address, with the signature it quotes.
  for (const [target, { url, signature }] of Object.entries(latest.platforms)) {
    const prefix = `${SITE}/downloads/${version}/`;
    if (!url.startsWith(prefix)) throw new Error(`latest.json: ${target} points at ${url}, not under ${prefix}`);
    const file = decodeURIComponent(url.slice(prefix.length));
    const sig = path.join(folder, `${file}.sig`);
    if (!existsSync(path.join(folder, file)) || !existsSync(sig)) throw new Error(`latest.json: ${file} or its .sig is not in updates/${version}`);
    if ((await readFile(sig, "utf8")).trim() !== signature) throw new Error(`latest.json: the signature of ${file} is not its .sig`);
  }
  await cp(folder, path.join(out, "downloads", version), { recursive: true, filter: (src) => path.basename(src) !== "latest.json" });
  await mkdir(path.join(out, "updates"));
  await cp(path.join(folder, "latest.json"), path.join(out, "updates", "latest.json"));
  console.log(`updates: ${version}, ${Object.keys(latest.platforms).join(", ")}`);
} else {
  console.log("updates: release/publish/updates has no release, /updates/ and /downloads/ are left out (bun run build:latest)");
}

console.log(`${path.relative(root, out)}: ${files.filter((f) => f.endsWith(".html")).length} pages, ${files.filter((f) => f.startsWith("_astro/")).length} hashed files`);
