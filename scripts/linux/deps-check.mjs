// Proves scripts/linux/deps.sh on every distribution of the Linux-beta contract (NP-093): a bare
// image of each installs the packages and Rust and builds the app. Run it after changing deps.sh or
// the Rust dependencies; versions go to .test-data/linux-deps/<image>.txt. Docker Desktop must be running.
//   node scripts/linux/deps-check.mjs                    ubuntu:24.04 ubuntu:26.04 fedora:44 fedora:45 archlinux
//   node scripts/linux/deps-check.mjs fedora:45          one of them
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { root } from "../lib/paths.mjs";

const images = process.argv.length > 2 ? process.argv.slice(2) : ["ubuntu:24.04", "ubuntu:26.04", "fedora:44", "fedora:45", "archlinux:latest"];
const rust = readFileSync(path.join(root, "rust-toolchain.toml"), "utf8").match(/channel\s*=\s*"([^"]+)"/)[1];
const out = path.join(root, ".test-data", "linux-deps");
mkdirSync(out, { recursive: true });

const results = [];
for (const image of images) {
  const tag = image.replace(/[:.]/g, "-");
  console.log(`\n== ${image}`);
  const run = spawnSync("docker", [
    "run", "--rm", "-e", `RUST_VERSION=${rust}`, "-e", `NAME_TAG=${tag}`,
    "-v", `${root}:/src:ro`, "-v", `${out}:/out`,
    // Each distribution keeps its own target (other system libraries) and shares the registry.
    "-v", `koonapin-deps-${tag}:/work/src-tauri/target`, "-v", "koonapin-linux-cargo:/opt/cargo/registry",
    image, "bash", "/src/scripts/linux/deps-check.sh",
  ], { stdio: "inherit" });
  results.push([image, run.status === 0]);
}
console.log("");
for (const [image, ok] of results) console.log(`${ok ? "ok  " : "FAIL"}  ${image}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
