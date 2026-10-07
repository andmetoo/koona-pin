// Linux checks from Windows (NP-093, doc/testing.md «Linux»): `npm run check` in a Ubuntu 22.04
// container, then clippy and the release build. Docker Desktop must be running. The image takes Rust
// from rust-toolchain.toml and Node from .nvmrc; the copy of the repository, its node_modules, the
// Cargo target and registry live in volumes, so only the first run is long. The release binaries go to
// release/test/linux/<version>/ for a test machine.
//   npm run check:linux                         everything
//   npm run check:linux -- cargo test --locked --manifest-path src-tauri/Cargo.toml db::
//   npm run check:linux -- bash                 a shell in the copy (/work)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { root, test } from "../lib/paths.mjs";

const image = "koonapin-linux";
const read = (file) => readFileSync(path.join(root, file), "utf8");
const rust = read("rust-toolchain.toml").match(/channel\s*=\s*"([^"]+)"/)[1];
const node = read(".nvmrc").trim().replace(/^v/, "");
const out = test.linux(JSON.parse(read("package.json")).version);
mkdirSync(out, { recursive: true });

const docker = (args) => execFileSync("docker", args, { cwd: root, stdio: "inherit" });

const work = ["-v", `${image}-work:/work`];
const command = process.argv.slice(2);
let status = 0;
try {
  docker(["build", "-t", image, "--build-arg", `RUST_VERSION=${rust}`, "--build-arg", `NODE_VERSION=${node}`, path.join(root, "scripts", "linux")]);
  docker([
    "run", "--rm", ...(command.length && process.stdin.isTTY ? ["-it"] : []),
    "-v", `${root}:/src:ro`, ...work, "-v", `${image}-cargo:/opt/cargo/registry`,
    image, "bash", "/src/scripts/linux/check.sh", ...command,
  ]);
} catch (error) {
  status = error.status ?? 1;
}
// The checks run as a user that may not write to a Windows folder: root copies what they left.
if (!command.length) {
  try {
    docker(["run", "--rm", "--user", "0", ...work, "-v", `${out}:/out`, image, "sh", "-c", "cp -r /work/.out/. /out/ 2>/dev/null || true"]);
    console.log(`check:linux: ${path.relative(root, out)}`);
  } catch {}
}
process.exit(status);
