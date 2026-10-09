// /pin/sitemap.xml: the robots.txt of koona.app names it (site/Caddyfile, Р-47).
import { FEEDBACK_ENDPOINT, languages, SITE } from "../content.mjs";
import { release } from "../release.mjs";

export function GET() {
  const urls = [
    ...["", "privacy", "licenses", ...(FEEDBACK_ENDPOINT ? ["feedback"] : [])].flatMap((p) => languages.map((l) => `/${l.dir}${p}`)),
    ...(release() ? ["/downloads/"] : []),
    "/changelog/",
  ];
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${SITE}${u}</loc></url>`).join("\n")}\n</urlset>\n`;
  return new Response(body, { headers: { "Content-Type": "application/xml" } });
}
