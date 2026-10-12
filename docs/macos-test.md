# Experimental macOS test builds

This is a test build for [#56](https://github.com/andmetoo/koona-pin/issues/56), not the macOS release. The workflow currently tests macOS 15 on Apple Silicon (`macos-15`) only; the Intel (`macos-15-intel`) matrix entry is temporarily disabled. macOS 15 is the floor of this experiment, not a declaration of the oldest supported macOS version. There is no Developer ID signing, notarization or updater manifest yet; a version tag uploads an ad hoc signed ZIP and DMG to the draft GitHub Release (release.yml, `bun run build:macos`).

## Run and check

The `macos` job of `.github/workflows/ci.yml` runs on every pull request, every push to `main` and by hand (**Actions → CI → Run workflow**). It checks what only macOS compiles: the Rust tests (with the macOS capture socket and the browsers' manifests), then the app bundle with its TypeScript/Vite build, so a packaging problem shows. IPC types and Vitest do not depend on the system and run in the Linux part of `ci.yml`. It uploads nothing. Nothing in CI runs the app or its interface in WKWebView: the UI suite runs in Chromium and the native tests in WebKitGTK, both on Linux, so a macOS-only interface problem shows only in a hand-built `.app`.

On a Mac with Xcode Command Line Tools, Rust and the pinned Bun:

```bash
bun install --frozen-lockfile
bun run build:macos:test
```

`bun run build:macos:test` runs `scripts/build-macos.mjs --test`. The output is `release/test/macos/<version>/<arch>/`: `Koona Pin.app`, the same in a ZIP made with `ditto` (preserves bundle metadata), `SHA256SUMS.txt`, `build.json` with the exact commit, and a README. The test bundle may need the Mac owner's Gatekeeper approval. A started copy uses the normal library; set `KOONAPIN_DATA_DIR` to try it on another. Such a copy does not register with the browsers, so browser capture needs `KOONAPIN_REGISTER_HOST=1` as well (it then takes over the browsers' manifests from any installed copy until that one starts again).

`tauri.macos.conf.json` enables the normal native macOS title bar (`decorations: true`, `titleBarStyle: Visible`), with real system traffic-light controls and rounded window corners. It repeats the main-window geometry because Tauri's config merge replaces the windows array. `get_desktop` reports the actual decorated-window state; the HTML window strip is absent when the system draws the frame. The title bar follows the application's light/dark theme through Tauri's window theme API. Windows and Linux keep their existing custom controls.

The Rust HTTP tests model different hosts with loopback addresses `127.0.0.2` through `127.0.0.11`. macOS requires them to be configured explicitly; the workflow adds aliases to `lo0` before the tests. The first ARM run exposed this prerequisite (`AddrNotAvailable`), rather than an application failure; no network tests are skipped.

### Release build

`bun run build:macos` (`scripts/build-macos.mjs` without `--test`) builds with `--features public-release` and `src-tauri/tauri.macos-release.conf.json` (app and DMG, `icon.icns`, macOS 15.0 minimum), so it needs `KOONAPIN_FEEDBACK_URL` in the environment or `.env`. The output is `release/publish/macos/<version>/<arch>/`: `koonapin-<version>-macos-<arch>.zip` (`Koona Pin.app` made with `ditto --keepParent`), `koonapin-<version>-macos-<arch>.dmg` and `SHA256SUMS.txt`, whose last line says whether the build is signed and notarized. There is no signing material yet, so the bundle is signed ad hoc and Gatekeeper needs the Mac owner's approval; the script uses `APPLE_SIGNING_IDENTITY` and the notarization variables below as soon as they are set. Bundle settings stay out of `tauri.macos.conf.json`, which Tauri merges into every macOS build, `cargo test` and dev included.

## Remaining work from the documents and GitHub

Reviewed `doc/decisions.md` (Р-26 and Р-44), `doc/roadmap.md`, `doc/release-checklist.md`, the public `docs/building.md` and `docs/testing.md`, and GitHub Issues on 10 October 2026. `doc/` is a separate private notes repository, ignored by this repository; this PR keeps the review result in `docs/`.

| Work | Current evidence / next step |
| --- | --- |
| NP-048: supported macOS versions and architectures | This experiment currently tests macOS 15 on arm64 only; Intel is temporarily disabled. Choose the public matrix and check the oldest WKWebView on a real Mac; the documents require Safari 16.4-level WebKit for Tailwind 4. |
| NP-049: window, menu, Cmd shortcuts, paths, lifecycle | A native decorated title bar with real traffic lights and theme matching is in place. Manual acceptance of traffic-light actions/fullscreen, a second launch, replacing the standard menu, Cmd shortcuts, Dock reopening, autostart and tray behavior still remain. |
| NP-050: browser capture | The channel is a Unix socket in the user's own system folder (`_CS_DARWIN_USER_DIR`/`koonapin/capture.sock`, `0700` folder, `0600` socket, peer UID checked), as on Linux. A release start writes `app.koona.pin.json` for the host inside the bundle into `~/Library/Application Support/{Google/Chrome,Microsoft Edge,Chromium,Mozilla}/NativeMessagingHosts`, so a moved app repairs its path; the host starts a closed app through `open -g -j`. Remaining: real Chrome/Edge/Firefox smoke tests with the store extensions, and macOS wording for the missing-host message (it names `koonapin-host.exe`). |
| NP-051: signing and release | Developer ID, notarization, distribution package, in-app updater, install/update/removal and published-package acceptance remain. |

For future signing, `security find-identity -v -p codesigning` on the build Mac lists usable identities. Set the chosen **Developer ID Application** identity through `bundle.macOS.signingIdentity` or `APPLE_SIGNING_IDENTITY`; the certificate and its private key must exist in the runner's keychain. Notarization is separate authentication: Tauri needs either `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` or `APPLE_API_ISSUER`/`APPLE_API_KEY`/`APPLE_API_KEY_PATH`. Identity alone does not enable notarization. See [Tauri's macOS signing guide](https://v2.tauri.app/distribute/sign/macos/). This test PR supplies neither signing material nor notarization credentials.

These keys remain planned work under open [#56](https://github.com/andmetoo/koona-pin/issues/56); the old [platform probe #10](https://github.com/andmetoo/koona-pin/issues/10) is historical evidence, not acceptance of this commit. This PR must not close #56.

Other open implementation/acceptance issues found: real Linux desktop checks [#189](https://github.com/andmetoo/koona-pin/issues/189), Linux acceptance [#161](https://github.com/andmetoo/koona-pin/issues/161), Linux release verification and AUR publication [#162](https://github.com/andmetoo/koona-pin/issues/162), user documentation [#127](https://github.com/andmetoo/koona-pin/issues/127), and the local MCP server [#126](https://github.com/andmetoo/koona-pin/issues/126). The other open issues are their parent scenarios and future Windows/Linux 1.0, Android and iOS milestones. They are outside this macOS test PR.
