// Store listing images (NP-017, NP-046): four screenshots at 1280×800 in English and Russian, made of the
// real extension connected to a test Koona Pin through the real host — the note after a save on an article,
// the quick search over the library, the app's library (the site's screenshot), the options page — plus the
// promo tile (440×280) and the Edge logo (300×300). Writes extension/store/.
//
//   bun scripts/store-assets.mjs
// Koona Pin must be closed: one instance per user, the test app would hand over to it.
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildExtension } from "./build-extension.mjs";
import { assertNoOtherApp, hostBinary, startedSince, testPipe } from "./lib/native-host.mjs";
import { release } from "./lib/paths.mjs";

assertNoOtherApp();

const HOST = "app.koona.pin.test";
const KEY = `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST}`;
const out = path.resolve("extension/store");
const directory = path.resolve(".test-data", `store-assets-${Date.now()}`);
await mkdir(directory, { recursive: true });
const built = await buildExtension({ log: () => {} });
const extension = path.join(directory, "unpacked-extension");
await cp(built.unpacked.chrome, extension, { recursive: true });
// Test hooks: a save without a click, and the note's code and arguments instead of injecting it — the
// note is then drawn by the same function on the demo article.
await appendFile(
  path.join(extension, "worker.js"),
  `
globalThis.__captureForTest = captureTab;
globalThis.__noteForTest = async (state) => {
  let note;
  const inject = ext.scripting.executeScript;
  ext.scripting.executeScript = async ({ func, args }) => { note = { source: func.toString(), args }; return []; };
  try { await tell({ id: 1 }, state); } finally { ext.scripting.executeScript = inject; }
  return note;
};
`,
);
const version = path.join(extension, "version.js");
await writeFile(version, (await readFile(version, "utf8")).replace('"app.koona.pin"', JSON.stringify(HOST)));
const manifest = path.join(directory, `${HOST}.json`);
await writeFile(
  manifest,
  JSON.stringify({
    name: HOST,
    description: "Koona Pin test",
    path: hostBinary(),
    type: "stdio",
    allowed_origins: [`chrome-extension://${built.devId}/`],
  }),
);
execFileSync("reg", ["add", KEY, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"], { stdio: "ignore" });

const env = {
  ...process.env,
  KOONAPIN_DATA_DIR: directory,
  WEBVIEW2_USER_DATA_FOLDER: path.join(directory, "webview"),
  KOONAPIN_PIPE: testPipe("store"),
};
const apps = startedSince();

const font = async (name) =>
  `data:font/woff2;base64,${(await readFile(path.join(built.unpacked.chrome, "fonts", name))).toString("base64")}`;
const [latin, cyrillic] = [await font("inter-latin-wght-normal.woff2"), await font("inter-cyrillic-wght-normal.woff2")];
const fontFace = `
  @font-face { font-family: Inter; src: url("${latin}") format("woff2"); font-weight: 100 900; }
  @font-face { font-family: Inter; src: url("${cyrillic}") format("woff2"); font-weight: 100 900; unicode-range: U+0400-04FF; }
  * { margin: 0; box-sizing: border-box; }
  body { font-family: Inter, sans-serif; }`;

/** What is in the library before the shots, and the article the note appears on. */
const content = {
  en: {
    links: [
      ["https://blog.example/rust-generics", "How Rust compiles generics"],
      ["https://design.example/grids", "Grids that hold up on every screen"],
      ["https://notes.example/sqlite-wal", "SQLite WAL mode, explained"],
      ["https://kitchen.example/sourdough", "A sourdough starter in five days"],
      ["https://travel.example/lisbon", "Three quiet days in Lisbon"],
      ["https://docs.example/rust-traits", "Rust traits and generic bounds"],
      ["https://news.example/webgpu", "WebGPU arrives in every browser"],
      ["https://blog.example/rust-async", "Async Rust without the confusion"],
      ["https://video.example/rust-ownership", "Ownership in Rust, drawn on a whiteboard"],
    ],
    query: "rust",
    site: "blog.example",
    kicker: "Engineering",
    title: "How Rust compiles generics",
    byline: "8 min read",
    body: [
      "When you write a generic function in Rust, the compiler does not keep one copy of it. It makes a separate copy for every type you call it with — a process called monomorphization.",
      "That is why generic code in Rust is as fast as code written by hand for each type: every call goes straight to a function made for exactly that type, with nothing to look up at run time.",
      "The price is in the binary. Each copy takes space, and a generic used with many types can make a program noticeably larger. Trait objects trade a little speed for one shared copy.",
    ],
  },
  ru: {
    links: [
      ["https://blog.example/ru/rust-generics", "Как Rust компилирует обобщённый код"],
      ["https://design.example/ru/grids", "Сетки, которые держатся на любом экране"],
      ["https://notes.example/ru/sqlite-wal", "Режим WAL в SQLite простыми словами"],
      ["https://kitchen.example/ru/sourdough", "Закваска для хлеба за пять дней"],
      ["https://travel.example/ru/lisbon", "Три спокойных дня в Лиссабоне"],
      ["https://docs.example/ru/rust-traits", "Типажи Rust и ограничения обобщений"],
      ["https://news.example/ru/webgpu", "WebGPU приходит во все браузеры"],
      ["https://blog.example/ru/rust-async", "Асинхронный Rust без путаницы"],
      ["https://video.example/ru/rust-ownership", "Владение в Rust на маркерной доске"],
    ],
    query: "rust",
    site: "blog.example",
    kicker: "Разработка",
    title: "Как Rust компилирует обобщённый код",
    byline: "8 минут чтения",
    body: [
      "Когда вы пишете обобщённую функцию на Rust, компилятор не хранит одну её копию. Он делает отдельную копию для каждого типа, с которым её вызывают, — это называется мономорфизацией.",
      "Поэтому обобщённый код на Rust так же быстр, как написанный вручную для каждого типа: каждый вызов идёт прямо в функцию, сделанную для этого типа, без поиска во время работы.",
      "Цена — в размере программы. Каждая копия занимает место, и обобщение, вызванное со многими типами, заметно увеличивает файл. Типаж-объекты меняют немного скорости на одну общую копию.",
    ],
  },
};

/** The browser's bar drawn above a frame with the article: the note lands in the page, under the bar, as in a browser. */
const browserFrame = (c, icon) => `<!doctype html><html><head><meta charset="utf-8"><style>${fontFace}
  body { width: 1280px; height: 800px; overflow: hidden; background: #ffffff; display: flex; flex-direction: column; }
  .chrome { flex: none; height: 52px; background: #f1f3f4; border-bottom: 1px solid #dadce0; display: flex; align-items: center; gap: 12px; padding: 0 16px; }
  .dots { display: flex; gap: 8px; } .dots i { width: 12px; height: 12px; border-radius: 50%; background: #c4c7c5; display: block; }
  .url { flex: 1; height: 34px; border-radius: 17px; background: #ffffff; display: flex; align-items: center; padding: 0 16px; font-size: 15px; color: #444746; }
  .btn { width: 34px; height: 34px; border-radius: 8px; display: grid; place-items: center; background: #ffffff; box-shadow: inset 0 0 0 2px #2f6b4f; }
  .btn img { width: 22px; height: 22px; }
  iframe { flex: 1; border: 0; width: 100%; }
</style></head><body>
<div class="chrome"><span class="dots"><i></i><i></i><i></i></span><span class="url">${c.site}/${c.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-")}</span><span class="btn"><img src="${icon}" alt=""></span></div>
<iframe name="page"></iframe>
</body></html>`;

/** The article in the frame. */
const article = (c) => `<!doctype html><html><head><meta charset="utf-8"><style>${fontFace}
  body { background: #ffffff; color: #1d1d1b; overflow: hidden; }
  main { width: 680px; margin: 48px auto 0; }
  .kicker { font-size: 14px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: #8a5a00; }
  h1 { margin-top: 14px; font-size: 44px; line-height: 1.15; font-weight: 700; letter-spacing: -.02em; }
  .by { margin-top: 14px; font-size: 15px; color: #6b6b61; }
  .hero { margin-top: 28px; height: 150px; border-radius: 12px; background: linear-gradient(120deg, #e8eef9, #f6e9dd); }
  p { margin-top: 22px; font-size: 18px; line-height: 1.65; color: #333330; }
</style></head><body>
<main><p class="kicker">${c.kicker}</p><h1>${c.title}</h1><p class="by">${c.byline}</p><div class="hero"></div>${c.body.map((p) => `<p>${p}</p>`).join("")}</main>
</body></html>`;

async function shots(lang) {
  const c = content[lang];
  const browser = await chromium.launchPersistentContext(path.join(directory, `profile-${lang}`), {
    channel: "chromium",
    headless: true,
    env,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging", `--lang=${lang}`],
    viewport: { width: 1280, height: 800 },
  });
  try {
    const cdp = await browser.browser().newBrowserCDPSession();
    const { id } = await cdp.send("Extensions.loadUnpacked", { path: extension });
    const worker =
      browser.serviceWorkers().find((w) => w.url().includes(id)) ??
      (await browser.waitForEvent("serviceworker", { predicate: (w) => w.url().includes(id) }));
    // Real saves through the host, so the search finds them and the options page shows the last save.
    for (const [url, title] of c.links) await worker.evaluate(async (tab) => globalThis.__captureForTest(tab), { url, title });
    await mkdir(path.join(out, lang), { recursive: true });
    const icon = `data:image/png;base64,${(await readFile(path.join(built.unpacked.chrome, "icons", "32.png"))).toString("base64")}`;
    // A persistent context keeps its own viewport: each page gets its size after it opens.
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.setContent(browserFrame(c, icon));
    const frame = page.frame({ name: "page" });
    await frame.setContent(article(c));
    await page.evaluate(() => document.fonts.ready);
    await frame.evaluate(() => document.fonts.ready);
    const plain = await page.screenshot();

    // 1 · The note after a save, drawn by the extension's own function in the page.
    const note = await worker.evaluate(async () => globalThis.__noteForTest("saved"));
    await frame.evaluate(({ source, args }) => new Function(`return (${source})`)()(args[0]), note);
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(out, lang, "1-save-1280x800.png") });

    // 2 · The quick search: the extension's popup (420×520, shown at 1.25×) over the article, under the button.
    const zoom = 1.25;
    const search = await browser.newPage();
    await search.setViewportSize({ width: 420 * zoom, height: 520 * zoom });
    await search.goto(`chrome-extension://${id}/search.html`);
    await search.evaluate((z) => (document.documentElement.style.zoom = String(z)), zoom);
    await search.locator("input").first().fill(c.query);
    await search.waitForTimeout(1200);
    const popup = await search.screenshot();
    await search.close();
    await page.setContent(`<style>${fontFace}
      body { width: 1280px; height: 800px; position: relative; overflow: hidden; }
      .back { position: absolute; inset: 0; }
      .pop { position: absolute; top: 48px; right: 14px; width: ${420 * zoom}px; height: ${520 * zoom}px; border-radius: 10px; overflow: hidden;
        box-shadow: 0 2px 6px rgba(0,0,0,.18), 0 16px 48px rgba(0,0,0,.22); }
      </style><img class="back" src="data:image/png;base64,${plain.toString("base64")}"><img class="pop" src="data:image/png;base64,${popup.toString("base64")}">`);
    await page.screenshot({ path: path.join(out, lang, "2-search-1280x800.png") });

    // 3 · The app's library: the screenshot of the real app (bun run site:shots writes release/shots/).
    const shots = path.join(release, "shots");
    if (!existsSync(path.join(shots, "app-en-light-grid-1280.webp"))) throw new Error(`${shots} has no screenshots: bun run site:shots first`);
    const shot = path.join(shots, `app-${existsSync(path.join(shots, `app-${lang}-light-grid-1280.webp`)) ? lang : "en"}-light-grid-1280.webp`);
    await page.setContent(`<style>body{margin:0}</style><img src="data:image/webp;base64,${(await readFile(shot)).toString("base64")}" width="1280" height="800">`);
    await page.locator("img").evaluate((img) => img.decode());
    await page.screenshot({ path: path.join(out, lang, "3-library-1280x800.png") });

    // 4 · The options page: connected, the app's version, the last save. A narrow column: laid out at
    // 800×500 and shown at 1.6×.
    const options = await browser.newPage();
    await options.setViewportSize({ width: 1280, height: 800 });
    await options.goto(`chrome-extension://${id}/options.html`);
    await options.locator('#status[data-state="connected"]').waitFor();
    await options.evaluate(() => (document.documentElement.style.zoom = "1.6"));
    await options.screenshot({ path: path.join(out, lang, "4-options-1280x800.png") });
  } finally {
    await browser.close();
  }
}

// On envy green the mascot has the cream body (design/brand/pin-spirit-flat, NP-081).
const spirit = `data:image/svg+xml;base64,${(await readFile(path.resolve("design/brand/pin-spirit-flat/pin-spirit-cream.svg"))).toString("base64")}`;
const mark = (size) => `<img src="${spirit}" width="${Math.round((size * 880) / 916)}" height="${size}" alt="">`;
const tagline = { en: "Save the page in one click", ru: "Сохраняйте страницу одним нажатием" };

async function images() {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const lang of ["en", "ru"]) {
      await page.setViewportSize({ width: 440, height: 280 });
      await page.setContent(`<style>${fontFace}
        body { width: 440px; height: 280px; background: #2f6b4f; color: #fffefa; display: flex; flex-direction: column; justify-content: center; padding: 0 40px; gap: 18px; }
        .brand { display: flex; align-items: center; gap: 16px; font-size: 40px; font-weight: 600; letter-spacing: -0.5px; }
        p { font-size: 20px; color: #e2eee6; }
        </style><div class="brand">${mark(84)}koona pin</div><p>${tagline[lang]}</p>`);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: path.join(out, lang, "promo-440x280.png") });
    }
    await page.setViewportSize({ width: 300, height: 300 });
    await page.setContent(`<style>${fontFace}
      body { width: 300px; height: 300px; background: #2f6b4f; display: grid; place-items: center; }
      </style>${mark(240)}`);
    await page.screenshot({ path: path.join(out, "logo-300x300.png") });
  } finally {
    await browser.close();
  }
}

try {
  for (const lang of ["en", "ru"]) await rm(path.join(out, lang, "options-1280x800.png"), { force: true });
  await shots("en");
  await shots("ru");
  await images();
  console.log(`Store images: ${out}`);
} finally {
  apps.stop();
  execFileSync("reg", ["delete", KEY, "/f"], { stdio: "ignore" });
}
