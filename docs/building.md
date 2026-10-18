# Building from source

Koona Pin builds on Windows 11, on macOS 15 or later on Apple Silicon, and on current Linux distributions (Ubuntu, Debian, Fedora, Arch). The Mac's test build, release build and Safari extension are described in [macos-test.md](macos-test.md).

## Prerequisites

All platforms:

- **Bun**, the exact version in `.bun-version`. Node.js is not needed: scripts, Vite, Vitest, Playwright and the Tauri CLI all run on Bun.
- **Rust** through rustup. `rust-toolchain.toml` pins the version and rustup installs it on first use. Do not set `RUSTUP_TOOLCHAIN`, it overrides the file.

Windows:

- Microsoft C++ Build Tools (the "Desktop development with C++" workload).
- WebView2 Runtime (part of Windows 11).

Linux:

```bash
bash scripts/linux/deps.sh                                       # Tauri 2 system packages, uses sudo
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal   # rust-toolchain.toml picks the version
curl -fsSL https://bun.sh/install | bash -s "bun-v$(cat .bun-version)"
```

`deps.sh` knows Ubuntu, Debian, Fedora and Arch.

## Install and run

```powershell
bun install
bun run tauri dev
```

`tauri dev` starts Vite on `localhost:1420` and the app with hot reload. It opens your real library (`%APPDATA%\Koona\Pin`, `~/Library/Application Support/Koona/Pin` or `~/.local/share/Koona/Pin`). To keep a separate one while developing, point `KOONAPIN_DATA_DIR` at another folder:

```powershell
$env:KOONAPIN_DATA_DIR = "$PWD\.test-data\dev"; bun run tauri dev
```

```bash
KOONAPIN_DATA_DIR=$PWD/.test-data/dev bun run tauri dev
```

The app is single-instance per user: if an installed Koona Pin is running, a development build hands over to it and exits. Quit the installed one from its tray menu first.

On Linux with NVIDIA under Wayland, an empty or black window is a known WebKitGTK issue; `WEBKIT_DISABLE_DMABUF_RENDERER=1` works around it.

Always run scripts as `bun run <script>`. Bun is configured (`bunfig.toml`) not to load `.env` by itself; the scripts and `src-tauri/build.rs` read it where needed.

## Browser preview with demo data

```powershell
bun run dev
```

This serves the interface alone at `http://localhost:1420` in any browser. Without Tauri, the interface uses a demo adapter (`src/services/demo.ts`) with its own sample library in `localStorage`, in the language of the interface. It never touches a real SQLite library. The demo library is recreated on reload until you change something.

This is the fastest way to work on layout, and it is what the Playwright UI tests drive.

## Screenshots for the site and the stores

```bash
bun run site:shots:mac
bun scripts/store-assets.mjs
```

On a Mac, the first command shoots the real window of a debug build: the sample library of `scripts/shots/library.json` and the feeds of `scripts/shots/feeds.json`, in grid, list, reading, feeds, triage and sync views, light and dark, in English only. It writes `release/shots/app-en-<theme>-<view>.webp` (1920 px) and `-1280.webp`; copy them to koona-site's `pin/src/shots/` and the three README ones to `docs/shots/`. The script drives the page through `KOONAPIN_SHOTS_SOCKET` (`src-tauri/src/shots.rs`), which exists only in builds without `public-release`. Quit your own Koona Pin first, and allow Screen Recording for the terminal. The sync dialog comes from the browser preview, since the real one needs a plan and a second computer. On Windows, `bun run site:shots` does the same through WebView2. The second command makes the store images in `extension/store/en/`.

## The browser extension

```powershell
bun run extension:build
```

This writes unpacked extensions to `release/dev/chrome`, `release/dev/edge` and `release/dev/firefox`. Loading them and connecting them to a development build of the app is described in [extension.md](extension.md).

## Local builds without signing

| What | Command | Output |
| --- | --- | --- |
| App executable only | `bun run tauri build` | `src-tauri/target/release/` |
| Windows installer (NSIS), unsigned | `bun run build:installer` | `release/test/windows/<version>/`, installer and `SHA256SUMS.txt` |
| macOS test `.app` in a ZIP (on a Mac) | `bun run build:macos:test` | `release/test/macos/<version>/<arch>/`, ZIP, checksums and build metadata |
| macOS release `.app` in a ZIP and a `.dmg` (on a Mac) | `bun run build:macos` | `release/publish/macos/<version>/<arch>/` with `SHA256SUMS.txt`; the DMG by dmgbuild (Python 3.10+) |
| Linux `.deb`, `.rpm` and AppImage | `bun run build:linux` | `release/publish/linux/<version>/` with `SHA256SUMS.txt` |
| AUR `PKGBUILD` and `.SRCINFO` (the package is not published) | `bun run build:aur` | `release/publish/aur/<version>/` |
| Android App Bundle and arm64 APK, signed with the debug key | `bun run build:android` | `release/test/android/<version>/` with `SHA256SUMS.txt` |
| iOS Simulator `.app` (Apple Silicon) | `bun run build:ios:sim` | `release/test/ios-simulator/<version>/` |
| Extension store packages | `bun run extension:build` | `release/publish/chrome/<version>/`, `release/publish/edge/<version>/` |
| Updater feed and release data | `bun run build:latest`, `bun run build:release-data` | `release/publish/updates/<version>/`: packages with `.sig`, `latest.json`, `SHA256SUMS.txt`, `release.json`, and the macOS DMG with its `.sig` when `release/publish/macos/<version>/arm64/` has it |

Notes:

- `tauri.conf.json` keeps bundling off, so `bun run tauri build` makes no installer. Only `build:installer` makes one.
- `build:installer`, `build:linux` and `build:macos` compile with `--features public-release`, which requires `KOONAPIN_FEEDBACK_URL` at build time (the address the feedback dialog posts to). Copy `.env.example` to `.env` and set it, or set it in the environment; the environment wins. A public-release build accepts only the store builds of the extension, not the development build.
- `build:linux` compiles the binaries once on Void Linux and packs them per system, as CI does ([testing.md](testing.md#linux-compile-once-test-everywhere)). On macOS or Windows it runs each stage in Docker, in the CI's own images from GHCR: compile in `void`, the `.deb` in `debian`, the `.rpm` in `fedora`. That needs Docker; the images are amd64, so on Apple Silicon they run emulated and the compile stage takes a long while. Node modules, Cargo's target and download caches live in Docker volumes (`koona-build-*`), apart from the host's. On Linux it runs the stages directly, without Docker, and then needs the tools of all of them (`rpmbuild`, `dpkg-shlibdeps`, `objdump`) besides the packages of `deps.sh`.
- `bun run build:linux -- --from-ci <run id|v<version>>` builds nothing: it downloads the `koonapin-linux-x86_64` artifact of a CI run (for a tag, the newest `release.yml` run of it) with `gh`, checks it against its `SHA256SUMS.txt` and puts it in `release/publish/linux/<version>/`.
- `build:macos` makes an ad hoc signed bundle, which Gatekeeper asks the Mac owner to approve. With `APPLE_SIGNING_IDENTITY` (a Developer ID Application identity in the keychain) Tauri signs it and the script adds the Safari extension, signed the same way, and with `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH` (or `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`) the script notarizes and staples the app. The DMG is made by dmgbuild with the window of `src-tauri/macos/dmg` ([macos-test.md](macos-test.md#release-build)), which needs Python 3.10 or later; with an identity it is signed with `codesign`, and with the notarization variables notarized and stapled as well.
- The phone builds (NP-151) use the projects Tauri generated, committed in `src-tauri/gen/android` and `src-tauri/gen/apple`; Gradle and Xcode call `bun run tauri` of the root `package.json`. `build:android` needs the Android SDK with platform 37 and an NDK r28 or newer (`ANDROID_HOME`, `NDK_HOME`), JDK 17 or newer and the Rust target `aarch64-linux-android`; it checks that the APK keeps Android's 16 KB pages (`zipalign -P 16`, ELF LOAD alignment). `build:ios:sim` needs Xcode with the Simulator runtime of its own SDK (the Tauri CLI refuses an older one), XcodeGen, CocoaPods and the target `aarch64-apple-ios-sim`; its release build also rustup's `llvm-tools` (swift-rs keeps the plugins' Swift entry points exported with it), which `rust-toolchain.toml` does not list, so other builds don't download it: `rustup component add llvm-tools` (the script names the toolchain). The Android build also checks that the plugin forwards every callback of wry's WebViewClient. On Android a WebView older than 111 gets a native «Update Android System WebView» screen instead of the interface. Neither is signed for a store; the iOS build runs only in the Simulator.
- `build:aur` reads the `.deb` that `build:linux` put in `release/publish/linux/<version>/`. The script and the recipe in `src-tauri/linux/aur` are kept, but the AUR package `koonapin-bin` is not published.
- `.kpin` lists and `koonapin://import?url=…` links open the app only where a package registered them. On macOS and Windows the bundler does it from `bundle.fileAssociations` and `plugins.deep-link` in `tauri.conf.json` (the macOS UTI is `app.koona.pin.list`, conforming to `public.json`); macOS registers the scheme only for an installed or opened `.app` bundle, so `bun run tauri dev` cannot test it. The `.deb` and the `.rpm` install `koonapin.desktop` with `MimeType=application/vnd.koona.list+json;x-scheme-handler/koonapin;` and `Exec=koonapin %U`, and `src-tauri/linux/koonapin-mime.xml` as `/usr/share/mime/packages/koonapin.xml` for `*.kpin`. The AppImage registers nothing unless AppImageLauncher (or a similar tool) integrates it: there a list is opened with **Import…** or by dropping the file on the window, and a `koonapin://` link does nothing. Whatever the system passes, the app takes only an existing `.kpin` file or a `koonapin://import?url=https://…` link (`src-tauri/src/open_requests.rs`) and asks before it reads or downloads anything.

Official releases are signed (Windows code signing, the update key and Firefox add-on signing); none of that is needed for local builds. An unsigned Windows installer works but triggers a SmartScreen warning. `bun run build:windows` (the same as `build:installer -- --sign`) makes the signed installer in `release/publish/windows/<version>/`; it needs `SIGN_CERT_SHA1`, `signtool` and Certum SimplySign Desktop signed in, so it runs only on the maintainer's Windows computer.

**The version and its changelog go together.** The PR that bumps the app's version (`package.json`, `src-tauri/Cargo.toml`, the `koonapin` package in `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`) also adds `changelog/<version>.md`: a `date` in the front matter and a few lines in plain English about what changed for people, the way the earlier files read. `bun run version:bump <x.y.z>` writes the number to the four places and starts the changelog file; `bun run release:tag` refuses to tag without it, the release's notes are taken from it, `release.json` carries it to the site's changelog page, and the update dialog shows it as «What's new».

## Phone builds: how the code is split

The phone builds (NP-151) share the Rust core and the React interface with the desktop. These rules keep the two apart as phone features are added:

- **Desktop-only is left out, not stubbed.** Desktop-only crates sit in the non-mobile target section of `src-tauri/Cargo.toml`; desktop-only modules and commands are behind `#[cfg(desktop)]` and registered only on desktop. A phone never gets a command that pretends to work.
- **`plugins/koona-mobile` hosts the WebView, nothing else:** system Back and the iOS edge swipe, the safe-area insets, renderer loss, the WebView version check, and later memory warnings and the iOS background task. Share intake, secure storage and store purchases get plugins of their own (`koona-share`, `koona-secrets`, a store plugin under `commercial/` behind a Cargo feature, so the site's APK carries no Play Billing).
- **Types that cross IPC are never `cfg`-gated.** `src/bindings` are written by `cargo test` on a desktop; a `#[ts(export)]` type behind `cfg(mobile)` would never be exported. Only commands and native glue are gated.
- **No new files "beside the library" on phones.** On a phone the app's data folder is backed up nowhere and its cache folder may be cleared by the system; anything new goes through an explicit place (the planned `AppDirs`, NP-153), and secrets go to the Keystore or the Keychain, not to files.
- **Shared interface code asks what the app can do, not which system it is on.** `isMobile` in `src/services/platform.ts` is a stopgap for this build; NP-072 replaces it with a capability object from Rust and a separate phone shell, and desktop-only parts of the interface move into the desktop shell.
- **Nothing leaves the phone through Android backup or device transfer** (`allowBackup="false"` and `res/xml/data_extraction_rules.xml`): the app's folder holds the sync identity and the account, and a copy would clone the device.
- **Hand edits in the generated projects** (`src-tauri/gen`): edge to edge in `MainActivity.kt`, the SDK levels and debug signing in `app/build.gradle.kts`, `windowSoftInputMode`, `allowBackup` and the extraction rules in the manifest, the `bun` pre-build script and iOS 18 in `gen/apple/project.yml`. Port them when Tauri regenerates the projects.

## Releases

A release is the tag `v<version>` on a commit of `main`, a GitHub Release built from it, and its data deployed to koona.app. `bun run release` shows where the release of this checkout's version stands and the next step; it changes nothing.

1. `bun run version:bump 0.12.0` in a branch, write `changelog/0.12.0.md`, open the pull request and merge it.
2. `bun run release:tag` on `main` (equal to `origin/main`, nothing uncommitted): checks the version and the changelog, then creates and pushes `v0.12.0`. `-- --dry-run` only checks.
3. The tag starts `.github/workflows/release.yml`. It checks the tag again and waits for the commit's CI on `main` (the check `CI`), refusing a commit whose CI is not green, because the release does not test again: the Linux pipeline with `release: true` only compiles and packs (the packages are then signed for the updater). It builds macOS for Apple Silicon (`build:macos`), and puts it all in a **draft** GitHub Release whose notes come from the changelog file.
4. On the Windows computer, `git switch --detach v0.12.0`, then `bun run release:windows`: builds and signs the installer, uploads it to the draft as `koonapin_<version>_x64-setup.exe` with `SHA256SUMS-windows.txt`, and starts `release.yml`'s finalize from the tag (`gh workflow run release.yml --ref v0.12.0 -f tag=v0.12.0`: the environment holding the update key lets in tags only). `-- --no-build` uploads an installer already built from the tag's commit; `-- --no-finalize` leaves finalize for later. Do not publish the draft by hand: finalize publishes it. One published too early has no `latest.json` and is not on koona.app; `bun run release:windows -- --redraft` turns it back into a draft and goes on.
5. Finalize signs the installer for the updater, writes `latest.json` (`build:latest`), the AUR's `PKGBUILD` and `.SRCINFO` (`build:aur`) and `release.json` signed with the update key (`scripts/build-release-data.mjs`), attaches them and publishes the release. `build-release-data.mjs` also takes the draft's macOS DMG (`release/publish/macos/<version>/arm64/`), signs it with the update key bound to the version and lists it as `files.macos` of `release.json`, so the site offers it at `/pin/downloads/<version>/koonapin-<version>-macos-arm64.dmg`. The Mac's `.app.tar.gz`, made by a Developer ID build and signed for the updater in the draft, goes into `latest.json` as `macos-aarch64` (the key Koona Pin 1.2.2 and later read; earlier versions read `darwin-aarch64` and cannot install, so they get nothing) and into `release.json` as `files.macosUpdate`, so koona-deploy serves it. Run by hand with `only: linux`, it publishes without a new Windows installer.
6. Its job «Deploy to koona.app» streams the release data (`release.json`, `latest.json`, `SHA256SUMS.txt`, and every file `release.json` lists with its `.sig`: the packages, the Mac's update and the macOS DMG) over SSH to the server's `koona-deploy` (`ssh deploy@<host> app v0.12.0`), which checks every signature against the update key's public half before it serves them: updates come from koona.app, not from GitHub (Р-60). Without `DEPLOY_HOST` it is skipped with a warning; a failed deploy reruns alone (`gh run rerun <run> --failed`). Its job «AUR», which would push the release's `PKGBUILD` and `.SRCINFO` to `aur.archlinux.org/koonapin-bin.git`, is turned off (`if: false`) while the AUR package is not published.

The site itself (the pages of koona.app and koona.app/pin, its Caddy configuration and the server's `koona-deploy`) lives in its own repository, `andmetoo/koona-site`, and is released from there. Its release-dependent pages (the landing's download block, `/pin/downloads/`, `/pin/changelog/`) read `release.json` at request time, so a new app release needs no site build. The addresses this repository relies on (`ORIGIN`, `BASE`, the site's languages) are in `scripts/lib/site.mjs`.

**Why the Windows installer is built on the maintainer's computer.** Tauri signs while it bundles: first `koonapin.exe`, `koonapin-host.exe`, `koonapin-mcp.exe` and the uninstaller, then it packs them into the NSIS installer. Signing a finished `setup.exe` afterwards would leave the programs inside it unsigned, and NSIS cannot be repacked without rebuilding. Certum signs only through SimplySign on that computer, so the release installer is built there, and the Windows job of `ci.yml` runs only the Rust tests.

The GitHub release has, for version `<v>`: `koonapin_<v>_amd64.deb`, `koonapin-<v>-1.x86_64.rpm`, `koonapin-<v>-x86_64.AppImage` with their `.sig`, `koonapin-<v>-macos-arm64.zip` and `.dmg` (the DMG with its `.sig` from finalize), `koonapin_<v>_x64-setup.exe` with its `.sig`, `SHA256SUMS-linux.txt`, `SHA256SUMS-macos.txt`, `SHA256SUMS-windows.txt`, `SHA256SUMS.txt`, `latest.json` and `release.json` with its `.sig` of the updates, and `koonapin-bin.PKGBUILD` and `koonapin-bin.SRCINFO`, which nothing publishes yet.

### Repository secrets

Set once from `.env` with `bun run ci:secrets` (`scripts/ci-secrets.mjs`: each value goes to `gh secret set` on its standard input, `--dry-run` only lists them), or one by one with `gh secret set <name>`:

| Secret | Used for |
| --- | --- |
| `KOONAPIN_FEEDBACK_URL` | The feedback address compiled into release builds. Without it a pull request build uses a placeholder; a release fails. |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `PADDLE_ENVIRONMENT` | Supporter sign-in and payments. Without them the build turns Supporter off. |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The updater's signatures (`.sig`) of the packages and the installer. Secrets of the **environment `release`**, not of the repository (`ci:secrets` puts them there): it lets in jobs started from a tag `v*` only, and only `release.yml`'s draft and finalize declare it, so no pull request, branch or run on `main` can read the key. |
| `AUR_SSH_KEY`, `AUR_KNOWN_HOSTS` | Not needed while the AUR package is not published: `release.yml`'s job «AUR», which reads them, is off. When it is turned on: the private SSH key of the maintainer's AUR account and the line of `ssh-keyscan -t ed25519 aur.archlinux.org`, in the environment `release`. |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_PRIVATE_KEY` | Developer ID signing and notarization of the macOS build, and its Safari extension (the certificate as base64 `.p12`, the App Store Connect key as the text of its `.p8`). Environment `release`, like the update key: only the macOS job of `release.yml` declares it. `bun run ci:secrets APPLE_` sets just these, reading the `.p12` from `APPLE_CERTIFICATE_PATH` and the `.p8` from `APPLE_API_KEY_PATH`, and prints names only. Without them macOS is signed ad hoc, without Safari. |

The CI images in GHCR (`koona-ci-*`) should be public, so `build:linux` pulls them without logging in.

Besides the environment, the repository guards releases with two rulesets on tags `v*`: only administrators create them, and nobody moves or deletes one. Workflows of pull requests from forks run only after a maintainer approves them (Settings → Actions → «Require approval for all external contributors»).

## Where outputs go

Everything meant to leave the repository goes under `release/`, which Git ignores. One file defines the folders: [`scripts/lib/paths.mjs`](../scripts/lib/paths.mjs).

- `release/publish/` — for people and stores.
- `release/test/` — for a test machine only, never published.
- `release/dev/` — for this computer only (unpacked extensions).

Tool working folders are not outputs and nothing should be taken from them by hand: `src-tauri/target` (Cargo and Tauri) and `dist/` (the built interface that Tauri embeds).

## Cleaning test leftovers

Each test run and smoke script keeps its own folder in `.test-data`, and Rust tests leave `koonapin-*` folders in the system temp folder. They add up quickly.

```powershell
bun run clean                 # .test-data (except libraries), test-results, playwright-report, koonapin-* in temp
bun run clean -- --list       # show what the generated folders take; removes nothing
bun run clean -- --cargo      # also the Cargo build folders: the next build starts from scratch
```

Anything changed in the last 30 minutes is kept, so a test running in another terminal keeps its folder. `release/` is never touched. `bun run clean` runs by itself before `check`, `test:native`, `test:host`, `test:extension`, `test:extension:firefox`, `build:installer`, `build:windows` and `build:linux`.

## Troubleshooting

- After moving the project folder, if `cargo test` cannot find files under `target\...\tauri-*\out`: `cargo clean -p tauri --manifest-path src-tauri/Cargo.toml`.

Checks before sending a change are in [testing.md](testing.md).
