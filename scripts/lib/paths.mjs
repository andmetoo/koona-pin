// Where builds put what leaves the repository: one place, so no script guesses another's folder
// (docs/building.md). Everything here is under release/, which Git ignores:
//
//   release/publish/   to people and stores
//     windows/<version>/   installer, signed, and SHA256SUMS.txt     bun run build:installer -- --sign
//     linux/<version>/     .deb, .rpm and SHA256SUMS.txt             bun run build:linux (on Debian 13)
//     macos/<version>/<arch>/  Koona Pin.app in a ZIP, .dmg and SHA256SUMS.txt   bun run build:macos
//     aur/<version>/       PKGBUILD and .SRCINFO of koonapin-bin     bun run build:aur
//     updates/<version>/   packages with .sig, SHA256SUMS.txt and latest.json; the site serves the newest   bun run build:latest
//     chrome/<version>/    koonapin-chrome.zip, Chrome Web Store    bun run extension:build
//     edge/<version>/      koonapin-edge.zip, Edge Add-ons          bun run extension:build
//     firefox/             signed XPIs and updates.json; the site serves them   bun run extension:sign:firefox
//     site/                koona.app/pin as deployed                bun run site:build
//   release/test/      a test machine; never published
//     macos/<version>/<arch>/  test .app, its ZIP, SHA256SUMS.txt, build.json   bun run build:macos:test
//     windows/<version>/   installer, unsigned                       bun run build:installer
//     chrome-edge/<version>/  extension with the store id            bun run extension:build (CHROME_STORE_PUBLIC_KEY)
//   release/dev/       this machine
//     chrome/, edge/, firefox/  unpacked, development id («Load unpacked», tests)   bun run extension:build
//
// Tools keep their own working folders and nothing is taken from them by hand: src-tauri/target
// (Cargo and Tauri: debug and release EXEs, NSIS intermediates) and dist/ (Vite, the app's interface).
import path from "node:path";

// Inside the site's Astro build this file is bundled elsewhere: site/astro.config.mjs puts the
// repository's root in import.meta.env.KOONAPIN_ROOT (NP-115). Bun's import.meta.env is the
// environment, where it is not set.
export const root = (import.meta.env && import.meta.env.KOONAPIN_ROOT) || path.resolve(import.meta.dirname, "..", "..");
export const release = path.join(root, "release");

export const publish = {
  windows: (version) => path.join(release, "publish", "windows", version),
  linux: (version) => path.join(release, "publish", "linux", version),
  /** arch is process.arch of the building Mac: arm64 or x64. */
  macos: (version, arch) => path.join(release, "publish", "macos", version, arch),
  aur: (version) => path.join(release, "publish", "aur", version),
  /** One folder per version (build-latest.mjs); build-site.mjs takes the newest. */
  updates: path.join(release, "publish", "updates"),
  chrome: (version) => path.join(release, "publish", "chrome", version),
  edge: (version) => path.join(release, "publish", "edge", version),
  /** The address of these files is inside every signed XPI (gecko.update_url): only the local folder moves. */
  firefox: path.join(release, "publish", "firefox"),
  site: path.join(release, "publish", "site"),
};

export const test = {
  macos: (version, arch) => path.join(release, "test", "macos", version, arch),
  windows: (version) => path.join(release, "test", "windows", version),
  chromeEdge: (version) => path.join(release, "test", "chrome-edge", version),
};

export const dev = {
  extension: (browser) => path.join(release, "dev", browser),
};

/** Tauri's NSIS output, copied from here into publish/ or test/ by build-installer.mjs. */
export const nsisBundle = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
