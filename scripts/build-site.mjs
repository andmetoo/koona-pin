// Builds pin.netami.app into dist-site/ (doc/site.md): static pages in English and Russian,
// fonts, brand and screenshots served from the site itself, and the Firefox updates of NP-018
// from release/firefox when they are there.
//   node scripts/build-site.mjs
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { content, FEEDBACK_ENDPOINT, ORIGIN } from "../site/src/content.mjs";
import { feedback, feedbackResult, landing, licenses, notFound, privacy } from "../site/src/pages.mjs";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "dist-site");
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

for (const [lang, t] of Object.entries(content)) {
  const dir = lang === "en" ? "" : "ru/";
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

if (!FEEDBACK_ENDPOINT) console.log("feedback: NETAMIPIN_FEEDBACK_URL is not set, the form is left out and Support points at GitHub");
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
else console.warn("shots: site/src/shots is missing, run node scripts/site-screenshots.mjs");

// Firefox updates (NP-018): the address is inside the signed XPI and must not move.
const firefox = from("release/firefox");
if (existsSync(firefox)) {
  // Every update the manifest lists is here and has the hash Firefox will check.
  const manifest = JSON.parse(await readFile(path.join(firefox, "updates.json"), "utf8"));
  for (const u of Object.values(manifest.addons).flatMap((a) => a.updates)) {
    const file = path.join(firefox, path.basename(new URL(u.update_link).pathname));
    if (!u.update_link.startsWith(`${ORIGIN}/firefox/`)) throw new Error(`updates.json: ${u.update_link} is not under ${ORIGIN}/firefox/`);
    const hash = `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
    if (hash !== u.update_hash) throw new Error(`updates.json: ${path.basename(file)} has ${hash}, the manifest says ${u.update_hash}`);
  }
  await cp(firefox, path.join(out, "firefox"), { recursive: true });
  console.log("firefox:", (await readdir(firefox)).join(", "));
} else {
  console.log("firefox: release/firefox not found, /firefox/ is left out (npm run extension:sign:firefox)");
}

await writeFile(path.join(out, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`);
const urls = ["", "privacy", "licenses", ...(FEEDBACK_ENDPOINT ? ["feedback"] : [])].flatMap((p) => [`/${p}`, `/ru/${p}`]);
await writeFile(
  path.join(out, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${ORIGIN}${u}</loc></url>`).join("\n")}\n</urlset>\n`,
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

// Caddy lets browsers and Cloudflare keep /site.css, /brand, /shots and /fonts for a week
// (site/Caddyfile), while pages are no-cache. Each link carries the file's hash, so a deploy
// that changes a file changes its address, and a new page never meets the old stylesheet.
const ASSET = /\/(?:site\.css|(?:brand|shots|fonts)\/[\w.-]+)/g;
const versions = new Map();
for (const file of files.filter((f) => /^(site\.css|(brand|shots|fonts)\/[^/]+)$/.test(f))) {
  versions.set(`/${file}`, createHash("sha256").update(await readFile(path.join(out, file))).digest("hex").slice(0, 10));
}
for (const file of files.filter((f) => f.endsWith(".html"))) {
  const html = await readFile(path.join(out, file), "utf8");
  const versioned = html.replace(ASSET, (ref) => {
    if (!versions.has(ref)) throw new Error(`${file}: ${ref} is not in dist-site`);
    return `${ref}?v=${versions.get(ref)}`;
  });
  await writeFile(path.join(out, file), versioned);
}
console.log(`dist-site: ${files.length} files, ${versions.size} assets versioned`);
