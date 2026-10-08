// The app that the native tests and the site screenshots drive: a debug build with the interface
// embedded (Tauri's custom-protocol feature), as in the release, so the CSP and the tauri.localhost
// origin are the real ones. A plain `cargo build`, and the `cargo test` of `bun run check`, write the
// same src-tauri/target/debug/koonapin.exe without it: that one loads the Vite server on
// localhost:1420 and has no CSP at all (Tauri applies it to embedded pages only).
// bun runs this before test:native, test:perf and site:shots. With KOONAPIN_TEST_BINARY set (a
// release binary, doc/testing.md) there is nothing to build.
//   bun scripts/build-test-app.mjs
import { execSync } from "node:child_process";
import { root } from "./lib/paths.mjs";

if (process.env.KOONAPIN_TEST_BINARY) {
  console.log(`build-test-app: KOONAPIN_TEST_BINARY=${process.env.KOONAPIN_TEST_BINARY}, nothing to build`);
} else {
  // The interface first: the binary embeds dist/ as it is at compile time.
  execSync("bun run build", { cwd: root, stdio: "inherit" });
  execSync("cargo build --features custom-protocol --locked --manifest-path src-tauri/Cargo.toml", { cwd: root, stdio: "inherit" });
}
