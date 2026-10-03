// Store listing images (NP-017): the real options page at 1280×800 in English
// and Russian, connected to a test Netami Pin through the real host, plus the
// promo tile (440×280) and the Edge logo (300×300). Writes extension/store/.
//
//   node scripts/store-assets.mjs
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildExtension } from "./build-extension.mjs";
import { hostBinary, startedSince, testPipe } from "./lib/native-host.mjs";

const HOST = "app.netami.pin.test";
const KEY = `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST}`;
const out = path.resolve("extension/store");
const directory = path.resolve(".test-data", `store-assets-${Date.now()}`);
await mkdir(directory, { recursive: true });
const built = await buildExtension({ log: () => {} });
const extension = path.join(directory, "unpacked-extension");
await cp(built.unpacked.chrome, extension, { recursive: true });
await appendFile(path.join(extension, "worker.js"), "\nglobalThis.__captureForTest = captureTab;\n");
const version = path.join(extension, "version.js");
await writeFile(version, (await readFile(version, "utf8")).replace('"app.netami.pin"', JSON.stringify(HOST)));
const manifest = path.join(directory, `${HOST}.json`);
await writeFile(
  manifest,
  JSON.stringify({
    name: HOST,
    description: "Netami Pin test",
    path: hostBinary(),
    type: "stdio",
    allowed_origins: [`chrome-extension://${built.devId}/`],
  }),
);
execFileSync("reg", ["add", KEY, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"], { stdio: "ignore" });

const env = {
  ...process.env,
  NETAMIPIN_DATA_DIR: directory,
  WEBVIEW2_USER_DATA_FOLDER: path.join(directory, "webview"),
  NETAMIPIN_PIPE: testPipe("store"),
};
const apps = startedSince();
const titles = { en: "How Rust compiles generics", ru: "Как Rust компилирует обобщённый код" };

async function options(lang) {
  const browser = await chromium.launchPersistentContext(path.join(directory, `profile-${lang}`), {
    channel: "chromium",
    headless: true,
    env,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging", `--lang=${lang}`],
    // The page is a narrow column: a smaller viewport at 1.6× fills 1280×800.
    viewport: { width: 800, height: 500 },
    deviceScaleFactor: 1.6,
  });
  try {
    const cdp = await browser.browser().newBrowserCDPSession();
    const { id } = await cdp.send("Extensions.loadUnpacked", { path: extension });
    const worker =
      browser.serviceWorkers().find((w) => w.url().includes(id)) ??
      (await browser.waitForEvent("serviceworker", { predicate: (w) => w.url().includes(id) }));
    // One real save, so the page shows the app version and the last save.
    await worker.evaluate(
      async ({ url, title }) => globalThis.__captureForTest({ url, title }),
      { url: `https://blog.example/${lang}/generics`, title: titles[lang] },
    );
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${id}/options.html`);
    await page.locator('#status[data-state="connected"]').waitFor();
    await mkdir(path.join(out, lang), { recursive: true });
    await page.screenshot({ path: path.join(out, lang, "options-1280x800.png") });
  } finally {
    await browser.close();
  }
}

const font = async (name) =>
  `data:font/woff2;base64,${(await readFile(path.join(built.unpacked.chrome, "fonts", name))).toString("base64")}`;
const [latin, cyrillic] = [await font("inter-latin-wght-normal.woff2"), await font("inter-cyrillic-wght-normal.woff2")];
const mark = (size, color) => `
  <svg width="${(size * 18) / 24}" height="${size}" viewBox="0 0 18 24" fill="none">
    <path d="M0 121V30C0 21.7 2.93 14.6 8.79 8.79 14.6 2.93 21.7 0 30 0s15.4 2.93 21.2 8.79C57.1 14.6 60 21.7 60 30v11c10 8.67 10 17.5 0 26.5-10 8.67-10 17.5 0 26.5 10 9 10 18 0 27"
      transform="translate(2.87 1) scale(0.1819)" stroke="${color}" stroke-width="${(2.73 * size) / 24}"
      vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
const fontFace = `
  @font-face { font-family: Inter; src: url("${latin}") format("woff2"); font-weight: 100 900; }
  @font-face { font-family: Inter; src: url("${cyrillic}") format("woff2"); font-weight: 100 900; unicode-range: U+0400-04FF; }
  * { margin: 0; box-sizing: border-box; }
  body { font-family: Inter, sans-serif; }`;
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
        </style><div class="brand">${mark(52, "#fffefa")}netami pin</div><p>${tagline[lang]}</p>`);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: path.join(out, lang, "promo-440x280.png") });
    }
    await page.setViewportSize({ width: 300, height: 300 });
    await page.setContent(`<style>${fontFace}
      body { width: 300px; height: 300px; background: #2f6b4f; display: grid; place-items: center; }
      </style>${mark(180, "#fffefa")}`);
    await page.screenshot({ path: path.join(out, "logo-300x300.png") });
  } finally {
    await browser.close();
  }
}

try {
  await options("en");
  await options("ru");
  await images();
  console.log(`Store images: ${out}`);
} finally {
  apps.stop();
  execFileSync("reg", ["delete", KEY, "/f"], { stdio: "ignore" });
}
