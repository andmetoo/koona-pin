# Building from source

Koona Pin builds on Windows 11 and on current Linux distributions (Ubuntu, Debian, Fedora, Arch). macOS is not supported.

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
| Linux `.deb`, `.rpm` and AppImage | `bun run build:linux` | `release/publish/linux/<version>/` |
| AUR `PKGBUILD` and `.SRCINFO` | `bun run build:aur` | `release/publish/aur/<version>/` |
| Extension store packages | `bun run extension:build` | `release/publish/chrome/<version>/`, `release/publish/edge/<version>/` |
| Site | `bun run site:build` | `release/publish/site/` |

Notes:

- `tauri.conf.json` keeps bundling off, so `bun run tauri build` makes no installer. Only `build:installer` makes one.
- `build:installer` and `build:linux` compile with `--features public-release`, which requires `KOONAPIN_FEEDBACK_URL` at build time (the address the feedback dialog posts to). Copy `.env.example` to `.env` and set it, or set it in the environment; the environment wins. A public-release build accepts only the store builds of the extension, not the development build.
- On Linux, `build:linux` builds directly and needs `rpm` (rpmbuild) besides the packages of `deps.sh`. On Windows it runs the `build` job of `.github/workflows/linux.yml` in Docker through [act](https://github.com/nektos/act) on Debian 13, the oldest glibc of the test matrix, and unpacks the artifact. That needs Docker and act; `bun run build:linux -- --unpack` only unpacks the artifact of the last act run.
- `build:aur` reads the `.deb` that `build:linux` put in `release/publish/linux/<version>/`.

Official releases are signed by the maintainer (Windows code signing, the update key and Firefox add-on signing); none of that is needed for local builds. An unsigned Windows installer works but triggers a SmartScreen warning.

## Where outputs go

Everything meant to leave the repository goes under `release/`, which Git ignores. One file defines the folders: [`scripts/lib/paths.mjs`](../scripts/lib/paths.mjs).

- `release/publish/` — for people and stores.
- `release/test/` — for a test machine only, never published.
- `release/dev/` — for this computer only (unpacked extensions).

Tool working folders are not outputs and nothing should be taken from them by hand: `src-tauri/target` (Cargo and Tauri) and `dist/` (the built interface that Tauri embeds).

## Cleaning test leftovers

Each test run and smoke script keeps its own folder in `.test-data`, and Rust tests leave `koonapin-*` folders in the system temp folder. They add up quickly.

```powershell
bun run clean                 # .test-data (except libraries, act-artifacts), test-results, playwright-report, koonapin-* in temp
bun run clean -- --list       # show what the generated folders take; removes nothing
bun run clean -- --cargo      # also the Cargo build folders: the next build starts from scratch
```

Anything changed in the last 30 minutes is kept, so a test running in another terminal keeps its folder. `release/` is never touched. `bun run clean` runs by itself before `check`, `test:native`, `test:host`, `test:extension`, `test:extension:firefox`, `build:installer` and `build:linux`.

## Troubleshooting

- After moving the project folder, if `cargo test` cannot find files under `target\...\tauri-*\out`: `cargo clean -p tauri --manifest-path src-tauri/Cargo.toml`.

Checks before sending a change are in [testing.md](testing.md).
