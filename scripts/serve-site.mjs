// Serves release/publish/site/ locally under /pin/ with the rules of site/Caddyfile that matter for
// checking pages: /pin to /pin/, try_files {path} {path}.html {path}/index.html, the 404 pages, the
// language redirect of /pin/ (read from the Caddyfile itself), the security headers. "/" stands for
// the root site of koona.app and sends to /pin/. Not a production server.
//   bun scripts/serve-site.mjs [port]   (default 4173)
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { BASE, languages } from "../site/src/content.mjs";
import { publish, root as repo } from "./lib/paths.mjs";

// `@name header_regexp [capture] Accept-Language <re>` and `redir @name <target> 302`, in order.
const caddyfile = readFileSync(path.join(repo, "site/Caddyfile"), "utf8");
const welcome = [...caddyfile.matchAll(/^\s*@(\w+) header_regexp (?:(\w+) )?Accept-Language \(\?i\)(.+)$/gm)].map(([, name, capture, re]) => {
  const target = caddyfile.match(new RegExp(`^\\s*redir @${name} (\\S+) 302$`, "m"))?.[1];
  if (!target) throw new Error(`site/Caddyfile: no redir for @${name}`);
  return { re: new RegExp(re, "i"), target, capture };
});
/** Where the first visit of /pin/ goes for this Accept-Language, or nothing. */
function welcomePage(accept) {
  for (const { re, target, capture } of welcome) {
    const m = accept.match(re);
    if (m) return capture ? target.replace(`{re.${capture}.1}`, m[1]) : target;
  }
}
const dirs = languages.map((l) => l.dir).filter(Boolean);

const root = publish.site;
const port = Number(process.argv[2] || 4173);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2",
  ".json": "application/json", ".xpi": "application/x-xpinstall", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml",
  ".exe": "application/vnd.microsoft.portable-executable", ".deb": "application/vnd.debian.binary-package", ".rpm": "application/x-rpm",
  ".sig": "text/plain; charset=utf-8",
};
const HEADERS = {
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; script-src https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com; base-uri 'none'; form-action 'self' https://*.supabase.co; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};
const isFile = (p) => stat(p).then((s) => s.isFile(), () => false);

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/" || url.pathname === BASE) {
    res.writeHead(url.pathname === "/" ? 302 : 308, { Location: `${BASE}/` }).end();
    return;
  }
  if (!url.pathname.startsWith(`${BASE}/`)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not this site");
    return;
  }
  const local = url.pathname.slice(BASE.length);
  const referer = req.headers.referer ?? "";
  const welcomeTo = local === "/" && !referer.startsWith(`http://${req.headers.host}${BASE}/`) && welcomePage(req.headers["accept-language"] ?? "");
  if (welcomeTo) {
    res.writeHead(302, { Location: welcomeTo, Vary: "Accept-Language" }).end();
    return;
  }
  const clean = path.normalize(decodeURIComponent(local)).replace(/^(\.\.[/\\])+/, "");
  const candidates = [clean, `${clean}.html`, path.join(clean, "index.html")].map((p) => path.join(root, p));
  let file;
  for (const c of candidates) if (c.startsWith(root) && (await isFile(c))) { file = c; break; }
  const status = file ? 200 : 404;
  file ??= path.join(root, `${dirs.find((d) => local.startsWith(`/${d}`)) ?? ""}404.html`);
  res.writeHead(status, { ...HEADERS, "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  res.end(await readFile(file));
}).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}${BASE}/`));
