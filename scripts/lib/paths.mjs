// Where builds put what leaves the repository: one place, so no script guesses another's folder
// (README, «Сборки»). Everything here is under release/, which Git ignores:
//
//   release/publish/   to people and stores
//     windows/<version>/   installer, signed, and SHA256SUMS.txt     bun run build:installer -- --sign
//     linux/<version>/     .deb, .rpm and SHA256SUMS.txt             bun run build:linux (on Debian 13)
//     aur/<version>/       PKGBUILD and .SRCINFO of koonapin-bin     bun run build:aur
//     updates/<version>/   latest.json of the updater; .sig files lie next to the packages   bun run build:latest
//     chrome/<version>/    koonapin-chrome.zip, Chrome Web Store    bun run extension:build
//     edge/<version>/      koonapin-edge.zip, Edge Add-ons          bun run extension:build
//     firefox/             signed XPIs and updates.json; the site serves them   bun run extension:sign:firefox
//     site/                koona.app/pin as deployed                bun run site:build
//   release/test/      a test machine; never published
//     windows/<version>/   installer, unsigned                       bun run build:installer
//     chrome-edge/<version>/  extension with the store id            bun run extension:build (CHROME_STORE_PUBLIC_KEY)
//   release/dev/       this machine
//     chrome/, edge/, firefox/  unpacked, development id («Load unpacked», tests)   bun run extension:build
//
// Tools keep their own working folders and nothing is taken from them by hand: src-tauri/target
// (Cargo and Tauri: debug and release EXEs, NSIS intermediates) and dist/ (Vite, the app's interface).
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "..", "..");
export const release = path.join(root, "release");

export const publish = {
  windows: (version) => path.join(release, "publish", "windows", version),
  linux: (version) => path.join(release, "publish", "linux", version),
  aur: (version) => path.join(release, "publish", "aur", version),
  chrome: (version) => path.join(release, "publish", "chrome", version),
  edge: (version) => path.join(release, "publish", "edge", version),
  /** The address of these files is inside every signed XPI (gecko.update_url): only the local folder moves. */
  firefox: path.join(release, "publish", "firefox"),
  site: path.join(release, "publish", "site"),
};

export const test = {
  windows: (version) => path.join(release, "test", "windows", version),
  chromeEdge: (version) => path.join(release, "test", "chrome-edge", version),
};

export const dev = {
  extension: (browser) => path.join(release, "dev", browser),
};

/** Tauri's NSIS output, copied from here into publish/ or test/ by build-installer.mjs. */
export const nsisBundle = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
