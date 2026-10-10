# Experimental macOS test builds

This is a test build for [#56](https://github.com/andmetoo/koona-pin/issues/56), not the macOS release. The workflow tests macOS 15 on Apple Silicon (`macos-15`) and Intel (`macos-15-intel`). macOS 15 is the floor of this experiment, not a declaration of the oldest supported macOS version. There is no Developer ID signing, notarization, release upload or updater manifest.

## Run and download

`.github/workflows/macos.yml` starts on relevant pull requests, or through **Actions → macOS test build → Run workflow** on a chosen branch once the workflow exists on the default branch. A pull request runs the merge candidate of its branch and current `main`; `build.json` records the exact commit.

Each architecture produces two artifacts, retained for 14 days:

- `macos-test-arm64` / `macos-test-x64`: `.app` inside a ZIP made with `ditto` (preserves bundle metadata), `SHA256SUMS.txt`, `build.json` and a README. Download and extract the artifact, then the inner ZIP. The test bundle may need the Mac owner's Gatekeeper approval.
- `macos-evidence-arm64` / `macos-evidence-x64`: nine PNGs of the actual native window (eight combinations of English/Russian, light/dark, grid/list, plus a persistence relaunch), JSON assertion results and app logs. Failures retain whatever evidence was produced.

On a Mac with Xcode Command Line Tools, Rust and the pinned Bun:

```bash
bun install --frozen-lockfile
bun run build:macos:test
bun run test:macos
```

Outputs are `release/test/macos/<version>/<arch>/` and `test-results/macos/`. The runner launches the executable inside that very packaged `.app`, not another Cargo binary. Native tests create a new `.test-data/macos-smoke-<time>` folder and never use the normal library. Quit any already-running Koona Pin before a local native run. Screen capture requires a graphical login and screen recording permission; missing permission or a blank capture fails the job instead of substituting a browser screenshot.

## What is checked

1. Rust unit/integration tests, generated IPC types, TypeScript/Vite build and Vitest on both architectures.
2. Functional Playwright UI tests against the demo browser preview in WebKit and Chromium; visual baseline comparisons remain excluded because font rendering differs. Four IME tests are tagged `@chromium` because they use Chromium-only CDP. They run in the Chromium suite, while the other functional scenarios also run in WebKit. Tests use `ControlOrMeta` for the platform's modifier; WebKit keyboard navigation uses Option-Tab on macOS. Focus-restoration checks activate focused controls with Enter rather than assuming that a Safari mouse click focuses buttons. Drag tests wait for the animation-frame selection update before releasing the pointer. The 10 000-row demo fixture keeps only the fields needed for selection to fit WebKit's localStorage quota; the native app uses SQLite.
3. The packaged app's WKWebView and actual production IPC/SQLite: add, recognize duplicates, search Cyrillic, trash, restore, undo, restore a deterministic JSON library, persist it over a restart, hand over a second launch to the running instance.
4. The real rendered window in English/Russian, both themes and grid/list. Capture locates the app's window by PID and checks its size and sampled color diversity. It does not compare Windows baselines.

Native automation is behind the `macos-smoke` Cargo feature and explicit config/report environment variables. The feature is compiled out of ordinary builds. Even a test bundle does not activate automation unless `KOONAPIN_MACOS_SMOKE_CONFIG` is set, and requires `KOONAPIN_DATA_DIR`. The packaged ZIP contains this test feature and must stay under `release/test`, not `release/publish`. The fixture uses the site's sample titles without photos; screenshots show the app's generated covers without remote photo dependencies.

The Rust HTTP tests model different hosts with loopback addresses `127.0.0.2` through `127.0.0.11`. macOS requires them to be configured explicitly; the workflow adds aliases to `lo0` before the tests. The first ARM run exposed this prerequisite (`AddrNotAvailable`), rather than an application failure; no network tests are skipped.

## Remaining work from the documents and GitHub

Reviewed `doc/decisions.md` (Р-26 and Р-44), `doc/roadmap.md`, `doc/release-checklist.md`, the public `docs/building.md` and `docs/testing.md`, and GitHub Issues on 10 October 2026. `doc/` is a separate private notes repository, ignored by this repository; this PR keeps the review result in `docs/`.

| Work | Current evidence / next step |
| --- | --- |
| NP-048: supported macOS versions and architectures | This experiment tests macOS 15 on arm64 and x64 only. Choose the public matrix and check the oldest WKWebView on a real Mac; the documents require Safari 16.4-level WebKit for Tailwind 4. |
| NP-049: window, menu, Cmd shortcuts, paths, lifecycle | Window rendering, isolated library persistence and second launch are exercised here. Native traffic-light placement, replacing the standard menu, Cmd shortcuts, Dock reopening, autostart and tray behavior still need implementation/acceptance. |
| NP-050: browser capture | The current macOS capture channel reports that native messaging is unavailable. Implement its per-user transport, native host registration/path repair and actual Chrome/Edge/Firefox smoke tests; then replace the current failing-status presentation with calm unavailable messaging where applicable. The test does not claim extension capture works. |
| NP-051: signing and release | Developer ID, notarization, distribution package, in-app updater, install/update/removal and published-package acceptance remain. |

These keys remain planned work under open [#56](https://github.com/andmetoo/koona-pin/issues/56); the old [platform probe #10](https://github.com/andmetoo/koona-pin/issues/10) is historical evidence, not acceptance of this commit. This PR must not close #56.

Other open implementation/acceptance issues found: real Linux desktop checks [#189](https://github.com/andmetoo/koona-pin/issues/189), Linux acceptance [#161](https://github.com/andmetoo/koona-pin/issues/161), Linux release verification and AUR publication [#162](https://github.com/andmetoo/koona-pin/issues/162), user documentation [#127](https://github.com/andmetoo/koona-pin/issues/127), and the local MCP server [#126](https://github.com/andmetoo/koona-pin/issues/126). The other open issues are their parent scenarios and future Windows/Linux 1.0, Android and iOS milestones. They are outside this macOS test PR.
