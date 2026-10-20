# Translating

Koona Pin's interface, its browser extension and the landing page of its site are translated into the same languages: English, German, Spanish, French, Italian, Japanese, Korean, Polish, Portuguese (Brazil), Russian, Serbian (Cyrillic and Latin), Turkish, Ukrainian and Chinese (Simplified). English is the source and the fallback. A new install starts in English; "System" in Settings picks the system's language.

## Where strings live

| Part | Files | Notes |
| --- | --- | --- |
| App | `src/locales/<code>.json` | i18next catalogs; `en.json` is the source. Set up in `src/i18n/index.ts`. |
| Extension | `extension/src/_locales/<code>/messages.json` | Chrome's codes (`pt_BR`, `zh_CN`); no separate Serbian Latin. Follows the browser's language. |
| Site | `pin/src/locales/<code>.mjs` in the site's repository (`andmetoo/koona-site`) | Only the landing pages are translated; downloads, changelog and other pages are English. |
| Windows installer | `src-tauri/nsis/<Language>.nsh` | Listed in `src-tauri/tauri.conf.json`. |
| Android share sheet | `src-tauri/plugins/koona-share/android/src/main/res/values*/strings.xml` | Written from `phone.share` of `src/locales` by `bun run locales:android`; never edit them by hand. |

Rust holds no user-facing text. Errors reach the interface as codes and are worded in `src/locales` under `errors.code.*`, `errors.detail.*` and `errors.reason.*`. The tray menu gets its labels from the interface.

## How the app picks a language

Every file in `src/locales` is a language; the code is the file name. Nothing else needs registering: the language appears in Settings, and "System" finds it by language, script and region (`matchLanguage` in `src/i18n/index.ts`). For example `sr-Latn-RS` → `sr-Latn`, `sr-RS` → `sr`, `pt-PT` → `pt-BR`, `de-AT` → `de`. A different script is a different language to its reader: `zh-TW` (Traditional) does not get `zh-CN`, it gets English.

## Adding or changing a string

1. Add the key to `src/locales/en.json`, then to every other file in `src/locales` except `sr-Latn.json`.
2. If you changed `sr.json`, regenerate the Latin file: `bun run locales:sr-latn`. Never edit `sr-Latn.json` by hand.
3. Extension strings go into every `extension/src/_locales/*/messages.json`.
4. If you changed `phone.share` (the Android share sheet, which is native and never loads the page's catalogs), regenerate its resources: `bun run locales:android`. A new language gets its `values-<language>` folder the same way.
5. Run `bun run test`. It reports a missing or extra key, a missing plural form, a lost placeholder, an empty string, Latin and Cyrillic letters mixed in one word, an `sr-Latn.json` that does not match `sr.json`, and Android strings that do not match `src/locales` (`src/i18n/locales.test.ts`, `src/i18n/androidStrings.test.ts`, `extension/src/locales.test.js`).

Plurals use i18next suffixes (`_one`, `_few`, `_many`, `_other`, …). Each file must have exactly the forms `Intl.PluralRules` gives for its language. Where `one` also covers numbers like 21 or 0, every `_one` string must show the number (`{{count}}`), not just say "one".

Keep placeholders such as `{{name}}` and `{{count}}` exactly as in English.

## Adding a language

1. Create `src/locales/<code>.json` with all keys of `en.json` and `language.name`, the language's name in itself. Use a BCP 47 code, with a script or region only when it distinguishes variants (`sr-Latn`, `pt-BR`).
2. Provide every plural form the language needs (see above).
3. Add `extension/src/_locales/<Chrome code>/messages.json` and the code to the list in `extension/src/locales.test.js`. The extension name must fit 75 characters and the description 132 (store limits; tested).
4. Fonts: Inter covers Latin, Latin Extended and Cyrillic. For other alphabets that Inter has, add the subset in `scripts/build-extension.mjs`, `options.css` and `search.css`. For scripts Inter lacks (Chinese, Japanese, Korean), the app falls back to the system font chosen by `:lang()` in `src/styles/app.css`; `src/styles/fonts.test.ts` keeps the app and extension font lists equal; the site keeps its own copy.
5. Site: the landing page is translated in the site's repository (`andmetoo/koona-site`); once it has the language, add it to `languages` in `scripts/lib/site.mjs`, which the app's links to the site are tested against.
6. Installer: an NSIS language file in `src-tauri/nsis` and entries in `tauri.conf.json`.
7. Add the terms to the glossary below.
8. Check: `bun run test`, `bun run test:ui -- --grep @languages` (no truncated labels at 800×550 and 1600×800, sidebar rows fit), `bun run extension:lint`.

## Length

German, French and Polish run 30–40 % longer than English. Interface labels should wrap or be shortened, not truncated with an ellipsis; truncation is only for user data (titles, URLs, tags). The browser status in the sidebar has a fixed slot; its short form must fit in every language. WebKitGTK on Linux draws text a few pixels wider than WebView2, so leave a margin. The `@languages` tests catch most overflow.

## Glossary

Use these terms the same way in the app, the extension and the site. If a term changes, change it everywhere in one change. In your language, pick one word per term and keep it.

Not translated: Koona Pin, Windows, Chrome, Edge, Firefox, Chrome Web Store, Edge Add-ons, HTML, JSON, CSV, URL, HTTP/HTTPS and key names (Ctrl, Shift, Alt, Esc, Enter, Del).

| English | Meaning and guidance |
| --- | --- |
| Library | Everything the person has saved in Koona Pin, the whole collection of bookmarks. |
| Bookmark | One saved link with its title, notes and tags. In Portuguese use "Marcador", not "Favorito": "Favorites" is a separate section. |
| Link | The address itself, or a link as a thing to open. Use it where the person thinks of the URL, "Bookmark" where they think of the saved item. |
| Inbox | Where newly saved bookmarks wait until the person decides something about them. A state, not a folder. |
| Sort inbox | The keyboard-driven review of the inbox (triage). In English it shares "Sort" with "Sort by"; in other languages use different words for the two. |
| Keep | The triage decision to leave a bookmark as it is and take it out of the inbox. |
| Collection | A named group a bookmark belongs to (at most one). Shown in the sidebar. |
| Tag | A free label; a bookmark can have many. |
| Note | The person's own text on a bookmark. |
| Favorites | Bookmarks marked with a heart. |
| Trash | Deleted bookmarks, kept 30 days before they are removed. |
| Move to Trash | Soft delete; can be undone. |
| Delete forever | Permanent removal from the trash; cannot be undone. Make the wording clearly final. |
| Restore | Bring back from the trash, or replace the library from a backup. |
| Undo | Reverse the last action. |
| Backup | An automatic or manual copy of the library file. |
| Import / Export | Bringing bookmarks in from a browser file or a Koona Pin file, and writing them out. |
| Duplicates | Several bookmarks for the same page. |
| Merge | Combine duplicates into one bookmark. |
| Link check | Checking whether saved pages still open, moved or are gone. |
| Selection | Several bookmarks picked for a bulk action. |
| Sort by | The order of the list (newest, oldest, title, site). |
| Search index | The internal index that makes search fast; appears in Settings → Data. |
| Extension | The Koona Pin browser extension. |
| Queue | Links the extension holds until the app receives them. |
| Tray | The notification area of the taskbar or panel. Use the system's own name for it in your language. |
| Settings | The app's settings page. |
| Send feedback | The dialog for bug reports, ideas and questions. |

## Address and typography

| Language | Address | Quotes | Notes |
| --- | --- | --- | --- |
| de | Sie | „…“ | Long compound nouns are the first to cause overflow. |
| es | tú | «…» | ¿…? and ¡…! |
| fr | vous | « … » with no-break spaces | No-break space before `: ; ? !` |
| it | tu | «…» | |
| ja | です/ます | 「…」 | Full-width 、。 and brackets; a space between Japanese and Latin letters or digits. |
| ko | 합니다체; buttons short (저장, 삭제) | ‘…’ | After a placeholder, write both particle forms: `{{name}}을(를)`, `(으)로`. |
| pl | ty, imperative (Otwórz) | „…” | |
| pt-BR | você | “…” | |
| ru | вы, imperative (Откройте) | «…» | |
| sr | ви (Отворите) | „…“ | Cyrillic is the source; Latin is generated letter by letter. |
| tr | siz (Açın) | “…” | `İ/i` and `I/ı` are different letters. |
| uk | ви (Відкрийте) | «…» | Apostrophe is `'` (U+0027). |
| zh-CN | 你, not 您 | “…” | Simplified script; full-width punctuation (，。：（）); a space between Chinese and Latin letters or digits. |
