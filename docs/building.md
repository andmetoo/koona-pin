# Building from source

Koona Pin builds on Windows 11 and on current Linux distributions (Ubuntu, Debian, Fedora, Arch). macOS (Apple Silicon) builds too and has an [experimental test build](macos-test.md); its release build is not signed by Apple yet.

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

`tauri dev` starts Vite on `localhost:1420` and the app with hot reload. It opens your real library (`%APPDATA%\Koona\Pin` or `~/.local/share/Koona/Pin`). To keep a separate one while developing, point `KOONAPIN_DATA_DIR` at another folder:

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
| macOS release `.app` in a ZIP and a `.dmg` (on a Mac) | `bun run build:macos` | `release/publish/macos/<version>/<arch>/` with `SHA256SUMS.txt` |
| Linux `.deb`, `.rpm` and AppImage | `bun run build:linux` | `release/publish/linux/<version>/` with `SHA256SUMS.txt` |
| AUR `PKGBUILD` and `.SRCINFO` | `bun run build:aur` | `release/publish/aur/<version>/` |
| Extension store packages | `bun run extension:build` | `release/publish/chrome/<version>/`, `release/publish/edge/<version>/` |
| Site | `bun run site:build` | `release/publish/site/` |

Notes:

- `tauri.conf.json` keeps bundling off, so `bun run tauri build` makes no installer. Only `build:installer` makes one.
- `build:installer`, `build:linux` and `build:macos` compile with `--features public-release`, which requires `KOONAPIN_FEEDBACK_URL` at build time (the address the feedback dialog posts to). Copy `.env.example` to `.env` and set it, or set it in the environment; the environment wins. A public-release build accepts only the store builds of the extension, not the development build.
- `build:linux` compiles the binaries once on Void Linux and packs them per system, as CI does ([testing.md](testing.md#linux-compile-once-test-everywhere)). On macOS or Windows it runs each stage in Docker, in the CI's own images from GHCR: compile in `void`, the `.deb` in `debian`, the `.rpm` in `fedora`. That needs Docker; the images are amd64, so on Apple Silicon they run emulated and the compile stage takes a long while. Node modules, Cargo's target and download caches live in Docker volumes (`koona-build-*`), apart from the host's. On Linux it runs the stages directly, without Docker, and then needs the tools of all of them (`rpmbuild`, `dpkg-shlibdeps`, `objdump`) besides the packages of `deps.sh`.
- `bun run build:linux -- --from-ci <run id|v<version>>` builds nothing: it downloads the `koonapin-linux-x86_64` artifact of a CI run (for a tag, the newest `release.yml` run of it) with `gh`, checks it against its `SHA256SUMS.txt` and puts it in `release/publish/linux/<version>/`.
- `build:macos` makes an ad hoc signed bundle, which Gatekeeper asks the Mac owner to approve. With `APPLE_SIGNING_IDENTITY` (a Developer ID Application identity in the keychain) Tauri signs it, and with `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH` (or `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`) it also notarizes.
- `build:aur` reads the `.deb` that `build:linux` put in `release/publish/linux/<version>/`.

Official releases are signed (Windows code signing, the update key and Firefox add-on signing); none of that is needed for local builds. An unsigned Windows installer works but triggers a SmartScreen warning. `bun run build:windows` (the same as `build:installer -- --sign`) makes the signed installer in `release/publish/windows/<version>/`; it needs `SIGN_CERT_SHA1`, `signtool` and Certum SimplySign Desktop signed in, so it runs only on the maintainer's Windows computer.

**The version and its changelog go together.** The PR that bumps the app's version (`package.json`, `src-tauri/Cargo.toml`, the `koonapin` package in `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`) also adds `site/content/changelog/<version>.md`: a `date` in the front matter and a few lines in plain English about what changed for people, the way the earlier files read. `bun run version:bump <x.y.z>` writes the number to the four places and starts the changelog file; `bun run release:tag` refuses to tag without it, the release's notes are taken from it, the site's changelog page lists it, and the update dialog shows it as «What's new».

## Releases

A release is the tag `v<version>` on a commit of `main`, a GitHub Release built from it, and the site serving it. `bun run release` shows where the release of this checkout's version stands and the next step; it changes nothing.

1. `bun run version:bump 0.12.0` in a branch, write `site/content/changelog/0.12.0.md`, open the pull request and merge it.
2. `bun run release:tag` on `main` (equal to `origin/main`, nothing uncommitted): checks the version and the changelog, then creates and pushes `v0.12.0`. `-- --dry-run` only checks.
3. The tag starts `.github/workflows/release.yml`. It checks the tag again, runs the whole Linux pipeline with `release: true` (the packages signed for the updater), builds macOS for Apple Silicon (`build:macos`), and puts it all in a **draft** GitHub Release whose notes come from the changelog file.
4. On the Windows computer, `git switch --detach v0.12.0`, then `bun run release:windows`: builds and signs the installer, uploads it to the draft as `koonapin_<version>_x64-setup.exe` with `SHA256SUMS-windows.txt`, and starts `release.yml`'s finalize (`gh workflow run release.yml -f tag=v0.12.0`). `-- --no-build` uploads an installer already built from the tag's commit; `-- --no-finalize` leaves finalize for later.
5. Finalize signs the installer for the updater, writes `latest.json` (`build:latest`) and the AUR's `PKGBUILD` and `.SRCINFO` (`build:aur`), attaches them and publishes the release. Run by hand with `only: linux`, it publishes without a new Windows installer.
6. `bun run release:site -- -Server user@host` downloads the published packages, their `.sig` and `latest.json` into `release/publish/updates/<version>/` and deploys the site with `scripts/deploy-site.ps1`: updates come from the site, not from GitHub (Р-60). The AUR files are pushed to `aur.archlinux.org/koonapin-bin.git` by hand.

**Why the Windows installer is built on the maintainer's computer.** Tauri signs while it bundles: first `koonapin.exe`, `koonapin-host.exe`, `koonapin-mcp.exe` and the uninstaller, then it packs them into the NSIS installer. Signing a finished `setup.exe` afterwards would leave the programs inside it unsigned, and NSIS cannot be repacked without rebuilding. Certum signs only through SimplySign on that computer, so the release installer is built there; the Windows job of `ci.yml` builds an unsigned one only to check the packaging.

The GitHub release has, for version `<v>`: `koonapin_<v>_amd64.deb`, `koonapin-<v>-1.x86_64.rpm`, `koonapin-<v>-x86_64.AppImage` with their `.sig`, `koonapin-<v>-macos-arm64.zip` and `.dmg`, `koonapin_<v>_x64-setup.exe` with its `.sig`, `SHA256SUMS-linux.txt`, `SHA256SUMS-macos.txt`, `SHA256SUMS-windows.txt`, `SHA256SUMS.txt` and `latest.json` of the updates, `koonapin-bin.PKGBUILD` and `koonapin-bin.SRCINFO`.

### Repository secrets

Set once from `.env` with `bun run ci:secrets` (`scripts/ci-secrets.mjs`: each value goes to `gh secret set` on its standard input, `--dry-run` only lists them), or one by one with `gh secret set <name>`:

| Secret | Used for |
| --- | --- |
| `KOONAPIN_FEEDBACK_URL` | The feedback address compiled into release builds. Without it a pull request build uses a placeholder; a release fails. |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `PADDLE_ENVIRONMENT` | Supporter sign-in and payments. Without them the build turns Supporter off. |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The updater's signatures (`.sig`) of the packages and the installer. |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_PRIVATE_KEY` | Optional, for later: Developer ID signing and notarization of the macOS build (the certificate as base64 `.p12`, the App Store Connect key as the text of its `.p8`). Without them macOS is signed ad hoc. |

The CI images in GHCR (`koona-ci-*`) should be public, so `build:linux` pulls them without logging in.

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
