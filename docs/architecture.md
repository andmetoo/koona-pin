# Architecture

Koona Pin is a desktop app with a browser extension. This page describes the parts, how they talk to each other and where the boundaries are. File paths are relative to the repository root.

## Processes and components

```text
browser extension ──native messaging──▶ koonapin-host ──┐
AI assistant ──────MCP over stdio─────▶ koonapin-mcp ───┴─pipe / socket──▶ Koona Pin app ──▶ SQLite
 (extension/src)                       (src-tauri/src/bin)             (src-tauri/src + src)
```

| Part | Where | What it is |
| --- | --- | --- |
| App | `src-tauri/src` (Rust), `src` (React) | One Tauri 2 process: a Rust core that owns the library file, and a React 19 + TypeScript interface in the system WebView (WebView2 on Windows, WebKitGTK on Linux). Binary name `koonapin`. |
| Native messaging host | `src-tauri/src/bin/koonapin-host.rs` | A small separate binary without Tauri, installed next to the app. The browser starts it for each message; it forwards the message to the running app and returns the answer. It shares only `pipe_name.rs` with the app, and `channel_client.rs` with the MCP server. |
| MCP server | `src-tauri/src/bin/koonapin-mcp.rs` | The server an AI assistant (Claude Desktop, Claude Code, Cursor and others) starts and speaks MCP with over stdio, built on the official Rust SDK `rmcp`. Like the host it does not link the app: it passes each tool call over the same channel and starts a closed app in the tray. See [AI assistants](#ai-assistants-mcp). |
| Browser extension | `extension/src` | One Manifest V3 source for Chrome, Edge and Firefox. Saves the current tab, keeps a queue, offers a quick search popup. See [extension.md](extension.md). |
| Release data | `changelog/`, `scripts/build-latest.mjs`, `scripts/build-release-data.mjs` | The changelog, the update feed and `release.json`, deployed to koona.app by the release workflow. The site itself lives in `andmetoo/koona-site`; `scripts/lib/site.mjs` holds the addresses the app relies on. |

The app is single-instance (`tauri-plugin-single-instance`). The window is created hidden and shown at start; a start with `--autostart` (sign-in, or the host starting a closed app) stays in the tray.

## The interface

- `src/App.tsx` assembles the shell. Components live in `src/components/shell` (sidebar, toolbar), `src/components/library` (cards, list, editor, triage, duplicates, link check), `src/components/settings` and `src/components/ui` (buttons, fields, menus, dialogs, notices).
- `src/components/LibraryGate.tsx` shows the app only once the library is open; until then a "opening" state or an error screen with a code.
- The list (`src/components/library/BookmarkList.tsx`) is virtualised with TanStack Virtual. Row heights are computed, not measured, so late metadata never moves cards. Pages are fetched with a cursor as the end of the loaded list comes near.
- Rules that need no database (filters, merging by `id` and revision, date groups, triage queue) are plain functions in `src/services/*.ts` with Vitest tests next to them.
- Strings come from i18next catalogs in `src/locales` ([translating.md](translating.md)); styles are Tailwind 4 with design tokens in `src/styles/app.css` ([design.md](design.md)).

## IPC between React and Rust

- `src/services/api.ts` is the typed boundary. Every call goes through one `call` helper; a rejected command becomes a `CommandError` with `code`, optional `detail` and `message` (`src/services/errors.ts`).
- The types of the contract are generated from Rust by [ts-rs](https://crates.io/crates/ts-rs) into `src/bindings` while `cargo test` runs. The generated files are committed; `bun run check:bindings` fails if they differ from what the tests wrote.
- Commands are registered in `src-tauri/src/lib.rs` and mostly implemented in `src-tauri/src/commands.rs`. Every command that touches the database is async and runs its work on a blocking thread, so the main thread (window, tray) never waits for the database lock.
- Rust errors (`src-tauri/src/error.rs`) carry a machine code (`invalid_request`, `not_found`, `conflict`, `database_busy`, `disk_full`, `read_only`, `database_error`, `internal`, …) and an optional `detail`. The interface turns these into words in the user's language. Rust holds no user-facing text: `src-tauri/tests/english_source.rs` fails if Cyrillic appears in string literals outside tests (search folding of `ё`/`е` excepted).
- Rust pushes changes to the interface as events: `bookmark-changed` and `bookmarks-changed` (one or many changed bookmarks with revisions), `library-invalidated` (re-read everything: import, restore, emptying the trash), `library-status`, `capture-status`, `update-status`, `import-progress`, `link-check`, `mcp-status`.
- In a plain browser (`bun run dev`) there is no Tauri: `api.ts` switches to `src/services/demo.ts`, an in-memory adapter with the same types and errors and its own demo data in `localStorage`. It never touches a real library.

## Library: SQLite

The library is one SQLite file, `koonapin.db`, in `<data dir>/Koona/Pin` (`%APPDATA%\Koona\Pin` on Windows, `~/.local/share/Koona/Pin` on Linux, or `$XDG_DATA_HOME/Koona/Pin`). `KOONAPIN_DATA_DIR` replaces the whole folder; tests use it. The path is built by `db::db_path` in `src-tauri/src/db.rs`. Access goes through `rusqlite` with a bundled SQLite.

### Opening

`library_state.rs` opens the library on a background thread, so the window appears at once. `library.rs` does it in steps:

1. An existing file is first opened read-only. A foreign `application_id`, a schema newer than the build knows, a file that is not SQLite, a locked file or a failed `PRAGMA quick_check` each stop with an error screen. The file is not changed by a single byte.
2. The connection uses WAL, `foreign_keys = ON`, `synchronous = FULL`, a 5 s `busy_timeout` and a 64 MB page cache.
3. Pending migrations run (below).

Until the library is open, database commands are refused and the capture channel is closed.

### Schema and migrations

- `src-tauri/src/migrations.rs` holds the schema steps, applied with [rusqlite_migration](https://crates.io/crates/rusqlite_migration). The schema number is `PRAGMA user_version` (currently 9); the file is marked with `application_id = 0x4E50494E` ("NPIN").
- All pending steps and the new `user_version` run in one transaction. Before migrating an existing library the app writes a copy `backups/koonapin.before-vN.db` with `VACUUM INTO`; the last two are kept. If the copy fails the migration does not start; if a step fails the transaction rolls back and the screen points to the copy.
- A released step is never edited; a change is a new step. A step that rebuilds a table must turn foreign keys off itself before the transaction.
- Main tables: `bookmarks`, `collections`, `tags`, `bookmark_tags`, `capture_receipts`, `app_settings`, `tombstones`, `duplicates_dismissed`, `link_checks`. Records have a UUIDv7 `uid` beside the integer `id`; times are UTC strings with milliseconds (`YYYY-MM-DDTHH:MM:SS.sssZ`).
- The inbox and the trash are flags, not places: `triaged_at IS NULL` means "in the inbox", `deleted_at IS NOT NULL` means "in the trash". Every query, counter and index filters on them. Purging the trash after 30 days (`trash.rs`) leaves a row in `tombstones`.
- Search (`bookmarks_search`) is an FTS5 index with the `trigram` tokenizer and no stored text (`content=''`), kept in step by triggers in the same transaction as each write. Words of one or two characters, which trigrams cannot find, are checked by a connection function `np_contains`. Settings → Data can rebuild the index.
- Sorting by title and site uses collation keys (`title_key`, `site_key`) written by triggers through connection functions backed by ICU4X (`sorting.rs`). The interface tells the database its language with `set_sort_language`; a change of language rewrites the keys in one transaction.

### Undo journal

`journal.rs` keeps the last 100 commands (and at most 50 000 changed bookmarks) in memory, for the current run only. Edits, moves, tags, trash and restore record the fields before and after. `undo` restores only the fields that still hold what the command wrote; anything changed since makes the undo a `conflict` instead of silently overwriting it.

## Capture

### The path of a link

1. The extension stores the link in its own queue (`storage.local`) with a `request_id`, then calls `runtime.sendNativeMessage("app.koona.pin", …)`.
2. The browser starts `koonapin-host` and writes the message to its stdin (32-bit native-endian length + UTF-8 JSON, at most 1 MiB).
3. The host forwards one JSON line `{ "caller": …, "message": … }` to the app over a local channel and writes the answer back. If the app is not running and the message is an action of the person (`capture`, `search`, `show`), the host starts `koonapin --autostart` detached and waits up to 10 s for the channel; otherwise it answers `app_unavailable`. `hello` and `lookup` never start the app.
4. The app (`capture.rs`) validates the URL (HTTP or HTTPS with a host, at most 8192 characters), and inserts the bookmark, its receipt and its tags in one transaction. The answer is sent after commit: `created` or `existing`. A repeated `request_id` returns the stored receipt, so a lost answer never creates a duplicate.
5. Metadata (title, description, preview image, icon) is fetched afterwards, outside the transaction (`metadata.rs`). It is applied only if the bookmark's revision has not changed, so a title the person typed in the meantime wins.

### The local channel

- **Windows:** a named pipe `\\.\pipe\koonapin-<user SID>`, created with `FILE_FLAG_FIRST_PIPE_INSTANCE`, `PIPE_REJECT_REMOTE_CLIENTS` and a DACL that admits only the current user. If another program already holds the name, the app shows an error instead of sharing it.
- **Linux:** a Unix socket `$XDG_RUNTIME_DIR/koonapin/capture.sock`. The folder is `0700` and must be a real folder of this user, the socket `0600`, and every peer's UID is checked with `SO_PEERCRED`. Without `XDG_RUNTIME_DIR` there is no socket (none in `/tmp`).
- **macOS:** the same socket in the user's own system folder, `$(getconf DARWIN_USER_DIR)koonapin/capture.sock`, checked with `getpeereid`.
- **Safari on macOS (NP-119):** Safari's extension has no host; its handler runs in the sandboxed appex `app.koona.pin.safari` inside `Koona Pin.app/Contents/PlugIns/`, which can reach a socket only in its own container. When the bundle embeds the appex, the app opens a second socket at `~/Library/Containers/app.koona.pin.safari/Data/capture.sock` (`safari_socket.rs`). Those folders belong to the system and are only checked, not chmodded; the socket is `0600`. A peer must be of this user and its code (by audit token) must satisfy the designated requirement of the embedded appex: its cdhash while signed ad hoc, the team's requirement under Developer ID. Refused peers get no reply. The same envelope and answers as the host's socket, except that `mcp` is refused. If it cannot open, Chrome, Edge and Firefox still work.
- One JSON line each way per connection; a line over 1 MiB or a client silent for 10 s is dropped. `KOONAPIN_PIPE` changes the name for tests.

### Protocol

The protocol version lives in `browsers::PROTOCOL` (Rust) and `extension/src/version.js` (extension); it is currently 2. Messages: `hello`, `capture`, `search` (quick search popup), `show` (bring the window forward), `lookup` ("is this page already saved"). A message with another protocol number gets `incompatible_protocol`, and the app tells the person which side to update.

### Browser status and registration

- `browsers.rs` records, per browser, the last message time, extension version and protocol in `app_settings`. The sidebar shows "connected" when a browser spoke within 3 days. The extension says `hello` at browser start, on install and every 30 minutes.
- `native_host.rs` writes the host manifests and registers them. On Windows: manifests next to the app and keys under `HKCU\Software\{Google\Chrome,Microsoft\Edge,Mozilla}\NativeMessagingHosts\app.koona.pin`. The installer runs `koonapin --register-host` after install and `--unregister-host` before uninstall; a release build also checks and repairs the registration at every start. On Linux the packages install system manifests; the app only checks them. Details in [extension.md](extension.md#native-host-registration).
- The Chromium manifest lists the store extension IDs, and in non-release builds also the development ID. Builds made with `--features public-release` (installers and packages) leave the development ID out.

## AI assistants (MCP)

An AI assistant on this computer can search the library and, if the person allows, add to it (NP-091). Nothing about it listens on the network: the assistant's app starts `koonapin-mcp` and talks to it over stdio.

- **The server** (`src-tauri/src/bin/koonapin-mcp.rs`) uses `rmcp` for the protocol: version negotiation, `initialize`, `tools/list`, `tools/call`, `ping`. The tools and their argument types live in `mcp_tools.rs`, which both the server and the app compile, so the schema the assistant sees is the one the app reads. Each call becomes one channel message `{ "type": "mcp", "protocol", "client", "tool", "arguments" }`; `client` is the name the assistant gave in `initialize`. A tool call starts a closed app in the tray; `tools/list` does not, since an assistant lists its servers whenever it starts.
- **The app decides** (`mcp.rs`). Access is in `app_settings` (`mcp_access`): `off` by default, `read` or `read_and_add` (Settings → AI assistants). Off, every call gets an error and nothing is read; the tool list stays so the assistant can say why. `read` offers `search_bookmarks`, `get_bookmark`, `list_collections`, `list_tags`; `read_and_add` also `add_bookmark`, `tag_bookmark`, `move_to_collection`, `set_favorite`. Nothing deletes. When a call finds another access than the last list, the server sends `notifications/tools/list_changed`.
- **Changes.** A link goes to the inbox with `source = 'mcp'` and the assistant's name in `source_name` (schema 8), so triage says «saved … from Claude Code»; the same address again is `existing`. Tagging, moving and starring are commands of the undo journal (`Ctrl Z`) and, unlike the person's own decisions, leave a bookmark in the inbox.
- **Untrusted text.** Titles, descriptions, notes, tags and collection names come from web pages or the person: the server's instructions and every tool description say they are data, the answers carry no instructions. Texts lose control characters and bidi marks and are cut (title 300 characters, notes 4000); a search returns at most 50 bookmarks and an answer at most 64 KiB.
- **Connecting.** Settings → AI assistants → «How to connect…» shows the path of `koonapin-mcp` on this computer as a command for Claude Code, as the path the ChatGPT desktop app asks for in Settings → MCP servers (or `codex mcp add`: the app and Codex share their list; ChatGPT in the browser takes only remote servers), and as `mcpServers` JSON for Claude Desktop, Cursor and others. «Save for Claude Desktop…» saves `koona-pin.mcpb` (a zip: manifest, icon, the server) where the person picks, Downloads by default, and shows it in the file manager; the person double-clicks it, drags it into Claude Desktop or uses Settings → Extensions → Install Extension…. Opening it from the app was unreliable: on Windows Claude Desktop does not always register the file type. The manifest runs the copy inside the package, as the format describes; that copy hands over to the installed server named in `KOONAPIN_MCP_SERVER` (stdio inherited), so app updates reach it without a new package. The AppImage copies the server beside the host (`appimage.rs`).
- The last request (assistant and time) is kept for the settings and pushed as the `mcp-status` event; the same assistant is written at most once a minute, so reading does not write the library each time. Turning access on again gives back the mode chosen last (`mcp_mode`).

## Backups and restore

- `library::maintain` runs at start and then hourly on a separate read-only connection: `quick_check` first, then, if the newest automatic copy is older than a day, `backups/koonapin.auto-<time>.db` via `VACUUM INTO`. Seven daily and four weekly copies are kept (`backup.rs`). The check runs before the copy, so a damaged library never pushes healthy copies out of rotation.
- If the check finds damage, the main connection switches to `PRAGMA query_only`, the interface shows a banner, and maintenance stops copying until the library is restored.
- Restoring from a copy (`backup.rs`, `library.rs`) validates the file read-only, migrates a working copy in `backups/restoring`, saves the current library as a `before-restore` copy and then replaces it with the SQLite backup API in one write transaction.
- JSON export and restore (`export.rs`, `restore.rs`) are a portable copy of collections, tags and bookmarks keyed by `uid`; they are for moving a library, not a replacement for the SQLite copies (no receipts, settings or journal). HTML import and export use the Netscape bookmark format (`import.rs`, `export.rs`). Files are written atomically: a temporary file in the same folder, `fsync`, then rename.

## Updater

`updates.rs` drives `tauri-plugin-updater` from Rust only; the interface has no permission for the plugin, just the commands `get_update_status`, `check_for_updates`, `install_update`, `cancel_update` and the `update-status` event.

- The feed is `https://koona.app/pin/updates/latest.json` (`src-tauri/tauri.conf.json`). The app checks 10 s after start and then once a day, through the system proxy. Development builds check only on request.
- Packages are verified with the minisign public key in `tauri.conf.json`, with `requireSignedVersion`: a signature is bound to its version, so an old signed package cannot be offered under a new number.
- Windows runs the NSIS installer in passive mode and exits. Linux installs the `.deb` or `.rpm` through `pkexec` from a folder only this user can enter, then restarts; an AppImage replaces its own file. A copy installed from the AUR does not check for updates (`channel.rs`).
- `bun run build:latest` signs packages and writes `latest.json`; release.yml's finalize adds `release.json` and deploys them to koona.app, whose server checks every signature against the same public key.

## Security boundaries

The app accepts input from outside in one place, the capture channel above; the MCP server reaches the app through it too. It runs no HTTP server and listens on no port; a native test checks that the old port `127.0.0.1:28765` is closed.

**Network guard** (`net_guard.rs`, `metadata.rs`). A saved link must not make the app reach this computer or the local network (router pages, printers, dev servers):

- Only HTTP and HTTPS. Loopback, private, link-local, CGNAT, multicast and reserved IPv4 ranges, their IPv6 counterparts (`::1`, `fc00::/7`, `fe80::/10`, …) and IPv4 carried in IPv6 are refused, as are the names `localhost`, `*.localhost` and `*.local`.
- Names are checked where the connection is made: a custom resolver keeps only public addresses, so a name that resolves to a private address later is still refused. Each redirect is checked again; at most 5.
- No proxy (it would resolve names outside the check) and no `Referer` header. Limits: 4 s to connect, 8 s per request, 2 MiB of body, HTML only, 4 pages at a time.
- Preview images and icons are loaded by the WebView, so their URLs pass the same check with DNS before they are stored.
- Link check (`linkcheck.rs`) uses the same guard.

**WebView.** The CSP in `tauri.conf.json` allows scripts, styles and fonts only from the app, no `eval`, images from the app, `data:` and the web (site previews), and IPC as the only connection. `src-tauri/capabilities/default.json` grants the interface only events, the app version and the frameless window's buttons. The opener plugin is not available to the interface: links open through the app's own `open_url_external` command, which accepts only HTTP(S).

**Outgoing requests the app makes on its own:** metadata and link checks (guarded as above), the update check, and feedback, which is sent only when the person presses Send in the feedback dialog, to an address set at build time (`KOONAPIN_FEEDBACK_URL`). The receiving function lives in `supabase/`.

**Logs.** The app and the host write to stderr only errors about opening the library, backups and the channel, without URLs or library content.

## Platform notes

- **Windows:** NSIS installer per user (no administrator rights), WebView2 through the embedded bootstrapper, autostart with `tauri-plugin-autostart`.
- **Linux:** `.deb`, `.rpm`, an AppImage and an AUR recipe. Window buttons follow the desktop's `gtk-decoration-layout` (`desktop.rs`); without a tray the first close explains that the app keeps running. Autostart is an XDG `.desktop` file in `~/.config/autostart`.
- macOS and mobile platforms are not supported.
