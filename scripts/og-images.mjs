// Link previews of koona.app/pin (og:image), 1200×630, one per language of the site: the cream mascot on
// envy green, the wordmark and the first line of the landing's headline in that language (landing.sketch,
// «OG · A», chosen by the owner on 9 October 2026). Not a screenshot of the app: a card in Koona Pin, a chat
// or a social site keeps only its centre (1008×630 in Koona Pin), and a screenshot read as noise there.
// Writes site/src/shots/og-<lang>.jpg.
//   bun scripts/og-images.mjs
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { content } from "../site/src/content.mjs";

const root = path.resolve(import.meta.dirname, "..");
const data = async (file, type) => `data:${type};base64,${(await readFile(path.join(root, file))).toString("base64")}`;
const fonts = {
  latin: await data("node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", "font/woff2"),
  ext: await data("node_modules/@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2", "font/woff2"),
  cyrillic: await data("node_modules/@fontsource-variable/inter/files/inter-cyrillic-wght-normal.woff2", "font/woff2"),
};
const mascot = await data("design/brand/pin-spirit-flat/pin-spirit-cream.svg", "image/svg+xml");
const wordmark = (await readFile(path.join(root, "site/src/brand/wordmark.svg"), "utf8")).trim();
// The site's stacks for Chinese, Japanese and Korean (site.css): Inter has none of their letters.
const cjk = {
  zh: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", ',
  ja: '"Yu Gothic UI", "Meiryo UI", "Hiragino Sans", "Noto Sans CJK JP", ',
  ko: '"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans CJK KR", ',
};

const card = (t) => `<!doctype html><html lang="${t.lang}"><head><meta charset="utf-8"><style>
  @font-face { font-family: Inter; src: url("${fonts.latin}") format("woff2"); font-weight: 100 900; unicode-range: U+0000-00FF, U+2000-206F; }
  @font-face { font-family: Inter; src: url("${fonts.ext}") format("woff2"); font-weight: 100 900; unicode-range: U+0100-02BA, U+1E00-1EFF; }
  @font-face { font-family: Inter; src: url("${fonts.cyrillic}") format("woff2"); font-weight: 100 900; unicode-range: U+0400-045F, U+0490-0491; }
  * { margin: 0; box-sizing: border-box; }
  body { width: 1200px; height: 630px; overflow: hidden; position: relative; background: #2f6b4f;
    font-family: Inter, ${cjk[t.lang.slice(0, 2)] ?? ""}system-ui, sans-serif; }
  .light { position: absolute; left: 760px; top: -300px; width: 820px; height: 820px; border-radius: 50%; background: #367457; }
  .shade { position: absolute; left: -260px; top: 380px; width: 700px; height: 700px; border-radius: 50%; background: #2a6047; }
  /* Inside the centre a Koona Pin card keeps (1008×630) with room to spare. */
  .row { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 40px; padding: 0 150px; }
  .mascot { width: 346px; height: 360px; flex: none; }
  .text { color: #fffefa; min-width: 0; }
  .wordmark { display: block; width: 400px; height: auto; }
  p { margin-top: 18px; max-width: 470px; font-size: 34px; line-height: 1.3; font-weight: 500; color: #e2eee6; text-wrap: balance; }
</style></head><body>
<div class="light"></div><div class="shade"></div>
<div class="row"><img class="mascot" src="${mascot}" alt=""><div class="text">${wordmark.replace("<svg ", '<svg class="wordmark" ')}<p>${t.h1[0]}</p></div></div>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  for (const t of Object.values(content)) {
    await page.setContent(card(t));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(root, "site/src/shots", `og-${t.lang}.jpg`), type: "jpeg", quality: 88 });
    console.log(`og-${t.lang}.jpg`);
  }
} finally {
  await browser.close();
}
