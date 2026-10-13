# Browser extension

The extension saves the current tab to Koona Pin with one click and offers a quick search of the library. One source, `extension/src`, builds for all supported browsers.

## Supported browsers

| Browser | Minimum | Background |
| --- | --- | --- |
| Chrome | 120 | service worker |
| Edge | 120 | service worker (same package as Chrome) |
| Firefox | 140 (release and ESR 140) | event page (`background.scripts`, ES module) |
| Safari (macOS) | 18 (macOS 15); **local build only** | non-persistent background page (`background.scripts`, ES module) |

Safari has no store listing yet: the extension is built with Xcode into the test `Koona Pin.app` and loaded with "Allow unsigned extensions" ([Safari](#safari)). Chromium on Linux works like Chrome. Browsers in a sandbox that blocks native messaging (Flatpak browsers, Chromium from Snap) cannot reach the app; Firefox from Snap can, through the WebExtensions portal.

## Where people install it

- **Chrome** (and Chromium): [Chrome Web Store](https://chromewebstore.google.com/detail/dedcgklilbgbieabgpklellnaccpjhpc).
- **Edge:** [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/ocdkndgdeagephdnlmofffbapdifhkho).
- **Firefox:** the signed add-on on the [downloads page](https://koona.app/pin/downloads/#extension), outside the public add-on listing.

The stores update their copies themselves; Firefox checks `https://koona.app/pin/firefox/updates.json` about once a day (see [Releasing](#releasing)).

The app's "Connect a browser" dialog opens these pages: `installSources` in `src/services/capture.ts` gives each browser its page, the button's name, the install step and the update hint. A browser without an entry falls back to the developer-mode steps. The site builds its links from `chromeStoreId` and `edgeStoreId` in `scripts/build-extension.mjs`, and a test in `src-tauri/src/native_host.rs` checks those ids and the app's URLs against `STORE_EXTENSION_IDS`.

## How capture works

1. A click on the toolbar button (`worker.js`) takes the tab's URL and title. Nothing else is sent: no tags, collection or page content. The app accepts only HTTP and HTTPS URLs.
2. The link goes into the extension's queue in `storage.local` first, with a `request_id` (`queue.js`). The queue survives browser restarts and the service worker being stopped.
3. `native.js` sends `{ type: "capture", protocol, version, browser, request_id, url, title }` with `runtime.sendNativeMessage("app.koona.pin", …)`. The browser starts the native host `koonapin-host`, which forwards the message to the app and starts the app in the tray if it is closed.
4. The app saves the link in one transaction and answers `created` or `existing` with the bookmark ID. Only a well-formed confirmation removes the item from the queue.
5. On failure the item stays queued and is retried about once a minute (`alarms`), at browser start and on the next capture. Only `invalid_request` and `request_id_conflict` stop retries for an item. If the host is missing or the app does not accept this extension, the extension opens its options page, which explains the state.

The button animates and shows a small status mark; a short message appears on the page through `scripting` on the active tab only (`feedback.js`, in a closed shadow root). The extension also says `hello` every 30 minutes and at browser start, so the app can show the browser as connected.

The end-to-end architecture, the protocol messages and the local channel are in [architecture.md](architecture.md#capture).

### Permissions

`activeTab`, `scripting`, `storage`, `alarms`, `nativeMessaging`, plus `contextMenus` (Chrome, Edge) or `menus` (Firefox, Safari) for the button's menu. `tabs` is optional and requested only when the person turns on "Show that a page is already saved". There are no host permissions, no persistent content scripts and no remote code; the extension pages' CSP is `script-src 'self'; object-src 'none'`.

### Quick search

`Alt+Shift+D` (the `quick-search` command) or the button's menu opens `search.html` as a one-time popup. It sends `search` messages to the app and opens results with `tabs.create` or `tabs.update`. Site icons are letters on coloured squares, so the popup makes no network requests.

### Strings

`extension/src/_locales/<code>/messages.json`, with Chrome's locale codes (`pt_BR`, `zh_CN`), default `en`. The extension follows the browser's language, not the app's. See [translating.md](translating.md).

## Building and loading unpacked

```powershell
bun run extension:build
```

Results (folders defined in [`scripts/lib/paths.mjs`](../scripts/lib/paths.mjs)):

- `release/dev/chrome`, `release/dev/edge`, `release/dev/firefox`, `release/dev/safari` — unpacked builds. The Safari folder is the web part of the Safari app extension, which the Xcode build copies in; Safari has no store package. Rebuilding empties and refills the same folders, so a loaded extension keeps its path; press Reload on the extensions page afterwards.
- `release/publish/chrome/<version>/koonapin-chrome.zip` and `release/publish/edge/<version>/koonapin-edge.zip` — store packages. ZIPs have sorted names and fixed timestamps, so the same source gives the same bytes.

The extension version lives only in `extension/src/version.js` (with the protocol number and host name); the build writes it into every manifest. Tests (`*.test.js`) are not packed.

Loading:

- **Chrome:** `chrome://extensions` → Developer mode → Load unpacked → `release/dev/chrome`.
- **Edge:** `edge://extensions` → Developer mode → Load unpacked → `release/dev/edge`.
- **Firefox:** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `release/dev/firefox/manifest.json`. Firefox removes it when it closes.
- **Safari:** not loaded from the folder; `bun run build:macos:safari` builds it into the test `Koona Pin.app` ([macos-test.md](macos-test.md#safari)).

The unpacked Chrome and Edge builds carry the public key in `extension/dev-key.txt` as the manifest `key`, so their ID is the same on every machine: `iibgiagcbediajombmkohanobgicbepn`. There is no private key. Store packages are built without `key`; the stores assign their own IDs. The Firefox ID is always `pin@koona.app`.

## Safari

Safari builds from the same `extension/src` with its own manifest (`manifest("safari")` in `scripts/build-extension.mjs`): no development `key`, no `minimum_chrome_version`, no `gecko` block; `browser_specific_settings.safari.strict_min_version` is 18.0, the Safari of macOS 15. It is a local build only (NP-119): there is no Apple Developer account yet, so nothing is signed, notarized or published. `browserName()` reports `safari` from the extension's own scheme, `safari-web-extension:`, since Safari has neither `runtime.getBrowserInfo` nor `navigator.userAgentData`.

What each API does in Safari, from MDN's browser-compat-data, Apple's documentation and WebKit's source; still to be confirmed on a real Mac (docs/macos-test.md):

| API | In Safari |
| --- | --- |
| Background | `background.scripts` with `type: module` and `persistent: false`. Manifest V3 background pages are non-persistent in Safari, which has run `scripts` since Safari 14; its service workers were reported killed for good on iOS 17. `worker.js` already runs as Firefox's event page, so Safari takes the same path. |
| `alarms`, `storage.local`, `storage.session` | Supported (session storage since Safari 16.4). |
| `scripting` with `activeTab` | `executeScript` with `func` and `args` since Safari 15.4, injection results since 17. A click on the button grants the tab, as in Chrome. |
| `menus` on the button (context `action`) | Supported since Safari 15.4 in Manifest V3; `contextMenus` is an alias. Safari's button has no "Options" item, so the menu adds "Settings", as in Firefox. |
| `quick-search` command | `Alt+Shift+D` is Option+Shift+D. Safari has no `commands.update`, `commands.onChanged` or shortcuts page, so the options page shows the shortcut without "Change". |
| One-time search popup | Not used in Safari: `action.openPopup` exists but answers «Another popup is already open» with none open (checked in Safari on macOS 27). `search.html` opens in a 420-pixel `windows.create({ type: "popup" })` window centred over the page's window instead, with `?tab=&window=` so its links go to the page's tab and window. |
| Optional `tabs`, `permissions.request` | Supported, granted without a prompt. |
| `options_ui` | Always opens in a tab; Safari → Settings → Extensions → Koona Pin → Settings. |
| `_locales`, `i18n` | Supported, the same catalogs. |
| `action.setIcon` with drawn frames | `imageData` since Safari 15.4; the frames are drawn on `OffscreenCanvas` (Safari 16.4) and passed as `ImageData`. |
| `nativeMessaging` | `runtime.sendNativeMessage` goes to the containing app (below). |

Known limitations:

- **"Show that a page is already saved"** is not offered: Safari gives a tab's URL and title only on websites the person has allowed the extension, whatever the `tabs` permission says (`WebExtensionTab::extensionHasPermission` in WebKit). With `activeTab` alone the extension never learns which page a tab shows, so the options page hides the switch.
- **Quick search shortcut** cannot be changed: Safari has no API or page for extension shortcuts.
- **Quick search** opens in a small window with Safari's title bar, not in a popover under the button: Safari's `action.openPopup` refuses with «Another popup is already open» even when none is. The shortcut is shown as `⌥⇧D`; Safari reports it as `Alt+Shift+D`.

**The native path.** Safari has no `app.koona.pin.json` and no `koonapin-host`. `runtime.sendNativeMessage` ignores the host name and goes to `SafariWebExtensionHandler` (`src-tauri/macos/safari`) in the app extension `Koona Pin.app/Contents/PlugIns/Koona Pin Safari.appex` (`app.koona.pin.safari`). The handler does what the host does: it writes the message unchanged in the host's envelope, `{"caller":"app.koona.pin.safari","message":…}`, as one line to a Unix socket the app binds in the app extension's own sandbox container (`~/Library/Containers/app.koona.pin.safari/Data/capture.sock`), and returns the app's line. For `capture`, `search` and `show` it starts a closed app hidden through `NSWorkspace` and waits up to the host's `START_WAIT`; it answers `app_unavailable` and `invalid_request` with the host's words. It adds no fields and keeps no queue: the extension's queue stays the only one. Why this channel and not an App Group, XPC or a sandbox exception: [macos-test.md](macos-test.md#safari). WebKit's own errors are mapped in `native.js`: "Native messaging is not supported" (no app extension to load) is `host_missing`; a canceled, crashed or failing handler and "Couldn't communicate with a helper application" are `host_failed`. A Safari user never reads about a host: a missing app extension says that Koona Pin isn't installed or is damaged, a failing one that Koona Pin didn't answer.

## Native host registration

The browser starts the host only if a manifest named `app.koona.pin` is registered and lists the extension's ID.

- **Windows.** Manifests `app.koona.pin.chromium.json` and `app.koona.pin.firefox.json` are written next to the app; keys under `HKCU\Software\Google\Chrome`, `…\Microsoft\Edge` and `…\Mozilla` (`\NativeMessagingHosts\app.koona.pin`) point to them. No administrator rights are needed. The installer runs `koonapin --register-host`; a release build checks and repairs the registration at every start.
- **Linux packages.** The `.deb`, `.rpm` and AUR package install system manifests (Chromium family under `/etc/opt/chrome`, `/etc/opt/edge`, `/etc/chromium`; Firefox under `/usr/lib/mozilla`, and `/usr/lib64/mozilla` in the `.rpm`) pointing to `/usr/bin/koonapin-host`. The app only checks them and asks to reinstall the package if one is missing.
- **AppImage.** At each start the app copies the host into `~/.local/share/Koona/Pin/host/` and writes per-user manifests pointing to it.

**Development builds.** A debug build of the app does not touch the registration by default, so it cannot take over an installed Koona Pin's. To register a development build, set `KOONAPIN_REGISTER_HOST=1` before `bun run tauri dev`, or run the built binary with `--register-host`; `--unregister-host` removes only manifests that point to this host. On Linux this writes per-user manifests (`~/.config/google-chrome/NativeMessagingHosts`, `~/.mozilla/native-messaging-hosts` and so on).

Which extension IDs are accepted:

- Release builds (installer and packages, `--features public-release`) accept only the store IDs (`STORE_EXTENSION_IDS` in `src-tauri/src/native_host.rs`) and the Firefox ID.
- Development builds also accept the development ID.

So the unpacked development extension talks to a development build of the app, not to an installed release. Chrome and Edge report that mismatch as "forbidden", and the extension shows "Koona Pin doesn't accept this extension". Firefox does not distinguish it from a missing host.

## Store builds

- **Chrome Web Store and Edge Add-ons:** upload the ZIPs from `release/publish/chrome/<version>/` and `release/publish/edge/<version>/`. Listing texts, permission justifications, images and the privacy text are in `extension/store`. With `CHROME_STORE_PUBLIC_KEY` set, `extension:build` also writes `release/test/chrome-edge/<version>/koonapin-chrome-store-id.zip`, the same extension with the store's ID, for testing against a release build before the store publishes it. It cannot be uploaded (stores refuse a manifest with `key`).
- **Firefox:** distributed as a signed XPI outside the public add-on listing, with `update_url` pointing to `https://koona.app/pin/firefox/updates.json`. AMO signs it, from CI (below).

Any change under `extension/src` must raise `VERSION` in `extension/src/version.js`: a store or signing service accepts each version number once.

## Releasing

A release is the tag `ext-v<version>`; `.github/workflows/extension.yml` does the rest. Nothing is signed or deployed from a working copy.

1. Raise `VERSION` in `extension/src/version.js` in a pull request, merge it.
2. On an up-to-date `main`: `bun run extension:tag` (`-- --dry-run` checks only). It checks that the branch is `main` and equal to `origin/main`, nothing is uncommitted, the tag is new and above every `ext-v*` tag, then pushes `ext-v<version>`.
3. The workflow, in the environment «release»:
   - checks that the tag names `VERSION` and its commit is on `main` (`scripts/extension-tag.mjs --verify`);
   - downloads `updates.json` and every XPI it lists from the highest published `ext-v*` release. With no such release it stops: old versions are never dropped silently (a Firefox on a version missing from `updates.json` never hears of an update). `workflow_dispatch` with `first: true` from the tag starts empty;
   - signs on AMO (`bun run extension:sign:firefox -- --dir firefox`, unlisted, with `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`); the script refuses a folder whose XPIs do not match `updates.json`, a version signed already and a version below the newest, before AMO is asked;
   - writes `extension.json` (`scripts/build-extension-data.mjs`: the newest XPI's name, size and SHA-256; the site's pages read it) after the same checks the server makes;
   - signs `updates.json` and `extension.json` with the app's update key (`tauri signer sign`); the XPIs are Mozilla's signed packages, tied to `updates.json` by their hashes;
   - builds the Chrome and Edge ZIPs;
   - creates the GitHub Release `ext-v<version>`, not marked latest (the app's `v*` releases keep that), with every XPI, `updates.json(.sig)`, `extension.json(.sig)` and the two ZIPs;
   - streams the Firefox files over SSH to `koona-deploy firefox ext-v<version>` on the server (koona-site `server/`), which checks the signatures against the update key pinned there and serves them at `https://koona.app/pin/firefox/`. Without `DEPLOY_HOST` the step warns and skips.
4. Upload the two ZIPs from the release to the Chrome Web Store and Edge Add-ons by hand.

A rerun of a tag whose release exists signs nothing: it deploys that release's files again. If AMO signed the version but the run failed before the release, AMO will not sign that number again: download the signed XPI from the AMO Developer Hub, or raise `VERSION` and tag again.

**Secrets** (environment «release», which must open to tags `v*` and `ext-v*`): `WEB_EXT_API_KEY`, `WEB_EXT_API_SECRET` (AMO → Developer Hub → Manage API Keys), `TAURI_SIGNING_PRIVATE_KEY` and its password (there already), `DEPLOY_HOST`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`.

**Once:** the versions signed before this workflow (0.8.0 to 0.9.2, in `release/publish/firefox/` on the maintainer's computer) go into the release `ext-v0.9.2` once, with `bun run extension:seed` (`scripts/seed-firefox-release.mjs`; `-- --dry-run` shows what it would do). It checks the hashes, signs with the local update key from `.env`, creates the release as a draft with its files and then publishes it; publishing creates the tag, whose run of the workflow only deploys it.

`bun run extension:sign:firefox` still runs locally into `release/publish/firefox/` (or `-- --dir <folder>`), but what it signs reaches no one and uses up that version number on AMO: release through the tag.

## Checks

`bun run test` covers the queue, messages, menu and locales; the smoke tests in [testing.md](testing.md#extension-smoke-tests) run the built extension against the real host in Chrome for Testing, Chrome, Edge and Firefox; `bun run extension:lint` runs `web-ext lint`.
