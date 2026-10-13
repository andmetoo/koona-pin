# Experimental macOS test builds

This is a test build for [#56](https://github.com/andmetoo/koona-pin/issues/56), not the macOS release. The workflow currently tests macOS 15 on Apple Silicon (`macos-15`) only; the Intel (`macos-15-intel`) matrix entry is temporarily disabled. macOS 15 is the floor of this experiment, not a declaration of the oldest supported macOS version. There is no Developer ID signing, notarization or updater manifest yet; a version tag uploads an ad hoc signed ZIP and DMG to the draft GitHub Release (release.yml, `bun run build:macos`), and the release offers the DMG on koona.app.

## Run and check

The `macos` job of `.github/workflows/ci.yml` runs on every pull request, every push to `main` and by hand (**Actions → CI → Run workflow**). It checks what only macOS compiles: the Rust tests (with the macOS capture socket and the browsers' manifests), then the app bundle with its TypeScript/Vite build, so a packaging problem shows, then the Safari extension target, signed to run locally and not embedded ([Safari](#safari)). IPC types and Vitest do not depend on the system and run in the Linux part of `ci.yml`. It uploads nothing. Nothing in CI runs the app or its interface in WKWebView: the UI suite runs in Chromium and the native tests in WebKitGTK, both on Linux, so a macOS-only interface problem shows only in a hand-built `.app`.

On a Mac with Xcode Command Line Tools, Rust and the pinned Bun:

```bash
bun install --frozen-lockfile
bun run build:macos:test
```

`bun run build:macos:test` runs `scripts/build-macos.mjs --test`. The output is `release/test/macos/<version>/<arch>/`: `Koona Pin.app`, the same in a ZIP made with `ditto` (preserves bundle metadata), `SHA256SUMS.txt`, `build.json` with the exact commit, and a README. The test bundle may need the Mac owner's Gatekeeper approval. A started copy uses the normal library; set `KOONAPIN_DATA_DIR` to try it on another. Such a copy does not register with the browsers, so browser capture needs `KOONAPIN_REGISTER_HOST=1` as well (it then takes over the browsers' manifests from any installed copy until that one starts again).

`tauri.macos.conf.json` enables the normal native macOS title bar (`decorations: true`, `titleBarStyle: Visible`), with real system traffic-light controls and rounded window corners. It repeats the main-window geometry because Tauri's config merge replaces the windows array. `get_desktop` reports the actual decorated-window state; the HTML window strip is absent when the system draws the frame. The title bar follows the application's light/dark theme through Tauri's window theme API. Windows and Linux keep their existing custom controls.

The Rust HTTP tests model different hosts with loopback addresses `127.0.0.2` through `127.0.0.11`. macOS requires them to be configured explicitly; the workflow adds aliases to `lo0` before the tests. The first ARM run exposed this prerequisite (`AddrNotAvailable`), rather than an application failure; no network tests are skipped.

### Release build

`bun run build:macos` (`scripts/build-macos.mjs` without `--test`) builds with `--features public-release` and `src-tauri/tauri.macos-release.conf.json` (app and DMG, `icon.icns`, macOS 15.0 minimum), so it needs `KOONAPIN_FEEDBACK_URL` in the environment or `.env`. The output is `release/publish/macos/<version>/<arch>/`: `koonapin-<version>-macos-<arch>.zip` (`Koona Pin.app` and `README.txt` at its top, made with `ditto`), `koonapin-<version>-macos-<arch>.dmg` and `SHA256SUMS.txt`, whose last line says whether the build is signed and notarized.

`README.txt` (`src-tauri/macos/README.txt`) is for the people who download it: what Koona Pin is, the requirements (Apple Silicon, macOS 15 or later), installing by dragging it to Applications, and how to open a build without a Developer ID, which macOS blocks at first. Either System Settings → Privacy & Security → «Open Anyway» after the first attempt, or `xattr -dr com.apple.quarantine "/Applications/Koona Pin.app"` in Terminal, which removes the download quarantine from this app only and leaves Gatekeeper on. It also says that macOS gets no automatic updates yet: the new version comes from koona.app/pin/downloads. The script adds it to Tauri's DMG (`hdiutil convert` to read-write, attach, copy, detach, `convert` back to UDZO): the window layout of Tauri's `.DS_Store` stays, and Finder places `README.txt` by itself, since it has no position of its own there. With `APPLE_SIGNING_IDENTITY` the changed DMG is signed again with `codesign`; notarizing the DMG itself is still to do.

A release publishes the DMG on koona.app as well: finalize signs it with the update key, `release.json` lists it as `files.macos`, and the site offers it at `/pin/downloads/<version>/koonapin-<version>-macos-arm64.dmg` ([building.md](building.md#releases)). There is no signing material yet, so the bundle is signed ad hoc and Gatekeeper needs the Mac owner's approval; the script uses `APPLE_SIGNING_IDENTITY` and the notarization variables below as soon as they are set. Bundle settings stay out of `tauri.macos.conf.json`, which Tauri merges into every macOS build, `cargo test` and dev included.

## Safari

The Safari extension ([NP-119](https://github.com/andmetoo/koona-pin/issues/274)) is a **local build only**: there is no Apple Developer account yet, so it is signed to run locally, loaded with "Allow unsigned extensions" and never published. Release builds (`bun run build:macos`) do not include it.

### Build and load

On a Mac with macOS 15 or later and Xcode (not only the Command Line Tools), no Apple Developer account needed:

```bash
bun run build:macos:safari
```

`scripts/build-macos.mjs --test --safari` runs `bun run extension:build` (its web part goes to `release/dev/safari`), the test build above, then:

1. `Tests/RelayCheck.swift`: the handler's envelope, the host's replies and one exchange over a real socket, without Safari.
2. `xcodebuild` of `src-tauri/macos/safari/KoonaPinSafari.xcodeproj` with `CODE_SIGN_IDENTITY=-` (Sign to Run Locally), no team, no provisioning profile; its builds go to `src-tauri/target/safari`. A build phase copies `release/dev/safari` into the `.appex`, so the web part is never in Git twice. The `.appex` carries the app's version (tauri.conf.json), as Apple requires of an app extension; Safari shows the extension's own `VERSION` from `manifest.json`.
3. `Koona Pin Safari.appex` into `Koona Pin.app/Contents/PlugIns/`, signed ad hoc with its own entitlements (`com.apple.security.app-sandbox` only) and the hardened runtime, then the app around it ad hoc, **without `--deep`** (that would sign the `.appex` again without its entitlements), keeping the app's own entitlements and flags (`--preserve-metadata`; the script stops if they change). `codesign --verify --strict --deep` checks the result.

All of that happens before the ZIP, `SHA256SUMS.txt` and `build.json` (`"safari": true`) are written, in `release/test/macos/<version>/<arch>/`. The README next to the build lists the steps:

1. Safari → Settings → Advanced → "Show features for web developers".
2. Develop → "Allow unsigned extensions".
3. Then start Koona Pin, or quit and start it again. Safari lists an ad hoc ("unsigned") extension only when macOS registers it while unsigned extensions are allowed; at its own start Safari logs "Computing the code signing dictionary failed … does not have a code signature" and skips it, and it turns the setting off on every start. Starting the app registers its extension again, so after every Safari start: step 2, then step 3.
4. Safari → Settings → Extensions: turn on Koona Pin and allow it on websites.

Use a test library, never the everyday one. A closed app started by the extension does not get the variables of a Terminal, so `launchctl setenv KOONAPIN_DATA_DIR ~/KoonaPinTest` sets it for every app started from the Dock, Finder or Safari (`launchctl unsetenv KOONAPIN_DATA_DIR` afterwards). While it is set, an installed Koona Pin opens that library too and, being older, refuses it once the test build has migrated it: that is the downgrade guard, not damage. Unused copies of `Koona Pin.app` that LaunchServices still knows (old test builds, `src-tauri/target/release/bundle`, unmounted disk images; `lsregister -dump | grep "Koona Pin.app"`) are worth removing with `lsregister -u`.

If Safari doesn't list it, `pluginkit -mAvvv -p com.apple.Safari.web-extension` shows what macOS registered (`app.koona.pin.safari` and its path). PlugInKit ignores an `.appex` whose containing app LaunchServices does not know yet (the log says "plug-ins outside containing apps must be protected by SIP"): starting the app registers it; without starting it, `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "Koona Pin.app"` and then `pluginkit -a "Koona Pin.app/Contents/PlugIns/Koona Pin Safari.appex"` do (`pluginkit -r` and `lsregister -u` undo it). This was checked with the build on macOS 27: registered that way, `pluginkit` lists `app.koona.pin.safari(<version>)` with the app as its parent bundle.

The project was generated once with `xcrun safari-web-extension-packager --macos-only --swift --no-open --app-name "Koona Pin" --bundle-identifier app.koona.pin release/dev/safari` (Xcode 27) and trimmed: the packager's containing app target (its storyboard, view controller, sample HTML, CSS, script and icons) is gone, since `Koona Pin.app` from Tauri is the containing app; the per-file references to the web part became one copy phase; the build settings are in `Safari.xcconfig`, with an explicit entitlements file instead of Xcode's sandbox and user-selected-files switches. To regenerate it, run the packager into a scratch folder and carry over only what changed.

### How the native path works

`runtime.sendNativeMessage` in Safari goes to `SafariWebExtensionHandler` (`src-tauri/macos/safari/Extension`), an `NSExtensionRequestHandling` class in the sandboxed `.appex`. On a background queue it writes `{"caller":"app.koona.pin.safari","message":<the message unchanged>}` as one line to `NSHomeDirectory()/capture.sock`, which inside the sandbox is `~/Library/Containers/app.koona.pin.safari/Data/capture.sock`, reads one line back (10 s, the app's `READ_TIMEOUT`) and returns it through `SFExtensionMessageKey`, completing the request exactly once. One message per connection; no fields of its own, no queue. When nobody listens and the message is `capture`, `search` or `show`, it opens the containing app (`Bundle.main.bundleURL` minus three components, only if that is an `.app` with the `.appex` in its `Contents/PlugIns`: the sandbox denies reading the app's `Info.plist` outside `/Applications`, so the id cannot be checked there) with `NSWorkspace.openApplication`, `activates = false`, `hides = true`, `addsToRecentItems = false`, the sandbox's equivalent of the host's `open -g -j`, and polls the socket until `START_WAIT` (10 s) runs out. `hello` never starts the app. Failures are the host's own: `app_unavailable` ("Koona Pin is not running or does not answer") and `invalid_request`.

The app binds that socket next to the one of `koonapin-host` (`_CS_DARWIN_USER_DIR`), and only when `Contents/PlugIns/Koona Pin Safari.appex` exists in its own bundle.

### The channel: options tried

A spike on macOS 27 with ad hoc signing tried each channel from a sandboxed probe to an unsandboxed listener (the probe was a sandboxed `.app`, not yet a Safari-hosted `.appex`):

| Option | Result |
| --- | --- |
| C1: the host's socket in `_CS_DARWIN_USER_DIR` | Refused. Inside the sandbox `_CS_DARWIN_USER_DIR` is a per-container folder; `connect` to the app's socket is `EPERM` (`deny(1) network-outbound`), with or without `network.client`. |
| C2: a home-relative file exception (`temporary-exception.files.home-relative-path.read-write`) | Refused. The folder can be listed, `connect` is still `EPERM`: file exceptions do not cover Unix sockets ([Apple forums 133543](https://developer.apple.com/forums/thread/133543)). An SBPL exception, `(allow network-outbound (literal …))`, works but is undocumented and bakes one user's path into the signature. |
| C3: an App Group container | Refused for now. Ad hoc, the group container is denied to both sides (`System Policy: deny(1) file-read-data`, no prompt). Under a Developer ID a `TEAMID.`-prefixed group needs no profile and the unsandboxed app must claim it too ([Accessing app group containers](https://developer.apple.com/documentation/xcode/accessing-app-group-containers), [forums 721701](https://developer.apple.com/forums/thread/721701)); Apple suggests an app-group socket for Safari extensions ([forums 778297](https://developer.apple.com/forums/thread/778297)). An option once there is a Team ID. |
| C4: the `.appex`'s own data container | **Works, chosen.** `~/Library/Containers/<appex id>/Data/…/capture.sock`; the extension needs `app-sandbox` only. It worked with a sandboxed listener in the same container, an unsandboxed binary, an unsandboxed ad hoc `.app`, and with the app creating the folder before the container existed (containermanagerd adopted it). |
| C5: XPC or a Mach service | Rejected after research. It needs a LaunchAgent registered with `SMAppService.agent` (approval in Login Items); an app cannot check in a Mach service itself ([forums 775267](https://developer.apple.com/forums/thread/775267)), and the extension would need a group-prefixed name or a `mach-lookup` exception ([forums 742759](https://developer.apple.com/forums/thread/742759)). Too heavy for one line each way. |

**Why it does not depend on ad hoc signing.** C4 uses no App Group, no temporary exception and no provisioning profile: a sandboxed process may always use its own container, and an unsandboxed app of the same user may reach it; under a Developer ID, access to a container of the same team needs no prompt ([WWDC23 10053](https://developer.apple.com/videos/play/wwdc2023/10053/)). Temporary exceptions are allowed outside the App Store anyway ([forums 776609](https://developer.apple.com/forums/thread/776609)), notarization requires only the hardened runtime ([forums 116468](https://developer.apple.com/forums/thread/116468)), and Safari accepts Developer ID-signed, notarized extensions from 18.4 ([forums 782005](https://developer.apple.com/forums/thread/782005)). The app must not set `NSDataAccessSecurityPolicy`.

**Admission.** The app checks the peer as on the other socket (same user), then its code: the spike took the peer's audit token (`LOCAL_PEERTOKEN`), `SecCodeCopyGuestWithAttributes` and `SecCodeCheckValidity` against the designated requirement of the `.appex` inside the app's own bundle. Ad hoc that requirement is the `.appex`'s `cdhash`: the right one is admitted, another is refused (`-67050`). After Developer ID signing the same code gets Apple's team requirement with no change, and the app can also pin `certificate leaf[subject.OU]` to our Team ID, so only an extension signed by us is admitted. The audit token is that of the process that connected ([forums 760972](https://developer.apple.com/forums/thread/760972)).

### Manual acceptance

Checked on 13 October 2026 on macOS 27.0.1 (Apple Silicon), Xcode 27.0, Safari 27, with `bun run build:macos:safari` from this branch and a scratch library through `launchctl setenv KOONAPIN_DATA_DIR`:

| Criterion | Result |
| --- | --- |
| 2. Safari lists Koona Pin and it can be turned on | Yes, in the order above (allow unsigned extensions, then start the app). |
| 3. A click saves the link with its title; a second click answers `existing`; the page message both times; nothing else sent | Yes: `example.com` saved once with source `safari` and its title. |
| 4. With the app closed, a click starts it hidden and the link is saved | Yes, after a fix: the handler first checked the app's id by reading its `Info.plist`, which the sandbox denies outside `/Applications` (`deny(1) file-read-data`); it now checks the bundle layout. The app starts in the menu bar without a window. |
| 5. With the app unreachable (process stopped), the link waits, survives a Safari restart, and a retry saves it once | Yes: `apple.com` waited across a Safari restart and was saved once after the app answered again. |
| 6. Safari as connected after `hello`, the last save «from Safari» | Yes (`capture_connections` lists `safari`, extension 0.10.0, protocol 2). |
| 7. Quick search, the button's menu, «Show that a page is already saved» | The menu's «Settings» works. Quick search works in a window: Safari's `action.openPopup` answers «Another popup is already open» with none open, so the shortcut and «Find a link» open `search.html` in a small window centred over the page's window; Enter opens a result in a new tab of the page's window, Shift Enter in the page's tab. «Show that a page is already saved» is hidden in Safari (docs/extension.md). |

Also seen: after the unsigned extension was reinstalled under a running Safari, `storage.local.set` rejected small writes with «Exceeded storage quota» for a few minutes (about 400 bytes stored); the queue kept the link and a later retry delivered it once. The `lastSaved` note no longer fails a delivered link.

### Open points

- Whether macOS asks the ad hoc app in `/Applications` for access to the extension's container (tested only from the repository folder, where nothing asked). A Developer ID app of the same team should not be asked.

## Remaining work from the documents and GitHub

Reviewed `doc/decisions.md` (Р-26 and Р-44), `doc/roadmap.md`, `doc/release-checklist.md`, the public `docs/building.md` and `docs/testing.md`, and GitHub Issues on 10 October 2026. `doc/` is a separate private notes repository, ignored by this repository; this PR keeps the review result in `docs/`.

| Work | Current evidence / next step |
| --- | --- |
| NP-048: supported macOS versions and architectures | This experiment currently tests macOS 15 on arm64 only; Intel is temporarily disabled. Choose the public matrix and check the oldest WKWebView on a real Mac; the documents require Safari 16.4-level WebKit for Tailwind 4. |
| NP-049: window, menu, Cmd shortcuts, paths, lifecycle | A native decorated title bar with real traffic lights and theme matching is in place. Manual acceptance of traffic-light actions/fullscreen, a second launch, replacing the standard menu, Cmd shortcuts, Dock reopening, autostart and tray behavior still remain. |
| NP-050: browser capture | The channel is a Unix socket in the user's own system folder (`_CS_DARWIN_USER_DIR`/`koonapin/capture.sock`, `0700` folder, `0600` socket, peer UID checked), as on Linux. A release start writes `app.koona.pin.json` for the host inside the bundle into `~/Library/Application Support/{Google/Chrome,Microsoft Edge,Chromium,Mozilla}/NativeMessagingHosts`, so a moved app repairs its path; the host starts a closed app through `open -g -j`. Safari (NP-119, local build only): the `.appex` in `Contents/PlugIns` relays over a second socket in its own sandbox container and starts the app through `NSWorkspace` ([Safari](#safari)). Remaining: real Chrome/Edge/Firefox smoke tests with the store extensions, and macOS wording for the missing-host message (it names `koonapin-host.exe`). |
| NP-051: signing and release | Developer ID, notarization, distribution package, in-app updater, install/update/removal and published-package acceptance remain. |

For future signing, `security find-identity -v -p codesigning` on the build Mac lists usable identities. Set the chosen **Developer ID Application** identity through `bundle.macOS.signingIdentity` or `APPLE_SIGNING_IDENTITY`; the certificate and its private key must exist in the runner's keychain. Notarization is separate authentication: Tauri needs either `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` or `APPLE_API_ISSUER`/`APPLE_API_KEY`/`APPLE_API_KEY_PATH`. Identity alone does not enable notarization. See [Tauri's macOS signing guide](https://v2.tauri.app/distribute/sign/macos/). This test PR supplies neither signing material nor notarization credentials.

These keys remain planned work under open [#56](https://github.com/andmetoo/koona-pin/issues/56); the old [platform probe #10](https://github.com/andmetoo/koona-pin/issues/10) is historical evidence, not acceptance of this commit. This PR must not close #56.

Other open implementation/acceptance issues found: real Linux desktop checks [#189](https://github.com/andmetoo/koona-pin/issues/189), Linux acceptance [#161](https://github.com/andmetoo/koona-pin/issues/161), Linux release verification and AUR publication [#162](https://github.com/andmetoo/koona-pin/issues/162), user documentation [#127](https://github.com/andmetoo/koona-pin/issues/127), and the local MCP server [#126](https://github.com/andmetoo/koona-pin/issues/126). The other open issues are their parent scenarios and future Windows/Linux 1.0, Android and iOS milestones. They are outside this macOS test PR.
