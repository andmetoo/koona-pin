// Pages of pin.netami.app as HTML strings. No scripts: language and theme work without JS.
import { FEEDBACK_ENDPOINT, ORIGIN, SUPPORT } from "./content.mjs";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Lucide icons (ISC), 24-grid; drawn at 20 px with a 1.5 px stroke as in the app.
const ICON = {
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  pointer: '<path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/><path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"/>',
  drive: '<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>',
  userx: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" x2="22" y1="8" y2="13"/><line x1="22" x2="17" y1="8" y2="13"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  swap: '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
};
const icon = (name, cls = "icon") =>
  `<svg class="${cls}" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON[name]}</svg>`;

/** Paths of one page in both languages: "/" and "/ru/", "/privacy" and "/ru/privacy". */
const href = (lang, page) => (lang === "en" ? `/${page}` : `/ru/${page}`);

function mascot(size, cls = "mascot") {
  const h = Math.round((size * 916) / 880);
  return `<picture class="${cls}"><source srcset="/brand/pin-spirit-mint.svg" media="(prefers-color-scheme: dark)"><img src="/brand/pin-spirit.svg" width="${size}" height="${h}" alt=""></picture>`;
}

function shot(lang, view, alt, { eager = false, sizes } = {}) {
  // English and Russian screenshots in light; English dark for both (Russian dark is not shot).
  const set = (name) => `/shots/${name}-1280.webp 1280w, /shots/${name}.webp 1920w`;
  const light = `app-${lang}-light-${view}`;
  const dark = `app-${lang === "ru" ? "en" : lang}-dark-${view}`;
  return `<picture><source srcset="${set(dark)}" sizes="${sizes}" media="(prefers-color-scheme: dark)"><img src="/shots/${light}-1280.webp" srcset="${set(light)}" sizes="${sizes}" width="1280" height="800" alt="${esc(alt)}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async"></picture>`;
}

function head(t, { page, title, description, extra = "" }) {
  const path = href(t.lang, page);
  const other = t.lang === "en" ? "ru" : "en";
  return `<!doctype html>
<html lang="${t.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#faf9f6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#22221f" media="(prefers-color-scheme: dark)">
<link rel="canonical" href="${ORIGIN}${path}">
<link rel="alternate" hreflang="en" href="${ORIGIN}${href("en", page)}">
<link rel="alternate" hreflang="ru" href="${ORIGIN}${href("ru", page)}">
<link rel="alternate" hreflang="x-default" href="${ORIGIN}${href("en", page)}">
<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/brand/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
<link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/site.css">${extra}
<meta property="og:type" content="website">
<meta property="og:site_name" content="Netami Pin">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${ORIGIN}${path}">
<meta property="og:image" content="${ORIGIN}/shots/og-${t.lang}.jpg">
<meta property="og:locale" content="${t.lang === "en" ? "en_US" : "ru_RU"}">
<meta property="og:locale:alternate" content="${other === "en" ? "en_US" : "ru_RU"}">
</head>
<body>
<a class="skip" href="#main">${esc(t.skip)}</a>`;
}

function header(t, { page, wordmark, current }) {
  const lang = (code) =>
    code === t.lang
      ? `<span class="lang-option" aria-current="true">${code.toUpperCase()}</span>`
      : `<a class="lang-option" href="${href(code, page)}" hreflang="${code}" lang="${code}">${code.toUpperCase()}</a>`;
  const nav = [
    ["how", `${href(t.lang, "")}#how`],
    ["privacy", href(t.lang, "privacy")],
    ["download", `${href(t.lang, "")}#download`],
  ]
    .map(([k, url]) => `<a href="${url}"${current === k ? ' aria-current="page"' : ""}>${esc(t.nav[k])}</a>`)
    .join("");
  return `<header class="top">
<div class="wrap top-row">
<a class="logo" href="${href(t.lang, "")}" aria-label="Netami Pin">${mascot(36)}<span class="wordmark" aria-hidden="true">${wordmark}</span></a>
<nav class="top-nav" aria-label="${t.lang === "en" ? "Main" : "Основное"}">${nav}</nav>
<div class="lang" role="group" aria-label="${esc(t.langSwitch)}">${lang("en")}${lang("ru")}</div>
</div>
</header>`;
}

function footer(t, wordmark) {
  return `<footer class="foot">
<div class="wrap">
<div class="foot-row">
<a class="logo logo-small" href="${href(t.lang, "")}" aria-label="Netami Pin">${mascot(24)}<span class="wordmark" aria-hidden="true">${wordmark}</span></a>
<nav class="foot-nav" aria-label="${t.lang === "en" ? "Site" : "Сайт"}">
<a href="${href(t.lang, "privacy")}">${esc(t.footer.privacy)}</a>
<a href="${href(t.lang, "licenses")}">${esc(t.footer.licenses)}</a>
${FEEDBACK_ENDPOINT ? `<a href="${href(t.lang, "feedback")}">${esc(t.footer.support)}</a>` : `<a href="${SUPPORT}" rel="noopener">${esc(t.footer.support)}</a>`}
</nav>
</div>
<div class="foot-row foot-small"><span>© 2026 Netami</span></div>
</div>
</footer>
</body>
</html>
`;
}

const soon = (t) => `<span class="soon">${icon("clock")}<span>${esc(t.soon)}</span></span>`;

export function landing(t, { wordmark }) {
  const pillarIcons = ["pointer", "drive", "userx"];
  const insideIcons = ["inbox", "search", "folder", "trash", "swap"];
  return `${head(t, { page: "", title: t.title, description: t.description })}
${header(t, { page: "", wordmark })}
<main id="main">
<section class="hero wrap">
<h1>${t.h1.map(esc).join("<br>")}</h1>
<p class="sub">${esc(t.sub)}</p>
<div class="actions">${soon(t)}<a class="button" href="#how">${esc(t.how)}</a></div>
<p class="meta">${t.meta.map(esc).join('<span aria-hidden="true"> · </span>')}</p>
<figure class="shot shot-hero">${shot(t.lang, "grid", t.shotAlt, { eager: true, sizes: "(min-width: 1440px) 1200px, (min-width: 900px) 84vw, 640px" })}</figure>
</section>
<section class="pillars wrap" aria-label="${t.lang === "en" ? "Why Netami Pin" : "Почему Netami Pin"}">
${t.pillars
  .map(([h, p], i) => `<article class="card pillar"><span class="well">${icon(pillarIcons[i])}</span><h2>${esc(h)}</h2><p>${esc(p)}</p></article>`)
  .join("\n")}
</section>
<section class="how wrap" id="how">
<h2 class="section-title center">${esc(t.howTitle)}</h2>
<ol class="steps">
${t.steps.map(([h, p], i) => `<li><span class="num" aria-hidden="true">${i + 1}</span><div><h3>${esc(h)}</h3><p>${esc(p)}</p></div></li>`).join("\n")}
</ol>
</section>
<section class="inside wrap">
<div>
<h2 class="section-title">${esc(t.insideTitle)}</h2>
<ul class="features">
${t.inside.map(([h, p], i) => `<li>${icon(insideIcons[i])}<div><h3>${esc(h)}</h3><p>${esc(p)}</p></div></li>`).join("\n")}
</ul>
</div>
<figure class="shot shot-list">${shot(t.lang, "list", t.listAlt, { sizes: "(min-width: 900px) 620px, 100vw" })}</figure>
</section>
<section class="browsers wrap">
<h2>${esc(t.browsersTitle)}</h2>
<ul class="chips">${t.browsers.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
</section>
<section class="wrap">
<div class="privacy-panel">
<div>
<h2>${esc(t.privacyTitle)}</h2>
<p>${esc(t.privacyBody)}</p>
<a class="more" href="${href(t.lang, "privacy")}">${esc(t.privacyLink)}${icon("arrowRight", "icon icon-small")}</a>
</div>
<ul class="facts">${t.privacyFacts.map((f) => `<li>${icon("check")}<span>${esc(f)}</span></li>`).join("")}</ul>
</div>
</section>
<section class="wrap" id="download">
<div class="card download">
${mascot(72, "mascot mascot-large")}
<h2>${esc(t.dlTitle)}</h2>
<p>${esc(t.dlBody)}</p>
${soon(t)}
<ul class="req">
${t.req.map(([a, b], i) => `<li>${icon(i === 0 ? "monitor" : "globe")}<div><strong>${esc(a)}</strong><span>${esc(b)}</span></div></li>`).join("\n")}
</ul>
</div>
</section>
</main>
${footer(t, wordmark)}`;
}

function textPage(t, { page, title, body, wordmark, current, extra }) {
  return `${head(t, { page, title: `${title} — Netami Pin`, description: t.description, extra })}
${header(t, { page, wordmark, current })}
<main id="main" class="wrap text-page">
<a class="back" href="${href(t.lang, "")}">${icon("arrowLeft", "icon icon-small")}${esc(t.back)}</a>
${body}
</main>
${footer(t, wordmark)}`;
}

/** The privacy policy from extension/store/privacy.md: one language section, **Heading.** paragraphs. */
export function privacy(t, { markdown, wordmark }) {
  const part = markdown.split(/^## /m).find((p) => p.startsWith(t.privacyPage.section));
  const paras = part.split("\n").slice(1).map((l) => l.trim()).filter((l) => l && l !== "---");
  const link = (s) => esc(s).replace(/https:\/\/pin\.netami\.app\/?/g, (u) => `<a href="${u}">${u}</a>`);
  const body = paras
    .map((p) => {
      const m = p.match(/^\*\*(.+?)\*\*\s*(.*)$/);
      if (!m) return `<p class="lead">${link(p)}</p>`;
      return `<h2>${esc(m[1].replace(/\.$/, ""))}</h2>\n<p>${link(m[2])}</p>`;
    })
    .join("\n");
  return textPage(t, {
    page: "privacy",
    current: "privacy",
    wordmark,
    title: t.privacyPage.title,
    body: `<h1>${esc(t.privacyPage.title)}</h1>\n<p class="updated">${esc(t.privacyPage.updated)}</p>\n${body}`,
  });
}

export function licenses(t, { wordmark }) {
  const l = t.licenses;
  const body = `<h1>${esc(l.title)}</h1>
<p class="lead">${esc(l.lead)}</p>
${l.items.map(([name, text, url]) => `<h2>${esc(name)}</h2>\n<p>${esc(text)} <a href="${url}" rel="noopener">${esc(url.replace(/^https:\/\//, ""))}</a></p>`).join("\n")}
<p>${esc(l.app)}</p>`;
  return textPage(t, { page: "licenses", wordmark, title: l.title, body });
}

export function notFound(t, { wordmark }) {
  const n = t.notFound;
  return textPage(t, {
    page: "",
    wordmark,
    title: n.title,
    body: `<h1>${esc(n.title)}</h1>\n<p class="lead">${esc(n.body)}</p>\n<p><a href="${href(t.lang, "")}">${esc(n.home)}</a></p>`,
  });
}

/**
 * The feedback form (NP-088): a plain form posted straight to the Edge Function, which sends
 * the browser back to /feedback/sent, /limit or /error. No scripts; a hidden field catches bots.
 */
export function feedback(t, { wordmark }) {
  const f = t.feedback;
  const kinds = Object.entries(f.kinds)
    .map(([value, label], i) => `<label><input type="radio" name="kind" value="${value}"${i === 0 ? " checked" : ""}> ${esc(label)}</label>`)
    .join("\n");
  const body = `<h1>${esc(f.title)}</h1>
<p class="lead">${esc(f.lead)}</p>
<form class="feedback" method="post" action="${esc(FEEDBACK_ENDPOINT)}" accept-charset="utf-8">
<input type="hidden" name="lang" value="${t.lang}">
<fieldset class="kinds">
<legend>${esc(f.kind)}</legend>
${kinds}
</fieldset>
<label class="field-label" for="fb-message">${esc(f.message)}</label>
<textarea id="fb-message" name="message" rows="8" maxlength="5000" required placeholder="${esc(f.placeholder)}"></textarea>
<label class="field-label" for="fb-email">${esc(f.email)}</label>
<input id="fb-email" type="email" name="email" maxlength="254" autocomplete="email" placeholder="name@example.com">
<div class="trap" aria-hidden="true"><label for="fb-trap">${esc(f.trap)}</label><input id="fb-trap" name="hp_7q" tabindex="-1" autocomplete="off"></div>
<p class="form-note">${esc(f.note)} <a href="${href(t.lang, "privacy")}">${esc(f.privacy)}</a></p>
<p><button class="button button-primary" type="submit">${esc(f.send)}</button></p>
</form>
<p>${esc(f.app)}</p>
<p><a href="${SUPPORT}" rel="noopener">${esc(f.github)}</a></p>`;
  // The site sends Referrer-Policy: same-origin, under which a POST to Supabase would carry
  // `Origin: null`; this page lets the browser name the site, which the function checks.
  const extra = `\n<meta name="referrer" content="strict-origin-when-cross-origin">`;
  return textPage(t, { page: "feedback", wordmark, title: f.title, body, extra });
}

/** Where the function sends the browser: sent, limit or error. */
export function feedbackResult(t, { wordmark, outcome }) {
  const f = t.feedback;
  const r = f[outcome];
  const back = outcome === "sent" ? "" : `\n<p><a href="${href(t.lang, "feedback")}">${esc(f.again)}</a></p>`;
  return textPage(t, {
    page: `feedback/${outcome}`,
    wordmark,
    title: r.title,
    body: `<h1>${esc(r.title)}</h1>\n<p class="lead">${esc(r.body)}</p>${back}`,
  });
}
