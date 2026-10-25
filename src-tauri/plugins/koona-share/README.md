# koona-share

"Share → Koona Pin" on the phones: a link shared from another app lands in the Inbox. The share sheet
runs without the app (no WebView, no Rust, no network), writes the link to a queue folder and closes;
the app takes the queue in through `src-tauri/src/share_queue.rs` when its library opens, on every
resume, and at once while it runs.

| | Android | iOS |
| --- | --- | --- |
| Sheet | `ShareActivity` (`android/`), process `:share` | Share extension `app.koona.pin.share` (`ios-extension/`), the Xcode target `koonapin_Share` of `src-tauri/gen/apple/project.yml` |
| Accepts | `ACTION_SEND` `text/plain` | A web page or URL, or text (Safari's page title through `Sheet/Preprocess.js`) |
| Queue | `filesDir/share-queue/` | `share-queue/` in the App Group container `group.app.koona.pin` |
| "A share landed" | `FileObserver` on the folder | Darwin notification `app.koona.pin.share.queued` |
| App side | `KoonaSharePlugin.kt` | `ios/Sources/KoonaSharePlugin.swift` |
| Words | `bun run locales:android` → `android/src/main/res` | `bun run locales:ios` → `ios-extension/Strings` |

Both are made from `phone.share` of `src/locales`.

## The queue

One JSON file per share, `<request_id>.json`, written as `<request_id>.json.tmp`, synced and renamed:

```json
{ "request_id": "<UUID v4>", "url": "https://…", "title": "…", "created_at": "<RFC 3339, UTC>" }
```

`queue-fixtures/` holds the format's examples and the links the sheet must take and refuse; the Rust
tests (`share_queue.rs`), the Kotlin tests (`android/src/test`) and the Swift tests
(`ios-extension/Tests`) read them. The sheets refuse what the app's capture would refuse, so they
never say "Saved" for a link the app puts aside.

## iOS

- `ios/` is the Tauri plugin's Swift package (the app's process): the queue folder for Rust and the
  `queued` event. `ios-extension/` is the extension's code, compiled by the Xcode target, with a
  package of its own for the tests: `cd ios-extension && swift test`.
- The App Group is in both targets' entitlements. The library stays in the app's own container: a
  locked SQLite file in a shared container gets a suspended app killed (`0xdead10cc`).
- The extension's versions are the app's, copied in at build time. `bun run build:ios` signs the
  extension ad hoc with its entitlements before the export (tauri-apps/tauri#15663) and checks the
  App Group in the signed IPA. The App Group `group.app.koona.pin`, the extension's id
  `app.koona.pin.share` and the App Groups capability on both ids are made once in the developer
  portal: the App Store Connect API key cannot reach App Groups.
- After editing `project.yml`, regenerate the project: `cd src-tauri/gen/apple && xcodegen generate`.
