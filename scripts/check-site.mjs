// Checks of pin.netami.app (NP-079 acceptance): every page at 360, 390, 1440 and 1920 in both
// themes and languages — no horizontal scroll, no requests to other origins, no cookies, no
// broken links between pages, the Russian redirect of "/". Screenshots go to test-results/site.
//   node scripts/build-site.mjs && node scripts/check-site.mjs
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { publish } from "./lib/paths.mjs";

const root = path.resolve(import.meta.dirname, "..");
const shots = path.join(root, "test-results", "site");
const port = 4317;
const base = `http://127.0.0.1:${port}`;
const pages = ["/", "/privacy", "/licenses", "/ru/", "/ru/privacy", "/ru/licenses", "/nowhere", "/ru/nowhere"];
// The feedback form and its result pages, when the build had the function's address (NP-088).
if (existsSync(path.join(publish.site, "feedback", "index.html")))
  pages.push(...["/feedback", "/feedback/sent", "/feedback/limit", "/feedback/long", "/feedback/origin", "/feedback/error"].flatMap((p) => [p, `/ru${p}`]));
const widths = [360, 390, 1440, 1920];

const server = spawn(process.execPath, ["scripts/serve-site.mjs", String(port)], { cwd: root, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 600));
await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
const problems = [];
const links = new Set();
try {
  for (const scheme of ["light", "dark"]) {
    for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, locale: "en-US" });
      const page = await context.newPage();
      const foreign = [];
      page.on("request", (r) => {
        if (!r.url().startsWith(base)) foreign.push(r.url());
      });
      let current = "";
      // A 404 page logs its own status; other errors count.
      page.on("console", (m) => m.type() === "error" && !current.includes("nowhere") && problems.push(`${current} ${width} ${scheme}: console: ${m.text()}`));
      for (const p of pages) {
        current = p;
        const res = await page.goto(base + p, { waitUntil: "networkidle" });
        const expected = p.includes("nowhere") ? 404 : 200;
        if (res.status() !== expected) problems.push(`${p}: status ${res.status()}, expected ${expected}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 0) problems.push(`${p} at ${width} ${scheme}: horizontal scroll ${overflow}px`);
        const broken = await page.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src));
        broken.forEach((src) => problems.push(`${p}: image not loaded ${src}`));
        if (!p.includes("nowhere")) (await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.href))).forEach((h) => links.add(h));
        if (!p.includes("nowhere")) {
          const name = `${(p.replace(/\//g, "_") || "_").replace(/^_|_$/g, "") || "en"}-${width}-${scheme}.png`;
          await page.screenshot({ path: path.join(shots, name), fullPage: true });
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
      if (posted.origin !== base) problems.push(`feedback form: Origin is ${posted.origin}, expected ${base}`);
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
  // A Russian browser opening "/" goes to /ru/; a click on EN from /ru/ stays English.
  const ru = await browser.newContext({ locale: "ru-RU", extraHTTPHeaders: { "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8" } });
  const rp = await ru.newPage();
  await rp.goto(base + "/");
  if (!rp.url().endsWith("/ru/")) problems.push(`Russian browser on "/" stays at ${rp.url()}`);
  await rp.getByRole("link", { name: "EN", exact: true }).click();
  await rp.waitForLoadState();
  if (new URL(rp.url()).pathname !== "/") problems.push(`EN from /ru/ leads to ${rp.url()}`);
  console.log("outside links:", [...new Set(outside)].join("\n  "));
} finally {
  await browser.close();
  server.kill();
}
console.log(problems.length ? `PROBLEMS:\n${problems.join("\n")}` : "site checks passed");
console.log(`screenshots: ${shots}`);
process.exitCode = problems.length ? 1 : 0;
