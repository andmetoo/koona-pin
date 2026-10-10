# Testing

`.github/workflows/ci.yml` runs on every pull request and every push to `main` (Windows: Rust tests, bindings, build, Vitest, extension lint, Playwright UI without `@visual`); `main` requires it to pass. `linux.yml` starts only by hand (`workflow_dispatch`) or locally through `act`. Run the checks locally before you push.

No check touches your own library or browser profile: tests create their own SQLite files, WebView2 and browser profiles under `.test-data`, and their own capture channel name (`KOONAPIN_PIPE`). Prerequisites are those of [building.md](building.md).

`macos.yml` builds experimental `.app` bundles on macOS 15 for Apple Silicon and Intel on relevant pull requests and by hand. It runs Rust, bindings, build, Vitest and functional UI tests in Playwright WebKit, then real IPC smoke tests in the bundled WKWebView and captures the actual app window in both themes, grid/list and English/Russian. ZIPs and screenshots are separate Actions artifacts. See [macOS test builds](macos-test.md) for commands and the remaining platform work.

## Before every commit: `bun run check`

```powershell
bun run check
```

Runs, in order: the Rust tests (`cargo test --locked` in `src-tauri`), the TypeScript and Vite build, and Vitest. It takes well under a minute once dependencies are built.

The Rust tests also regenerate the IPC types in `src/bindings` (ts-rs). Commit changed files there together with the Rust change. To make sure nothing was forgotten:

```powershell
bun run check:bindings
```

It fails if `src/bindings` differs from the committed files, including new untracked ones.

### What the parts cover

- **Rust** (`src-tauri/src/**` unit tests and `src-tauri/tests/`): storage and migrations on generated libraries, search, inbox, trash and its purge, undo journal, bulk actions, import, export and restore, backups, duplicates, link check against a local test server, the network guard, the capture protocol and receipts, the pipe or socket permissions, host manifests, the updater's status handling. `src-tauri/tests/english_source.rs` keeps user-facing text out of Rust.
- **Vitest** (`vitest.config.ts`: `src/**/*.test.ts`, `extension/**/*.test.js`, `supabase/**/*.test.ts`): the pure rules in `src/services`, the extension's queue, messages and locales, the locale catalogs (`src/i18n/locales.test.ts`), the feedback function.

## Playwright UI tests

```powershell
bunx --bun playwright install chromium   # once
bun run test:ui
```

`tests/ui` against the browser preview with demo data (`playwright.config.ts` starts Vite itself). The locale is `en-US` and tests name controls in English. Tags:

- `@visual` — screenshot comparisons, see [Visual baselines](#visual-baselines).
- `@languages` — every language at 800×550 and 1600×800: no truncated interface labels, sidebar rows fit, IME input.

Run a subset with `bun run test:ui -- --grep @languages` or `-- --grep-invert @visual`. Use `bunx` only with `--bun`; without it, `bunx` runs a package on Node if Node is installed.

## Native tests (Windows, WebView2)

```powershell
bun run test:native
```

`tests/native` drives the real app through the WebView2 debugging port (9225) with Playwright: the real SQLite, IPC, CSP, window, tray and the host. Before running, the script builds the app under test (`scripts/build-test-app.mjs`): the interface, then a debug binary with the interface embedded (`cargo build --features custom-protocol`), so CSP and origin are as in a release. A plain `cargo build` binary loads Vite instead and has no CSP; the native tests refuse it with an explanation.

Needs:

- No running Koona Pin. The app is single-instance per user, so a test build would hand over to it. The scripts stop with a hint if one is running.
- Port 9225 free (another WebView2 app with debugging on can hold it).

To test a release binary instead: build it with `cargo build --release --features custom-protocol --locked` in `src-tauri` and set `KOONAPIN_TEST_BINARY=src-tauri/target/release/koonapin.exe` for `test:native`, `test:host` and the extension smoke tests. The host is taken from the same folder.

`bun run test:perf` runs the scrolling benchmark (tag `@perf`, 10 000 bookmarks in grid and list). Run it after changes to the grid or list.

## Native host smoke test

```powershell
bun run test:host
```

`scripts/smoke-host.mjs` sends browser-shaped messages to `koonapin-host`: `hello` does not start a closed app, capture starts it in the tray, receipts, duplicates, invalid URLs, `request_id` conflicts, an old protocol.

## Extension smoke tests

```powershell
bun run test:extension            # Chrome for Testing
bun run test:extension:chrome     # installed Chrome
bun run test:extension:edge       # installed Edge
bun run test:extension:firefox    # Firefox
bun run test:extension:firefox:esr
bun run extension:lint            # web-ext lint of the Firefox package
```

Each builds the extension, loads the unpacked build into a fresh profile and talks to the real host and app: capture with the app closed, duplicates, the queue when the library cannot open, redelivery by alarm, an unregistered host, a foreign extension ID. Chromium browsers load the extension over CDP (`Extensions.loadUnpacked`), Firefox as a temporary add-on over WebDriver BiDi. The host is registered under a test name, `app.koona.pin.test`, and the registry key is removed at the end, so an installed Koona Pin is not affected.

- Browser paths: Chrome and Edge from their default install folders, overridden by `KOONAPIN_CHROME` and `KOONAPIN_EDGE`. Firefox is looked up in a scoop install; set `KOONAPIN_FIREFOX` to point elsewhere.
- Each run waits for an alarm-driven redelivery, so it takes about two minutes.
- `extension:lint` reports one expected warning: Firefox for Android understands `data_collection_permissions` only from version 142, and Android is not supported.

## Linux: the matrix through act

Linux is tested by one workflow, `.github/workflows/linux.yml`, run locally in containers with [act](https://github.com/nektos/act) (Docker required):

```bash
act workflow_dispatch -W .github/workflows/linux.yml
act workflow_dispatch -W .github/workflows/linux.yml -j build
act workflow_dispatch -W .github/workflows/linux.yml -j distro --matrix image:fedora:44
```

`.actrc` sets the runner image, the artifact folder (`.test-data/act-artifacts`) and reads secrets from `.env`. The `build` job needs `KOONAPIN_FEEDBACK_URL` there ([building.md](building.md#local-builds-without-signing)). `.actrc` also passes `--pull=false`, so pull the images once by hand (`docker pull debian:13` and the others).

| Job | Container | What it checks |
| --- | --- | --- |
| `build` | `debian:13` | The release build and packages (`.deb`, `.rpm`, AppImage), with `lintian`, `desktop-file-validate`, `appstreamcli validate`. Debian 13 has the oldest glibc of the matrix. |
| `check` | `debian:13` | What `ci.yml` does on Windows (Rust tests, bindings, build, Vitest, extension lint, Playwright UI without `@visual`), plus host registration with Debian's Chromium and Firefox ESR, the installed `.deb` with Chrome and Edge, and the extension smoke test. |
| `webkitgtk` | `debian:13`, `ubuntu:26.04` | The interface in the distribution's WebKitGTK: key screens in every language and both themes, system theme and reduced motion. |
| `distro` | `ubuntu:26.04`, `debian:13`, `fedora:44`, `archlinux:latest` | The AppImage, then the package installed with the system package manager: libraries resolve, start under X11 (Xvfb) and Wayland (Weston), second instance hands over, autostart entry, `test:host`, the native WebKitGTK tests, the window actually draws, reinstall and removal. Fedora and Arch also test their own Firefox and Chromium with the package. |

When one job fails, act also prints "Job failed" for jobs that finish after it; read the step results.

Native tests on a Linux desktop without containers: install WebKitWebDriver from the distribution and `cargo install tauri-driver --version 2.1.0 --locked`, quit Koona Pin, then:

```bash
bun run test:webkit
```

Change shared code? Check it on Windows too (`bun run check`, `test:host`, `test:native`).

### What the matrix cannot see

Containers have no real desktop: no GNOME, KDE or Hyprland session, tray, portals, polkit, Snap Firefox, GPU, fractional scaling or input methods. These are checked by hand on a real desktop before a release.

## Visual baselines

`tests/ui/visual.spec.ts` compares screenshots with the baselines in `tests/ui/visual.spec.ts-snapshots` (both themes, grid and list, three window sizes). The test pins the date to 3 October 2026, because date groups and short dates depend on it.

They are checked only locally: font antialiasing differs between machines and even between runs on the same machine after updates, so CI runs `--grep-invert "@visual"`. Update baselines only after looking at the difference:

```powershell
bun run test:ui -- --grep "@visual" --update-snapshots=all
```

Without `=all`, Playwright rewrites only the baselines that differ above the threshold.

## Test libraries

`src-tauri/src/test_libraries.rs` builds deterministic SQLite libraries without personal data in `.test-data/libraries`: empty, a sample with Cyrillic and tags, near-duplicates, 10 000 and 100 000 bookmarks, a newer schema, a pre-schema-1 library, a foreign file, damaged pages, a file that is not SQLite.

```powershell
cargo run --example test_libraries --manifest-path src-tauri/Cargo.toml
bun scripts/open-test-libraries.mjs
```

The second script opens each library with the built app and prints whether it opened or which error screen it showed.

## Site

```powershell
bun run site:check
```

Builds the site and checks every page in every language at several widths and both themes: no horizontal scroll or truncated labels, no requests to other domains, no console errors or broken images, working internal links, the feedback form against a fake endpoint.

## Known flaky or limited areas

| Area | Why |
| --- | --- |
| Visual comparisons | Depend on the machine's font rendering; not run in CI. |
| `test:native`, `test:extension` | Write screenshots into tracked files, so the working copy shows changes after a local run. |
| `test:native` | Fails if port 9225 is taken. |
| Extension smoke tests | Depend on browser alarms, which browsers may delay; a run can take a few minutes. |
| Playwright's default Chromium | On some Windows machines the copy in `%LOCALAPPDATA%\ms-playwright` fails to start (`spawn UNKNOWN`); install browsers elsewhere and set `PLAYWRIGHT_BROWSERS_PATH`. |
| Native tests in GitHub Actions | Not enabled: on the hosted Windows runner WebView2 did not open the debugging port. |
| Run folders | Tests do not delete their `.test-data` folders; `bun run clean` does ([building.md](building.md#cleaning-test-leftovers)). |
