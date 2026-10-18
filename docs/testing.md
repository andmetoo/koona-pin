# Testing

`.github/workflows/ci.yml` runs on every pull request, every push to `main` and by hand. A pull request runs what its files can break: only `docs/`, `changelog/` and Markdown, nothing; scripts, tests and the Linux pipeline, the Linux jobs; the app, its dependencies, toolchains or `ci.yml` itself, everything. Pushes to `main` run everything. `main` requires two checks: `CLA` and `CI`, a summary job that waits for all three platforms and fails if a required job fails or is cancelled. The package and distribution jobs (.deb, .rpm, Ubuntu, WebKitGTK, the packages artifact) are advisory in CI: their failures do not fail the summary, but it still waits for them to finish. A release waits for that commit's `CI`, then compiles and packs without repeating the tests; its packaging jobs must succeed before a draft is prepared. Run the checks locally before you push. It has three parts:

- **Linux**, the main platform: the reusable workflow `.github/workflows/linux.yml` runs every main test (Rust tests, bindings, build, Vitest, extension lint, Playwright UI without `@visual`) and checks the packages on each distribution. See [Linux](#linux-compile-once-test-everywhere).
- **Windows** (`windows-2025`): the Rust tests, for what differs on Windows (paths, the native host's registry, the single-instance pipe). The installer is not built in CI: the signed one is built on the maintainer's computer (`bun run release:windows`).
- **macOS** (macOS 15, Apple Silicon; Intel is temporarily disabled): the Rust tests, a build of the app bundle and of the Safari extension target. It uploads nothing and runs nothing in WKWebView. See [macOS builds and testing](macos-test.md) for commands and the remaining platform work.

No check touches your own library or browser profile: tests create their own SQLite files, WebView2 and browser profiles under `.test-data`, and their own capture channel name (`KOONAPIN_PIPE`). Prerequisites are those of [building.md](building.md).

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
- `@chromium` — the two IME tests use Chromium's CDP; exclude these when running WebKit. They remain covered by the full suite in CI (Chromium on Linux).

Run a subset with `bun run test:ui -- --grep @languages` or `-- --grep-invert @visual`. Use `bunx` only with `--bun`; without it, `bunx` runs a package on Node if Node is installed.

## Native tests (Windows, WebView2)

```powershell
bun run test:native
```

`tests/native` drives the real app through the WebView2 debugging port (9225) with Playwright: the real SQLite, IPC, CSP, window, tray and the host. Before running, the script builds the app under test (`scripts/build-test-app.mjs`): the interface, then a debug binary with the interface embedded (`cargo build --features custom-protocol`), so CSP and origin are as in a release. A plain `cargo build` binary loads Vite instead and has no CSP; the native tests refuse it with an explanation.

Needs:

- No running Koona Pin. The app is single-instance per user, so a test build would hand over to it. The scripts stop with a hint if one is running.
- Port 9225 free (another WebView2 app with debugging on can hold it).

To test a release binary instead: build it with `cargo build --release --features custom-protocol --locked` in `src-tauri` and set `KOONAPIN_TEST_BINARY=src-tauri/target/release/koonapin.exe` for `test:native`, `test:host`, `test:mcp` and the extension smoke tests. The host and the MCP server are taken from the same folder.

`bun run test:perf` runs the scrolling benchmark (tag `@perf`, 10 000 bookmarks in grid and list). Run it after changes to the grid or list.

## Native host smoke test

```powershell
bun run test:host
```

`scripts/smoke-host.mjs` sends browser-shaped messages to `koonapin-host`: `hello` does not start a closed app, capture starts it in the tray, receipts, duplicates, invalid URLs, `request_id` conflicts, an old protocol.

## MCP smoke test

```powershell
bun run test:mcp
```

`scripts/smoke-mcp.mjs` drives the built `koonapin-mcp` over stdio as an assistant does, on its own library and pipe: `initialize`, `tools/list` keeps a closed app closed and the first call starts it in the tray, off reads nothing, read only finds a bookmark by a word and refuses to add, read and add saves to the inbox from `mcp` once, `list_changed`, move, tag, star, an unknown tool, and the copy inside a `.mcpb` handing over to the installed server.

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

## Linux: compile once, test everywhere

`.github/workflows/linux.yml` is called by `ci.yml` and by `release.yml` (with `release: true`, which only compiles and packs: the release requires the commit's CI on `main` to be green instead of testing again), and starts by hand through **Actions → Linux → Run workflow**. The binaries are compiled once, on Void Linux with glibc, and every package job packs and checks those very binaries on its own distribution.

| Job | Image | What it checks |
| --- | --- | --- |
| `images` | — | Finds the CI images below in GHCR, or builds and pushes the missing ones. |
| `build` | `void` | The release build (`build-linux-packages.mjs --stage compile`): stripped binaries, Tauri's raw `.deb` and the AppImage. `scripts/linux/check-glibc.sh` fails it if a binary needs a glibc newer than 2.41, the oldest of the matrix (Debian 13). |
| `test` | `void` | The main tests: Rust tests, bindings unchanged, TypeScript and Vite build, Vitest, extension lint; then a development build for `deb`. |
| `ui` | `ui` | Playwright UI without `@visual`, in Chromium. |
| `deb-package` | `debian` | Packs the `.deb` (`--stage deb`) from the release build and uploads `linux-deb`. Does not wait for the development build or distribution tests. |
| `deb` | `debian` | Checks `linux-deb` with `lintian`, `desktop-file-validate`, `appstreamcli validate`; the AppImage, the installed package, the native WebKitGTK tests, host registration with Debian's Chromium and Firefox ESR, Chrome and Edge, the extension smoke test, reinstall and removal. Needs the development build from `test`; skipped in releases. |
| `rpm` | `fedora` | Packs the `.rpm` (`--stage rpm`, from Tauri's raw `.deb`, beside `deb-package`), `rpmlint`; the AppImage, the package with `dnf`, the native WebKitGTK tests, Fedora's Firefox and Chromium, reinstall and removal. |
| `ubuntu` | `ubuntu` | The `.deb` of `deb-package` on Ubuntu 26.04: the AppImage, the package with `apt`, the native WebKitGTK tests, reinstall and removal. |
| `arch` | `arch` | Off (`if: false`) while the AUR package is not published. When on: the AUR package `koonapin-bin` built from the `.deb` with `makepkg`, `namcap`; the AppImage, the package, the native WebKitGTK tests, Arch's Firefox and Chromium, reinstall and removal. |
| `webkitgtk` | `debian`, `ubuntu` | The interface in the distribution's WebKitGTK: key screens in every language and both themes, system theme and reduced motion. |
| `packages` | — | The `.deb`, `.rpm`, AppImage and `SHA256SUMS.txt` in one artifact, `koonapin-linux-x86_64`; for a release also their update signatures (`.sig`). |

Starting the program means: libraries resolve, start under X11 (Xvfb) and Wayland (Weston), a second instance hands over, the autostart entry, `test:host`, the window actually draws.

Debian and Ubuntu (and Arch, when its job is on) test the same `.deb` in parallel after `deb-package` finishes. The combined packages artifact still waits for Debian's tests in CI; releases skip those tests. The release's CI wait, draft, local Windows signing and finalize sequence is described in [building.md](building.md#releases).

### CI images

The jobs install nothing: toolchains, Bun and system packages are in prebuilt images, one Dockerfile per role in `scripts/linux/images/` (`void`, `debian`, `ubuntu`, `fedora`, `arch`, `ui`). An image is `ghcr.io/andmetoo/koona-ci-<role>:<tag>`, and the tag is a hash of its Dockerfile and every file it copies (`rust-toolchain.toml`, `.bun-version`, the scripts it runs). An image is rebuilt exactly when what goes into it changes; to move a rolling base (Void, Arch) to a newer release, change the date in its Dockerfile. A pull request from a fork cannot push, so it fails if it needs an image that is not there yet; a run on a branch of this repository builds it.

```bash
bun scripts/linux/images.mjs ref debian          # the full reference of one image
bun scripts/linux/images.mjs ensure              # build here what the registry does not have (Docker)
bun scripts/linux/images.mjs ensure --push void  # and push it (docker login ghcr.io first)
```

`KOONAPIN_CI_REGISTRY` sets another registry.

The Void image includes `tar`, `gzip` and `zstd` so `Swatinem/rust-cache` can save and restore its archives. Linux build and test caches are separate, saved on `main` and restored by pull requests and releases. After rebuilding the image, the first successful run on `main` populates the caches; subsequent runs can reuse them.

### Reproducing locally

There is no local runner for the workflow. The packages are built the way CI builds them with `bun run build:linux`: on macOS or Windows it runs the compile, deb and rpm stages in Docker in the same images ([building.md](building.md#local-builds-without-signing)). `bun run build:linux -- --from-ci <run id|v<version>>` takes the packages of a CI run instead. To look into a failing job, open a shell in its image with the repository mounted:

```bash
docker run --rm -it --platform linux/amd64 -v "$PWD:/work" -w /work "$(bun scripts/linux/images.mjs ref debian)" bash
```

The images run as root and have a user `dev`; the jobs run the app and the tests as `dev` (`su dev -s /bin/bash -c "bash scripts/linux/ci-smoke.sh"`). They are amd64 only; on Apple Silicon Docker emulates them, slowly.

Native tests on a Linux desktop without containers: install WebKitWebDriver from the distribution and `cargo install tauri-driver --version 2.1.0 --locked`, quit Koona Pin, then:

```bash
bun run test:webkit
```

Change shared code? Check it on Windows too (`bun run check`, `test:host`, `test:native`).

### What the matrix cannot see

Containers have no real desktop: no GNOME, KDE or Hyprland session, tray, portals, polkit, Snap Firefox, GPU, fractional scaling or input methods. These are checked by hand on a real desktop before a release.

## Visual baselines

`tests/ui/visual.spec.ts` compares screenshots with the baselines in `tests/ui/visual.spec.ts-snapshots` (both themes, grid and list, three window sizes). The test pins the date to 3 October 2026, because date groups and short dates depend on it.

They are checked only locally: font antialiasing differs between machines and even between runs on the same machine after updates, so CI runs `--grep-invert "@visual"`. The committed baselines are recorded on macOS (`*-darwin.png`); Playwright keys them by platform, so on Windows or Linux the first run writes that platform's own set and fails until you record it. Update baselines only after looking at the difference:

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

The site lives in `andmetoo/koona-site` and is checked there (every page in every language, with and without release data). Here, `bun scripts/build-release-data.mjs --no-sign --updates <folder>` checks a release folder and writes its `release.json` without the update key.

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
