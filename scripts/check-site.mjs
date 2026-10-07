// Checks of koona.app/pin/ (NP-079, NP-107 acceptance): every page of every language at 360, 390,
// 1440 and 1920 in both themes — no horizontal scroll, no clipped labels, no requests to other
// origins, no cookies, no broken links between pages; the language menu opens inside the screen;
// the first visit of /pin/ goes to the browser's language. Screenshots of en, ru, de, sr and ja go
// to test-results/site.
//   node scripts/build-site.mjs && node scripts/check-site.mjs
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { BASE, languages } from "../site/src/content.mjs";
import { publish } from "./lib/paths.mjs";

const root = path.resolve(import.meta.dirname, "..");
const shots = path.join(root, "test-results", "site");
const port = 4317;
const origin = `http://127.0.0.1:${port}`;
// Pages below are relative to the site, which lives at /pin/ (Р-47).
const base = `${origin}${BASE}`;
const own = ["", "privacy", "licenses", "nowhere"];
// The feedback form and its result pages, when the build had the function's address (NP-088).
if (existsSync(path.join(publish.site, "feedback", "index.html")))
  own.push("feedback", "feedback/sent", "feedback/limit", "feedback/long", "feedback/origin", "feedback/error");
const pages = languages.flatMap((l) => own.map((p) => ({ path: `/${l.dir}${p}`, lang: l.lang, home: p === "" })));
// Screenshots to look at: English, Russian, the longest (German), Serbian and Japanese (NP-090).
const shown = new Set(["en", "ru", "de", "sr-Latn", "ja"]);
const widths = [360, 390, 1440, 1920];

// The Caddyfile answers 404 in every language the site has.
const caddy = await readFile(path.join(root, "site/Caddyfile"), "utf8");
const notFound = caddy.match(/path_regexp language \^\/\(([^)]+)\)\//)?.[1].split("|") ?? [];
const dirs = languages.map((l) => l.dir.slice(0, -1)).filter(Boolean);
const startProblems = dirs.filter((d) => !notFound.includes(d)).map((d) => `site/Caddyfile: no 404 page for /${d}/`);

const server = spawn(process.execPath, ["scripts/serve-site.mjs", String(port)], { cwd: root, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 600));
await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
const problems = [...startProblems];
const links = new Set();
/** Boxes that cut their text: a label that does not fit its button, chip or menu row. */
const clipped = () =>
  [...document.querySelectorAll("body *")]
    // Not the screenshots (cropped on purpose) and not what is hidden on purpose (the bot trap).
    .filter((e) => !e.closest('figure, [aria-hidden="true"]') && e.checkVisibility() && getComputedStyle(e).overflowX !== "visible" && e.scrollWidth > e.clientWidth + 1)
    .map((e) => `${e.tagName.toLowerCase()}.${e.className} «${e.textContent.trim().slice(0, 40)}»`);
try {
  for (const scheme of ["light", "dark"]) {
    for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, locale: "en-US" });
      const page = await context.newPage();
      const foreign = [];
      page.on("request", (r) => {
        if (!r.url().startsWith(origin)) foreign.push(r.url());
      });
      let current = "";
      // A 404 page logs its own status; other errors count.
      page.on("console", (m) => m.type() === "error" && !current.includes("nowhere") && problems.push(`${current} ${width} ${scheme}: console: ${m.text()}`));
      for (const { path: p, lang, home } of pages) {
        current = p;
        const res = await page.goto(base + p, { waitUntil: "load" });
        const expected = p.includes("nowhere") ? 404 : 200;
        if (res.status() !== expected) problems.push(`${p}: status ${res.status()}, expected ${expected}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 0) problems.push(`${p} at ${width} ${scheme}: horizontal scroll ${overflow}px`);
        (await page.evaluate(clipped)).forEach((c) => problems.push(`${p} at ${width} ${scheme}: clipped ${c}`));
        const broken = await page.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src));
        broken.forEach((src) => problems.push(`${p}: image not loaded ${src}`));
        if (!p.includes("nowhere")) (await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.href))).forEach((h) => links.add(h));
        if (!p.includes("nowhere") && shown.has(lang)) {
          const name = `${(p.replace(/\//g, "_") || "_").replace(/^_|_$/g, "") || "en"}-${width}-${scheme}.png`;
          await page.screenshot({ path: path.join(shots, name), fullPage: true });
        }
        // The language menu of the home page opens on hover, inside the screen, its rows uncut.
        if (home) {
          await page.hover(".lang-button");
          const menu = await page.locator(".lang-menu").boundingBox();
          if (!menu) problems.push(`${p} at ${width} ${scheme}: the language menu does not open on hover`);
          else if (menu.x < 0 || menu.x + menu.width > width) problems.push(`${p} at ${width} ${scheme}: the language menu leaves the screen (${Math.round(menu.x)}…${Math.round(menu.x + menu.width)})`);
          (await page.evaluate(clipped)).forEach((c) => problems.push(`${p} at ${width} ${scheme}, menu open: clipped ${c}`));
          if (shown.has(lang)) await page.screenshot({ path: path.join(shots, `${lang}-menu-${width}-${scheme}.png`) });
          await page.mouse.move(0, 0);
        }
      }
      if ((await context.cookies()).length) problems.push(`${width} ${scheme}: cookies set`);
      if (foreign.length) problems.push(`${width} ${scheme}: requests to other origins: ${[...new Set(foreign)].join(", ")}`);
      await context.close();
    }
  }
  // The feedback form really submits (NP-088): the CSP lets it post to the function and lets
  // the function's 303 back to /feedback/sent, and the browser names the site in Origin
  // (the site's own Referrer-Policy would make it `null`). The function is faked here.
  const form = path.join(publish.site, "feedback", "index.html");
  if (existsSync(form)) {
    const action = (await readFile(form, "utf8")).match(/<form[^>]* action="([^"]+)"/)?.[1];
    const fp = await browser.newPage();
    const refused = [];
    fp.on("console", (m) => m.type() === "error" && refused.push(m.text()));
    let posted = null;
    await fp.route(action, (route) => {
      posted = { origin: route.request().headers()["origin"], body: route.request().postData() };
      return route.fulfill({ status: 303, headers: { location: `${base}/feedback/sent` } });
    });
    await fp.goto(`${base}/feedback`);
    await fp.getByRole("radio", { name: "Idea" }).check();
    await fp.getByLabel("Message").fill("Feedback form check");
    await fp.getByRole("button", { name: "Send" }).click();
    await fp.waitForURL(`${base}/feedback/sent`, { timeout: 5000 }).catch(() => {});
    if (!posted) problems.push("feedback form: nothing was posted to the function");
    else {
      if (posted.origin !== origin) problems.push(`feedback form: Origin is ${posted.origin}, expected ${origin}`);
      const fields = new URLSearchParams(posted.body);
      if (fields.get("kind") !== "idea" || fields.get("message") !== "Feedback form check" || fields.get("lang") !== "en" || fields.get("hp_7q") !== "")
        problems.push(`feedback form: posted ${posted.body}`);
    }
    if (!fp.url().endsWith("/feedback/sent")) problems.push(`feedback form: ended at ${fp.url()} ${refused.join(" ")}`);
    await fp.close();
  }
  // Links inside the site lead somewhere; outside links are listed for a look.
  const outside = [];
  const page = await browser.newPage();
  for (const h of links) {
    if (!h.startsWith(base)) {
      outside.push(h);
      continue;
    }
    const res = await page.request.get(h.split("#")[0]);
    if (res.status() !== 200) problems.push(`link ${h}: ${res.status()}`);
  }
  // The first visit of /pin/ goes to the browser's first language, by script and region as the
  // app's matchLanguage; languages the site lacks stay English.
  const welcome = {
    "de-AT,de;q=0.9": "de/", "es-419": "es/", "fr-CH,fr": "fr/", "it": "it/", "pl-PL": "pl/", "pt-PT": "pt-br/", "pt-BR": "pt-br/",
    "ru-RU,ru;q=0.9,en;q=0.8": "ru/", "sr-RS": "sr/", "sr-Latn-RS": "sr/", "sr-ME": "sr/", "tr-TR": "tr/",
    "uk-UA": "uk/", "en-US,de;q=0.9": "", "he-IL": "", "be-BY,ru;q=0.8": "",
    "ja-JP": "ja/", "ko-KR,ko;q=0.9": "ko/", "zh-CN,zh;q=0.9": "zh-cn/", "zh": "zh-cn/", "zh-Hans-SG": "zh-cn/", "zh-TW,zh;q=0.9": "", "zh-HK": "", "zh-Hant": "",
  };
  for (const [accept, dir] of Object.entries(welcome)) {
    const res = await fetch(`${base}/`, { headers: { "Accept-Language": accept }, redirect: "manual" });
    const to = res.headers.get("location") ?? `${BASE}/`;
    if (to !== `${BASE}/${dir}`) problems.push(`Accept-Language ${accept}: ${BASE}/ leads to ${to}, expected ${BASE}/${dir}`);
  }
  for (const l of languages.filter((l) => l.dir)) if (!Object.values(welcome).includes(l.dir)) problems.push(`no redirect check for ${l.dir}`);
  // A chosen language stays: English from the menu of /pin/ru/ opens /pin/ in a Russian browser.
  const ru = await browser.newContext({ locale: "ru-RU", extraHTTPHeaders: { "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8" } });
  const rp = await ru.newPage();
  await rp.goto(base + "/");
  if (!rp.url().endsWith(`${BASE}/ru/`)) problems.push(`Russian browser on ${BASE}/ stays at ${rp.url()}`);
  await rp.hover(".lang-button");
  await rp.locator('.lang-list a[hreflang="en"]').click();
  await rp.waitForLoadState();
  if (new URL(rp.url()).pathname !== `${BASE}/`) problems.push(`English from ${BASE}/ru/ leads to ${rp.url()}`);
  // The keyboard opens the menu too: Tab to the button, Tab again to the first language.
  await rp.goto(base + "/privacy");
  await rp.focus(".lang-button");
  await rp.keyboard.press("Tab");
  const focused = await rp.evaluate(() => document.activeElement?.closest(".lang-list") && document.activeElement.getAttribute("hreflang"));
  if (focused !== languages[0].lang) problems.push(`Tab from the language button reaches ${focused}, expected ${languages[0].lang}`);
  console.log("outside links:", [...new Set(outside)].join("\n  "));
} finally {
  await browser.close();
  server.kill();
}
console.log(problems.length ? `PROBLEMS:\n${problems.join("\n")}` : "site checks passed");
console.log(`screenshots: ${shots}`);
process.exitCode = problems.length ? 1 : 0;
