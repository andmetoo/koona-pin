// Pages of koona.app/pin as HTML strings. No scripts: language and theme work without JS.
import { existsSync } from "node:fs";
import { BASE, content, FEEDBACK_ENDPOINT, languages, nameIn, ORIGIN, SITE, SUPPORT } from "./content.mjs";
import { megabytes } from "./release.mjs";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Lucide icons (ISC), 24-grid; drawn at 20 px with a 1.5 px stroke as in the app.
const ICON = {
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
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
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
};
const icon = (name, cls = "icon") =>
  `<svg class="${cls}" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON[name]}</svg>`;

/** Path of a page in a language: "/pin/", "/pin/de/", "/pin/privacy", "/pin/sr-latn/privacy". */
const href = (lang, page) => `${BASE}/${content[lang].dir}${page}`;

/** A file of the site in the page's language, else the English one: shots exist for en and ru only. */
const localized = (name, lang) => (existsSync(new URL(`./shots/${name.replace("{lang}", lang)}`, import.meta.url)) ? name.replace("{lang}", lang) : name.replace("{lang}", "en"));

function mascot(size, cls = "mascot") {
  const h = Math.round((size * 916) / 880);
  return `<picture class="${cls}"><source srcset="${BASE}/brand/pin-spirit-mint.svg" media="(prefers-color-scheme: dark)"><img src="${BASE}/brand/pin-spirit.svg" width="${size}" height="${h}" alt=""></picture>`;
}

function shot(lang, view, alt, { eager = false, sizes } = {}) {
  // The app in the page's language where it was shot (English and Russian light, English dark),
  // English otherwise.
  const set = (name) => `${BASE}/shots/${name}-1280.webp 1280w, ${BASE}/shots/${name}.webp 1920w`;
  const light = localized(`app-{lang}-light-${view}.webp`, lang).slice(0, -5);
  const dark = localized(`app-{lang}-dark-${view}.webp`, lang).slice(0, -5);
  return `<picture><source srcset="${set(dark)}" sizes="${sizes}" media="(prefers-color-scheme: dark)"><img src="${BASE}/shots/${light}-1280.webp" srcset="${set(light)}" sizes="${sizes}" width="1280" height="800" alt="${esc(alt)}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async"></picture>`;
}

function head(t, { page, title, description, extra = "", english = false }) {
  const path = href(t.lang, page);
  // Pages in English only (NP-040: downloads, changelog) name no other languages.
  const others = english ? [] : languages;
  const alternates = others.map((l) => `<link rel="alternate" hreflang="${l.lang}" href="${ORIGIN}${href(l.lang, page)}">`).join("\n");
  const ogAlternates = others.filter((l) => l.og !== t.og).map((l) => `<meta property="og:locale:alternate" content="${l.og}">`);
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
${english ? "" : `${alternates}\n<link rel="alternate" hreflang="x-default" href="${ORIGIN}${href("en", page)}">`}
<link rel="icon" href="${BASE}/brand/favicon.svg" type="image/svg+xml">
<link rel="icon" href="${BASE}/brand/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="${BASE}/brand/apple-touch-icon.png">
<link rel="preload" href="${BASE}/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${BASE}/site.css">${extra}
<meta property="og:type" content="website">
<meta property="og:site_name" content="Koona Pin">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${ORIGIN}${path}">
<meta property="og:image" content="${SITE}/shots/${localized("og-{lang}.jpg", t.lang)}">
<meta property="og:locale" content="${t.og}">
${[...new Set(ogAlternates)].join("\n")}
</head>
<body>
<a class="skip" href="#main">${esc(t.skip)}</a>`;
}

function header(t, { page, wordmark, current, english = false }) {
  // The language menu (NP-107): CSS opens it on hover and while focus is inside (keyboard, a tap).
  // Each language is a link to this page in it: its own name, then its name in this page's language.
  const lang = (l) => {
    const current = l.lang === t.lang;
    return `<li><a href="${href(l.lang, page)}" hreflang="${l.lang}"${current ? ' aria-current="true"' : ""}><span class="lang-own" lang="${l.lang}">${esc(l.name)}</span><span class="lang-local">${esc(nameIn(t.lang, l.lang))}</span>${current ? icon("check", "icon icon-small") : ""}</a></li>`;
  };
  const menu = `<div class="lang">
<button class="lang-button" type="button" aria-label="${esc(`${t.langSwitch}: ${t.name}`)}">${icon("globe", "icon icon-small")}<span class="lang-full">${esc(t.name)}</span><span class="lang-short">${t.short}</span>${icon("chevronDown", "icon icon-small")}</button>
<div class="lang-menu">
<p class="lang-title" id="lang-title">${esc(t.langSwitch)}</p>
<ul class="lang-list" aria-labelledby="lang-title">
${languages.map(lang).join("\n")}
</ul>
</div>
</div>`;
  const nav = [
    ["how", `${href(t.lang, "")}#how`],
    ["privacy", href(t.lang, "privacy")],
    ["download", `${href(t.lang, "")}#download`],
  ]
    .map(([k, url]) => `<a href="${url}"${current === k ? ' aria-current="page"' : ""}>${esc(t.nav[k])}</a>`)
    .join("");
  return `<header class="top">
<div class="wrap top-row">
<a class="logo" href="${href(t.lang, "")}" aria-label="Koona Pin">${mascot(36)}<span class="wordmark" aria-hidden="true">${wordmark}</span></a>
<nav class="top-nav" aria-label="${esc(t.labels.main)}">${nav}</nav>
${english ? "" : menu}
</div>
</header>`;
}

function footer(t, wordmark, current) {
  // The changelog is in English only (NP-040): every language links the one page.
  return `<footer class="foot">
<div class="wrap">
<div class="foot-row">
<a class="logo logo-small" href="${href(t.lang, "")}" aria-label="Koona Pin">${mascot(24)}<span class="wordmark" aria-hidden="true">${wordmark}</span></a>
<nav class="foot-nav" aria-label="${esc(t.labels.site)}">
<a href="${BASE}/changelog/" hreflang="en"${current === "changelog" ? ' aria-current="page"' : ""}>${esc(t.footer.changelog)}</a>
<a href="${href(t.lang, "privacy")}">${esc(t.footer.privacy)}</a>
<a href="${href(t.lang, "licenses")}">${esc(t.footer.licenses)}</a>
${FEEDBACK_ENDPOINT ? `<a href="${href(t.lang, "feedback")}">${esc(t.footer.support)}</a>` : `<a href="${SUPPORT}" rel="noopener">${esc(t.footer.support)}</a>`}
</nav>
</div>
<div class="foot-row foot-small"><span>© 2026 Koona</span></div>
</div>
</footer>
</body>
</html>
`;
}

const soon = (t) => `<span class="soon">${icon("clock")}<span>${esc(t.soon)}</span></span>`;

/** «9 October 2026» in the page's language, from YYYY-MM-DD; English days come first, as on the rest of the site. */
const day = (lang, iso) => new Intl.DateTimeFormat(lang === "en" ? "en-GB" : lang, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));

/** The landing's download block with files (NP-040), or the «coming soon» one without a release. */
function downloadBlock(t, rel, firefox) {
  const req = `<ul class="req">
${t.req.map(([a, b], i) => `<li>${icon(["monitor", "terminal", "globe"][i])}<div><strong>${esc(a)}</strong><span>${esc(b)}</span></div></li>`).join("\n")}
</ul>`;
  if (!rel) return `<div class="card download">
${mascot(72, "mascot mascot-large")}
<h2>${esc(t.dlTitle)}</h2>
<p>${esc(t.dlBody)}</p>
${soon(t)}
${req}
</div>`;
  const d = t.dl;
  const quiet = (name) => `<span class="button button-quiet" aria-disabled="true">${name}<span class="ext-soon"> · ${esc(d.extSoon)}</span></span>`;
  return `<div class="card download">
${mascot(72, "mascot mascot-large")}
<h2>${esc(d.title)}</h2>
<p class="dl-version">${rel.version}<span aria-hidden="true"> · </span>${esc(day(t.lang, rel.date))}</p>
<div class="dl-actions">
<a class="button button-primary dl-windows" href="${rel.windows.url}" download>${icon("download", "icon icon-download")}${esc(d.windows)}</a>
<a class="button" href="${rel.deb.url}" download>${esc(d.deb)}</a>
<a class="button" href="${rel.rpm.url}" download>${esc(d.rpm)}</a>
</div>
<p class="dl-soon">${esc(d.soon)}</p>
<p class="dl-ext-title">${esc(d.extTitle)}</p>
<div class="dl-ext">${quiet("Chrome")}${quiet("Edge")}${firefox ? `<a class="button" href="${firefox}">Firefox</a>` : quiet("Firefox")}</div>
<p class="dl-ext-note">${esc(d.extSoonNote)}</p>
<a class="more" href="${BASE}/downloads/" hreflang="en">${esc(d.all)}${icon("arrowRight", "icon icon-small")}</a>
${req}
</div>`;
}

/** The three pillars as small scenes of the product itself (doc/site.md): drawn in HTML, words in the page's language. */
function scenes(t) {
  const s = t.scene;
  const size = `${new Intl.NumberFormat(t.lang).format(12.4)} ${s.mb}`;
  const art = [
    `<div class="win"><div class="tabs"><span class="tab on">Chrome</span><span class="tab">Edge</span><span class="tab">Firefox</span></div>
<div class="bar"><span class="url">example.com/a-good-read</span><span class="pin-btn"><img src="${BASE}/brand/favicon.svg" width="20" height="20" alt=""></span></div></div>
<div class="toast">${mascot(30, "")}<div><b>${esc(s.saved)}</b><span>${esc(s.inbox)}</span></div><span class="ok">${icon("check", "icon")}</span></div>`,
    `<div class="win"><p class="path">Koona › Pin</p>
<ul class="files"><li><span class="doc"></span>koonapin.db<em>${esc(size)}</em></li><li>${esc(s.backup)}<em>${esc(s.today)}</em></li><li>${esc(s.backup)}<em>${esc(s.yesterday)}</em></li></ul></div>
${mascot(72, "scene-mascot")}`,
    `<div class="oses">${[
      ["os-windows", "Windows", '<i class="os-ctl">–</i><i class="os-ctl">□</i><i class="os-ctl">×</i>'],
      ["os-linux", "Linux", '<i class="os-close">×</i>'],
      ["os-mac", "macOS", '<i class="os-dot"></i><i class="os-dot"></i><i class="os-dot"></i>'],
    ]
      .map(
        ([cls, name, bar]) =>
          `<div class="os ${cls}"><div class="win"><span class="os-bar">${bar}</span><span class="os-app"><span class="os-side"><img src="${BASE}/brand/favicon.svg" width="14" height="14" alt=""></span><span class="os-cards"><span></span><span></span><span></span><span></span></span></span></div><b>${name}</b></div>`,
      )
      .join("")}</div>`,
  ];
  const kinds = ["s-button", "s-disk", "s-os"];
  return t.pillars
    .map(([h, p], i) => `<article class="scene ${kinds[i]}"><div class="stage" aria-hidden="true">${art[i]}</div><h2>${esc(h)}</h2><p>${esc(p)}</p></article>`)
    .join("\n");
}

export function landing(t, { wordmark, release: rel = null, firefox = null }) {
  const insideIcons = ["inbox", "search", "folder", "trash", "swap"];
  return `${head(t, { page: "", title: t.title, description: t.description })}
${header(t, { page: "", wordmark })}
<main id="main">
<section class="hero wrap">
<h1>${t.h1.map(esc).join("<br>")}</h1>
<p class="sub">${esc(t.sub)}</p>
<div class="actions">${rel ? `<a class="button button-primary" href="#download">${icon("download", "icon icon-download")}${esc(t.download)}</a>` : soon(t)}<a class="button" href="#how">${esc(t.how)}</a></div>
<p class="meta">${t.meta.map(esc).join('<span aria-hidden="true"> · </span>')}</p>
<figure class="shot shot-hero">${shot(t.lang, "grid", t.shotAlt, { eager: true, sizes: "(min-width: 1440px) 1200px, (min-width: 900px) 84vw, 640px" })}</figure>
</section>
<section class="scenes wrap reveal" aria-label="${esc(t.labels.why)}">
${scenes(t)}
</section>
<section class="how wrap reveal" id="how">
<h2 class="section-title center">${esc(t.howTitle)}</h2>
<ol class="steps">
${t.steps.map(([h, p], i) => `<li><span class="num" aria-hidden="true">${i + 1}</span><div><h3>${esc(h)}</h3><p>${esc(p)}</p></div></li>`).join("\n")}
</ol>
</section>
<section class="inside wrap reveal">
<div>
<h2 class="section-title">${esc(t.insideTitle)}</h2>
<ul class="features">
${t.inside.map(([h, p], i) => `<li>${icon(insideIcons[i])}<div><h3>${esc(h)}</h3><p>${esc(p)}</p></div></li>`).join("\n")}
</ul>
</div>
<figure class="shot shot-list">${shot(t.lang, "list", t.listAlt, { sizes: "(min-width: 900px) 620px, 100vw" })}</figure>
</section>
<section class="wrap reveal">
<div class="privacy-panel">
<div>
<h2>${esc(t.privacyTitle)}</h2>
<p>${esc(t.privacyBody)}</p>
<a class="more" href="${href(t.lang, "privacy")}">${esc(t.privacyLink)}${icon("arrowRight", "icon icon-small")}</a>
</div>
<ul class="facts">${t.privacyFacts.map((f) => `<li>${icon("check")}<span>${esc(f)}</span></li>`).join("")}</ul>
</div>
</section>
<section class="wrap reveal" id="download">
${downloadBlock(t, rel, firefox)}
</section>
</main>
${footer(t, wordmark)}`;
}

function textPage(t, { page, title, body, wordmark, current, extra }) {
  return `${head(t, { page, title: `${title} — Koona Pin`, description: t.description, extra })}
${header(t, { page, wordmark, current })}
<main id="main" class="wrap text-page">
<a class="back" href="${href(t.lang, "")}">${icon("arrowLeft", "icon icon-small")}${esc(t.back)}</a>
${body}
</main>
${footer(t, wordmark)}`;
}

/** A page in English only, wider than the text pages: downloads and changelog (NP-040). */
function englishPage(t, { page, title, description, body, wordmark, current }) {
  return `${head(t, { page, title: `${title} — Koona Pin`, description, english: true })}
${header(t, { page, wordmark, current, english: true })}
<main id="main" class="wrap wide-page">
<a class="back" href="${href(t.lang, "")}">${icon("arrowLeft", "icon icon-small")}${esc(t.back)}</a>
${body}
</main>
${footer(t, wordmark, current)}`;
}

const chipSoon = `<span class="chip-soon">${icon("clock", "icon icon-small")}Coming soon</span>`;
const command = (text) => `<pre class="cmd"><code>${esc(text)}</code></pre>`;

/** /downloads/: every package of the newest release, the extensions, checks and help (sheet NP-040). */
export function downloads(t, { wordmark, release: rel, firefox }) {
  const file = (f) => `${esc(f.name)}<span aria-hidden="true"> · </span>${megabytes(f.size)}`;
  const pkg = (id, name, note, action, cmd) => `<div class="pkg" id="${id}">
<div class="pkg-head"><div><h3>${esc(name)}</h3><p>${note}</p></div>${action}</div>
${command(cmd)}
</div>`;
  const body = `<h1>Download Koona Pin</h1>
<p class="updated">${rel.version}<span aria-hidden="true"> · </span>${esc(day("en", rel.date))}<span aria-hidden="true"> · </span><a href="${BASE}/changelog/#${rel.version}">Changelog${icon("arrowRight", "icon icon-small")}</a></p>

<section class="card platform reveal" id="windows" aria-labelledby="windows-title">
<div class="platform-head"><h2 id="windows-title">${icon("monitor")}Windows</h2><p>Windows 11, 64-bit<span aria-hidden="true"> · </span>no administrator rights needed</p></div>
<div class="platform-file"><a class="button button-primary" href="${rel.windows.url}" download>${icon("download", "icon icon-download")}Download for Windows</a><span class="file-meta">${file(rel.windows)}</span></div>
<p class="note-amber">${icon("alert")}<span>Windows may say it protected your PC: the app is new and still building reputation. Choose <strong>More info</strong> → <strong>Run anyway</strong>.</span></p>
</section>

<section class="card platform reveal" id="linux" aria-labelledby="linux-title">
<div class="platform-head"><h2 id="linux-title">${icon("terminal")}Linux</h2><p>64-bit (x86_64)<span aria-hidden="true"> · </span>GNOME or KDE Plasma on Wayland</p></div>
${pkg("deb", "Ubuntu 26.04, Debian 13", `.deb · ${megabytes(rel.deb.size)}`, `<a class="button" href="${rel.deb.url}" download>Download .deb</a>`, `sudo apt install ./${rel.deb.name}`)}
${pkg("rpm", "Fedora 44", `.rpm · ${megabytes(rel.rpm.size)}`, `<a class="button" href="${rel.rpm.url}" download>Download .rpm</a>`, `sudo dnf install ./${rel.rpm.name}`)}
${pkg("aur", "Arch Linux", "AUR package koonapin-bin", chipSoon, "yay -S koonapin-bin")}
${pkg("appimage", "Other distributions", "AppImage · runs without installing", chipSoon, `chmod +x Koona_Pin-${rel.version}-x86_64.AppImage`)}
<h3 class="good">Good to know</h3>
<ul class="good-list">
<li>Koona Pin updates itself: it asks before installing, and the system asks for your password.</li>
<li>GNOME without the AppIndicator extension shows no tray icon. Koona Pin keeps running; open it from the app menu.</li>
<li>Firefox from Snap asks once to let the extension talk to Koona Pin.</li>
<li>Browsers installed from Flatpak can't save to Koona Pin yet.</li>
<li>Removing the package keeps your library in <code>~/.local/share/Koona/Pin</code>.</li>
</ul>
</section>

<section class="card platform platform-soon reveal" id="macos" aria-labelledby="macos-title">
<div class="platform-head"><h2 id="macos-title">${icon("monitor")}macOS</h2></div>
<p class="platform-body">Koona Pin for Mac is on its way.</p>
${chipSoon}
</section>

<section class="card platform reveal" id="extension" aria-labelledby="extension-title">
<div class="platform-head"><h2 id="extension-title">${icon("globe")}Browser extension</h2><p>Chrome or Edge 120+, Firefox 140+ or ESR 140</p></div>
<p class="platform-body">Add it after the app. Its button saves the page you are on, and it talks only to Koona Pin on this computer.</p>
<div class="ext-tiles">
<div class="tile tile-quiet"><strong>Chrome</strong><span>Coming soon to Chrome Web Store</span></div>
<div class="tile tile-quiet"><strong>Edge</strong><span>Coming soon to Edge Add-ons</span></div>
${firefox ? `<a class="tile" href="${firefox}"><strong>Firefox</strong><span class="tile-action">Add to Firefox${icon("arrowRight", "icon icon-small")}</span></a>` : `<div class="tile tile-quiet"><strong>Firefox</strong><span>Coming soon</span></div>`}
</div>
</section>

<section class="reveal">
<h2>Check the download</h2>
<p>Each file's SHA-256 checksum is in <a href="${rel.sums.url}">SHA256SUMS.txt</a> next to it. Updates are checked by the app itself: it installs only files signed by Koona.</p>
${command("sha256sum -c SHA256SUMS.txt --ignore-missing")}
</section>
<section class="reveal">
<h2>What the app connects to</h2>
<p>Your library stays on your computer. The app reads the title and preview of each link you save from that link's website, asks Google's favicon service for missing icons, and asks koona.app once a day whether a new version is out. Nothing about your library is sent. Details are in the <a href="${BASE}/privacy">privacy policy</a>.</p>
</section>
<section class="reveal">
<h2>Need help?</h2>
<p>Send feedback from the app (Settings → Send feedback)${FEEDBACK_ENDPOINT ? ` or <a href="${BASE}/feedback">from this website</a>` : ""}, or <a href="${SUPPORT}" rel="noopener">open an issue on GitHub</a>.</p>
</section>`;
  return englishPage(t, {
    page: "downloads/",
    title: "Download",
    description: "Download Koona Pin for Windows and Linux, and the browser extension for Chrome, Edge and Firefox.",
    body,
    wordmark,
    current: "download",
  });
}

/** /changelog/: what changed in each released version, newest first — the list the update dialog shows. */
export function changelogPage(t, { wordmark, entries }) {
  const body = `<h1>Changelog</h1>
<p class="intro">What changed in each version, newest first. Koona Pin shows the same list before it updates.</p>
<ol class="versions">
${entries
  .map(
    (e, i) => `<li class="version reveal" id="${e.version}">
<div class="version-meta"><h2>${e.version}</h2><p>${esc(day("en", e.date))}</p>${i === 0 ? '<span class="chip-latest">Latest</span>' : ""}</div>
<ul class="version-changes">${e.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
</li>`,
  )
  .join("\n")}
</ol>`;
  return englishPage(t, {
    page: "changelog/",
    title: "Changelog",
    description: "What changed in each version of Koona Pin.",
    body,
    wordmark,
    current: "changelog",
  });
}

/** The privacy policy from extension/store/privacy.md: one language section, **Heading.** paragraphs. */
export function privacy(t, { markdown, wordmark }) {
  const part = markdown.split(/^## /m).find((p) => p.split("\n")[0].trim() === t.privacyPage.section);
  if (!part) throw new Error(`extension/store/privacy.md: no section «${t.privacyPage.section}» for ${t.lang}`);
  const paras = part.split("\n").slice(1).map((l) => l.trim()).filter((l) => l && l !== "---");
  const link = (s) => esc(s).replace(/https:\/\/koona\.app\/pin\/?/g, (u) => `<a href="${u}">${u}</a>`);
  const body = paras
    .map((p) => {
      const m = p.match(/^\*\*(.+?)\*\*\s*(.*)$/);
      if (!m) return `<p class="lead">${link(p)}</p>`;
      return `<h2>${esc(m[1].replace(/\.$/, ""))}</h2>\n<p>${link(m[2])}</p>`;
    })
    .join("\n");
  // A translation without a native speaker's review says so and links the English text (NP-107).
  const p = t.privacyPage;
  const note = p.note ? `<p class="translation-note">${esc(p.note)} <a href="${href("en", "privacy")}" hreflang="en">${esc(p.original)}</a></p>\n` : "";
  return textPage(t, {
    page: "privacy",
    current: "privacy",
    wordmark,
    title: p.title,
    body: `<h1>${esc(p.title)}</h1>\n<p class="updated">${esc(p.updated)}</p>\n${note}${body}`,
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
<textarea id="fb-message" name="message" rows="8" required placeholder="${esc(f.placeholder)}"></textarea>
<label class="field-label" for="fb-email">${esc(f.email)}</label>
<input id="fb-email" type="email" name="email" maxlength="254" autocomplete="email" placeholder="name@example.com">
<div class="trap" aria-hidden="true"><label for="fb-trap">${esc(f.trap)}</label><input id="fb-trap" name="hp_7q" tabindex="-1" autocomplete="off"></div>
<p class="form-note">${esc(f.note)} <a href="${href(t.lang, "privacy")}">${esc(f.privacy)}</a></p>
<p><button class="button button-primary" type="submit">${esc(f.send)}</button></p>
</form>
<p>${esc(f.app)}</p>
<p><a href="${SUPPORT}" rel="noopener noreferrer">${esc(f.github)}</a></p>`;
  // The site sends Referrer-Policy: same-origin, under which a POST to Supabase would carry
  // `Origin: null`; this page lets the browser name the site, which the function checks.
  // Its links to other sites carry rel=noreferrer: they keep the rest of the site's policy.
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
