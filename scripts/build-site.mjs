// Builds koona.app/pin/ into release/publish/site/ (doc/site.md): static pages in the app's
// languages (NP-107), fonts, brand and screenshots served from the site itself, and the Firefox
// updates of NP-018 from release/publish/firefox when they are there.
//   bun scripts/build-site.mjs
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { BASE, content, FEEDBACK_ENDPOINT, languages, SITE } from "../site/src/content.mjs";
import { feedback, feedbackResult, landing, licenses, notFound, privacy } from "../site/src/pages.mjs";
import { publish, root } from "./lib/paths.mjs";

const out = publish.site;
const from = (...p) => path.join(root, ...p);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const wordmark = (await readFile(from("site/src/brand/wordmark.svg"), "utf8")).trim();
const markdown = await readFile(from("extension/store/privacy.md"), "utf8");

async function page(file, html) {
  const target = path.join(out, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, html);
}

for (const t of Object.values(content)) {
  const dir = t.dir;
  await page(`${dir}index.html`, landing(t, { wordmark }));
  // /privacy and /licenses: Caddy tries {path}.html (site/Caddyfile).
  await page(`${dir}privacy.html`, privacy(t, { markdown, wordmark }));
  await page(`${dir}licenses.html`, licenses(t, { wordmark }));
  await page(`${dir}404.html`, notFound(t, { wordmark }));
  // /feedback is feedback/index.html next to feedback/sent.html: Caddy tries {path}/index.html.
  if (FEEDBACK_ENDPOINT) {
    await page(`${dir}feedback/index.html`, feedback(t, { wordmark }));
    for (const outcome of ["sent", "limit", "long", "origin", "error"]) await page(`${dir}feedback/${outcome}.html`, feedbackResult(t, { wordmark, outcome }));
  }
}

if (!FEEDBACK_ENDPOINT) console.log("feedback: KOONAPIN_FEEDBACK_URL is not set, the form is left out and Support points at GitHub");
await cp(from("site/src/site.css"), path.join(out, "site.css"));

// Inter Variable: Latin, Latin Extended, Cyrillic (the pages use nothing else).
await mkdir(path.join(out, "fonts"));
for (const subset of ["latin", "latin-ext", "cyrillic"]) {
  const name = `inter-${subset}-wght-normal.woff2`;
  await cp(from("node_modules/@fontsource-variable/inter/files", name), path.join(out, "fonts", name));
}

// Brand: mascot by theme, the small mark as favicon, PNG fallbacks from the app icons.
await mkdir(path.join(out, "brand"));
for (const name of ["pin-spirit.svg", "pin-spirit-mint.svg"]) {
  await cp(from("design/brand/pin-spirit-flat", name), path.join(out, "brand", name));
}
await cp(from("design/brand/pin-spirit-flat/pin-spirit-micro.svg"), path.join(out, "brand/favicon.svg"));
await cp(from("src-tauri/icons/32x32.png"), path.join(out, "brand/favicon-32.png"));
await cp(from("src-tauri/icons/128x128@2x.png"), path.join(out, "brand/apple-touch-icon.png"));

// Screenshots of the real app (scripts/site-screenshots.mjs).
if (existsSync(from("site/src/shots"))) await cp(from("site/src/shots"), path.join(out, "shots"), { recursive: true });
else console.warn("shots: site/src/shots is missing, run bun scripts/site-screenshots.mjs");

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

// robots.txt belongs to the root of koona.app, which names this sitemap (site/Caddyfile, Р-47).
const urls = ["", "privacy", "licenses", ...(FEEDBACK_ENDPOINT ? ["feedback"] : [])].flatMap((p) => languages.map((l) => `/${l.dir}${p}`));
await writeFile(
  path.join(out, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${SITE}${u}</loc></url>`).join("\n")}\n</urlset>\n`,
);

const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(p);
    else files.push(path.relative(out, p).replaceAll("\\", "/"));
  }
}
await walk(out);

// Caddy lets browsers and Cloudflare keep site.css, brand, shots and fonts for a week
// (site/Caddyfile), while pages are no-cache. Each link carries the file's hash, so a deploy
// that changes a file changes its address, and a new page never meets the old stylesheet.
const ASSET = new RegExp(`${BASE}/(?:site\\.css|(?:brand|shots|fonts)/[\\w.-]+)`, "g");
const versions = new Map();
for (const file of files.filter((f) => /^(site\.css|(brand|shots|fonts)\/[^/]+)$/.test(f))) {
  versions.set(`${BASE}/${file}`, createHash("sha256").update(await readFile(path.join(out, file))).digest("hex").slice(0, 10));
}
for (const file of files.filter((f) => f.endsWith(".html"))) {
  const html = await readFile(path.join(out, file), "utf8");
  const versioned = html.replace(ASSET, (ref) => {
    if (!versions.has(ref)) throw new Error(`${file}: ${ref} is not in the build`);
    return `${ref}?v=${versions.get(ref)}`;
  });
  await writeFile(path.join(out, file), versioned);
}
console.log(`${path.relative(root, out)}: ${files.length} files, ${versions.size} assets versioned`);
