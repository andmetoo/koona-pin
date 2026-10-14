// The extraction half of the reading mode sample run (NP-120).
//
//   cargo run --example reader_sample --manifest-path src-tauri/Cargo.toml -- urls.txt <dir>
//   bun run scripts/reader-sample.ts <dir>
//
// Reads the `NN.json` the example wrote and runs the app's own extraction
// (`src/services/reader.ts`) in Edge — Chromium, as WebView2 is: jsdom's selector
// engine refuses Defuddle's longest selectors. Writes `<dir>/report.md` (one row per
// link), `<dir>/shots/NN.html` (each article in a plain reading page, scripts off by
// CSP) and `<dir>/shots/NN.png` (its first screen).
import { chromium } from "@playwright/test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: bun run scripts/reader-sample.ts <dir>");
  process.exit(2);
}
const shots = join(dir, "shots");
mkdirSync(shots, { recursive: true });

// The module as the reader window gets it, bundled for the browser.
const entry = join(dir, "reader-entry.ts");
writeFileSync(entry, `import { articleOf, verdict } from ${JSON.stringify(resolve("src/services/reader.ts"))};\nObject.assign(window, { reader: { articleOf, verdict } });\n`);
const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "iife" });
if (!built.success) throw new AggregateError(built.logs, "bundle failed");
const bundle = await built.outputs[0].text();

const STYLE = `body{margin:0;background:#fbfaf7;color:#1f1d1a;font:18px/1.6 Georgia,serif}
main{max-width:680px;margin:0 auto;padding:40px 24px}h1{font:600 32px/1.2 system-ui,sans-serif;margin:0 0 8px}
.meta{color:#77736b;font:14px/1.4 system-ui,sans-serif;margin:0 0 32px}.fail{background:#fde8e4;padding:8px 12px;font:14px system-ui}
img{max-width:100%;height:auto}pre{overflow:auto;background:#f0eee8;padding:12px;font-size:14px}code{font-size:.9em}
a{color:#2457c5}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px}blockquote{border-left:3px solid #ddd;margin:0;padding-left:16px;color:#555}`;
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ");

const browser = await chromium.launch({ channel: "msedge" });
const context = await browser.newContext({ viewport: { width: 1000, height: 1300 } });
const work = await context.newPage();
await work.setContent("<!doctype html><html><body></body></html>");
await work.addScriptTag({ content: bundle });

type Row = { n: number; url: string; status: string; charset: string; words: number; links: string; verdict: string; author: string; ms: number };
const rows: Row[] = [];
for (const file of readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).sort()) {
  const record = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const page = record.page;
  const n = String(record.n).padStart(2, "0");
  const row: Row = { n: record.n, url: record.url, status: "", charset: "", words: 0, links: "", verdict: "", author: "", ms: 0 };
  if (page.kind === "page") {
    row.status = String(page.status);
    row.charset = page.charset + (page.truncated ? " (cut at 5 MB)" : "");
    const { article, failure, ms } = await work.evaluate(
      ([html, url]) => {
        const { articleOf, verdict } = (window as any).reader;
        const started = performance.now();
        const article = articleOf(html, url);
        const ms = performance.now() - started;
        return { article, failure: article ? verdict(article) : { reason: "empty" }, ms };
      },
      [page.html, page.url],
    );
    row.ms = Math.round(ms);
    row.verdict = failure ? failure.reason : "show";
    if (article) {
      row.words = article.words;
      row.links = `${Math.round(article.linkDensity * 100)}%`;
      row.author = article.author ?? "";
      const note = failure ? `<p class="fail">Not shown: ${esc(failure.reason)}</p>` : "";
      const byline = [article.author, article.site, article.published, `${article.words} words`].filter(Boolean).map(esc).join(" · ");
      writeFileSync(
        join(shots, `${n}.html`),
        `<!doctype html><html lang="${esc(article.language ?? "")}"><head><meta charset="utf-8">` +
          `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https:; style-src 'unsafe-inline'">` +
          `<meta name="referrer" content="no-referrer"><title>${esc(article.title)}</title><style>${STYLE}</style></head>` +
          `<body><main>${note}<h1>${esc(article.title)}</h1><p class="meta">${byline}<br>${esc(article.url)}</p>${article.html}</main></body></html>`,
      );
    }
  } else {
    row.status = page.kind === "status" ? String(page.status) : page.kind;
    row.verdict = page.kind === "not_html" ? `not_html (${page.content_type})` : page.kind;
  }
  rows.push(row);
}

// First screens of what was extracted, pictures loaded from the sites as the reader would.
const view = await context.newPage();
for (const row of rows) {
  const n = String(row.n).padStart(2, "0");
  if (!row.words) continue;
  await view.goto(pathToFileURL(resolve(shots, `${n}.html`)).href, { waitUntil: "load", timeout: 30_000 }).catch(() => {});
  // Pictures are lazy in the reader; the first screen's are loaded before the shot.
  await view.evaluate(() => document.querySelectorAll("img").forEach((img) => (img.loading = "eager")));
  await view.waitForFunction(() => Array.from(document.images).every((img) => img.complete), undefined, { timeout: 20_000 }).catch(() => {});
  await view.screenshot({ path: join(shots, `${n}.png`) });
}
await browser.close();

const lines = [
  "| # | Page | HTTP | Charset | Words | Links | Author | Verdict | ms |",
  "|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.n} | ${cell(r.url)} | ${r.status} | ${cell(r.charset)} | ${r.words || ""} | ${r.links} | ${cell(r.author)} | ${cell(r.verdict)} | ${r.ms || ""} |`),
  "",
  `Shown: ${rows.filter((r) => r.verdict === "show").length} of ${rows.length}.`,
];
writeFileSync(join(dir, "report.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
