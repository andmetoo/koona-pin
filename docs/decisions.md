# Key technical decisions

Short records of the choices that shape the code, and why they were made. Each ends with what would make us look again.

## A local SQLite library, and only SQLite

The library is one SQLite file on the person's computer, owned by the Rust side of the app. Bookmarks are relational data: tags, collections, unique URLs, bulk actions that must be atomic, a trash. SQLite gives transactions, a stable file format and decades of durability, and it runs everywhere the app might go later.

A NoSQL or key-value store was considered when search was slow. Measurement showed the problem was the query, not SQL: moving search to an FTS5 index took a worst-case query on 100 000 bookmarks from about two seconds to tens of milliseconds. Key-value stores would have meant writing search, relations, uniqueness and migrations by hand.

Durability settings follow from "never lose a confirmed save": `synchronous = FULL`, WAL, a read-only check of the file before any write, a copy before every migration, daily copies with rotation, and an integrity check that runs before the copy so a damaged file never displaces healthy copies.

*Revisit if* search needs typo tolerance, ranking or morphology. Then add a derived index (for example Tantivy) built from SQLite; SQLite stays the source.

## Search with FTS5 trigram

The `trigram` tokenizer finds any substring of three or more characters in any field and folds case, Cyrillic included, which `LIKE` and `lower()` in SQLite do not. The index stores no copy of the text (`content=''`) and is kept up to date by triggers in the same transaction as each write. Words shorter than three characters are matched by a small connection function over the rows the index left. "ё" is folded to "е" on both sides.

## Schema ready for sync, without choosing sync

From the first schema, records carry a UUIDv7 `uid` next to the local integer `id`, deletion is a flag (`deleted_at`) with tombstones after purge, all times are UTC strings with milliseconds, and each bookmark records its `source`. No sync protocol or server was chosen; this only avoids a second migration of every library when one is.

## Migrations: one transaction, never edit a released step

Migrations use `rusqlite_migration`, with the schema number in `PRAGMA user_version`. All pending steps and the new version are applied in one transaction, so a failure leaves the library exactly as it was. The library carries an `application_id`, and a build refuses a file with a newer schema instead of guessing. There is no automatic downgrade; a bad migration is fixed by the next version.

## Tauri 2 with React

Tauri uses the system WebView, so the installer stays small and the core is Rust with direct, safe access to SQLite, files and OS APIs. The interface is React 19 and TypeScript, built by Vite, styled with Tailwind 4 and tokens in one CSS file. Long lists are virtualised. Tauri's own risks for other platforms were probed early and found no blockers; macOS is not shipped for now.

## IPC types generated from Rust

The TypeScript types of every command and event are generated from the Rust structs with ts-rs during `cargo test` and committed in `src/bindings`. A check fails when they differ from what is committed. Hand-written types had already drifted from Rust. ts-rs was chosen over tauri-specta because the latter was still a release candidate; command argument names stay hand-written and are covered by native tests.

Command errors are a closed set of machine codes plus an optional detail. Rust holds no user-facing text, so a new language never needs a Rust change.

## Native messaging instead of a local HTTP server

Early builds took links from the browser over HTTP on a fixed localhost port with a token. That needed the person to copy a token, collided with anything else on the port, told the app nothing about which browsers were connected, and left an endpoint any local program or web page could probe.

Now the extension uses the browser's native messaging. The browser itself starts a registered host program, and only for extension IDs listed in its manifest. The host is a tiny separate binary that forwards each message over a per-user named pipe (Windows) or a `0700`/`0600` Unix socket (Linux) to the running app, so one process writes the library and all checks stay in one place. If the app is closed, the host starts it in the tray. The cost: a new process per message (tens of milliseconds) and no fallback if an organisation's policy blocks native hosts. The app runs no server and listens on no port.

*Revisit if* enterprise policies or antivirus block it for many people.

## A capture queue in the extension

Every click is first written to the extension's own storage with a `request_id`, then sent. The item leaves the queue only after the app confirms a commit with a bookmark ID. Retries reuse the same `request_id`, and the app keeps receipts, so a lost answer never creates a duplicate and a retry never resurrects a bookmark the person has since deleted. This makes saving work when the app is closed, still starting, or its library failed to open.

## One extension source for three browsers

Chrome, Edge and Firefox share `extension/src`; a build script writes each browser's manifest (service worker for Chromium, an event page for Firefox) and the packages. The version and protocol number live in one file. A fixed development key gives the unpacked build the same ID on every machine, so a development build of the app can admit it, while release builds admit only the store IDs.

## Inbox and trash as flags

The inbox is `triaged_at IS NULL`, the trash is `deleted_at IS NOT NULL`; there are no separate tables to move rows between. A bookmark keeps its collection, tags and notes through both, any decision about a bookmark takes it out of the inbox, and saving a URL that is in the trash brings it back. URLs stay unique across the trash.

## Undo by comparing fields, in memory

The undo journal lives in memory for the current run. An undo restores only the fields the command wrote, and only if they still hold what it wrote. Background changes (a late preview image) do not block undo, and later edits by the person are never silently overwritten; a real conflict is reported instead.

## Network guard for anything a saved link triggers

Fetching a page's title and preview is a request the app makes because of data it did not choose. So those requests may reach only public addresses: names are resolved by a guarded resolver, every redirect is rechecked, no proxy is used, sizes and times are capped. A saved link cannot make the app touch a router, printer or dev server on the local network.

## Bun instead of Node and npm

Bun installs dependencies and runs every script, Vite, Vitest, Playwright and the Tauri CLI; Node.js is not needed on a developer machine or in CI. One runtime, one lock file (`bun.lock`), one version file (`.bun-version`). Bun does not load `.env` by itself here (`bunfig.toml`), so secrets reach only the scripts that read them, and dependency install scripts are not trusted.

*Revisit if* a tool does not work on Bun; then run only that tool on Node.

## Updates served from the project's site

The updater reads `latest.json` from koona.app and downloads packages from the same site. The update feed must be reachable without signing in anywhere, and keeping it with the site keeps one place to publish. Packages are signed with a separate update key and the signature is bound to the version. The updater is driven from Rust only; the interface has no permission to download or install. Updates install only after the person agrees. A rollback is not offered because an older build cannot open a newer schema; a bad release is fixed by the next one.

## English as source, locales as plain files

English is the source language and the default for a new install. Each language is one JSON file in `src/locales`; adding a file adds the language, with no code change. Tests check keys, plural forms and placeholders against English. Serbian Latin is generated from Cyrillic rather than translated twice.

## The data folder

The library lives in `<data dir>/Koona/Pin`, a brand folder with a product subfolder, so future Koona apps sit beside it instead of scattering folders at the top level. The app writes and removes only its own subfolder. The file is named `koonapin.db` so a copy is recognisable without its path.

## Linux packages built on the oldest glibc

Linux binaries are compiled once, on Void Linux with glibc 2.41, the same floor as Debian 13, the oldest glibc of the supported set. A check fails the build when a binary needs a newer glibc, so an update of the rolling Void image cannot quietly break Debian. That very binary is then packed and tested on each distribution: Debian, Ubuntu, Fedora and Arch. The `.deb`, `.rpm`, AUR package and AppImage share it. Every job runs in a prebuilt image, and a local `bun run build:linux` uses the same images in Docker.

## A static site with no scripts

The site is built with Astro into static files. The built pages carry no JavaScript of their own; the build fails if a `<script>` appears. It serves the update feed and the Firefox update manifest alongside the pages.
