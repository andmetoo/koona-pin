// Serves release/publish/site/ locally with the rules of site/Caddyfile that matter for checking pages:
// try_files {path} {path}.html {path}/index.html, the 404 pages, the Russian redirect of "/",
// the security headers. Not a production server.
//   node scripts/serve-site.mjs [port]   (default 4173)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { publish } from "./lib/paths.mjs";

const root = publish.site;
const port = Number(process.argv[2] || 4173);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2",
  ".json": "application/json", ".xpi": "application/x-xpinstall", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml",
};
const HEADERS = {
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; script-src https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com; base-uri 'none'; form-action 'self' https://*.supabase.co; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};
const isFile = (p) => stat(p).then((s) => s.isFile(), () => false);

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const referer = req.headers.referer ?? "";
  if (url.pathname === "/" && /^\s*ru\b/i.test(req.headers["accept-language"] ?? "") && !referer.startsWith(`http://${req.headers.host}/`)) {
    res.writeHead(302, { Location: "/ru/", Vary: "Accept-Language" }).end();
    return;
  }
  const clean = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const candidates = [clean, `${clean}.html`, path.join(clean, "index.html")].map((p) => path.join(root, p));
  let file;
  for (const c of candidates) if (c.startsWith(root) && (await isFile(c))) { file = c; break; }
  const status = file ? 200 : 404;
  file ??= path.join(root, url.pathname.startsWith("/ru/") ? "ru/404.html" : "404.html");
  res.writeHead(status, { ...HEADERS, "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  res.end(await readFile(file));
}).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}`));
