// The last step of a release: the site takes the published GitHub Release (Р-60: the app's updates come
// from koona.app/pin, not from GitHub).
//   bun run release:site -- -Server user@host            the release of this version, then deploy-site.ps1
//   bun run release:site -- 0.12.0 -Server user@host     another version's
//   bun run release:site -- --no-deploy                  only the download; pwsh scripts/deploy-site.ps1 later
// Everything else is passed to scripts/deploy-site.ps1 (-DryRun, -WithoutFeedback, …).
// From the release: latest.json (release.yml's finalize wrote it), SHA256SUMS.txt and every package
// latest.json names with its .sig → release/publish/updates/<version>/, the folder build-latest.mjs fills
// locally and build-site.mjs serves at /downloads/<version>/ and /updates/latest.json. The macOS files,
// the per-system SHA256SUMS-*.txt and the AUR files stay on GitHub only.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { SITE } from "../site/src/content.mjs";
import { publish, root } from "./lib/paths.mjs";
import { version as currentVersion } from "./version.mjs";

const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const run = (cmd, args, options = {}) => spawnSync(cmd, args, { cwd: root, encoding: "utf8", ...options });

const args = process.argv.slice(2);
const given = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));
const noDeploy = args.includes("--no-deploy");
const passed = args.filter((a) => a !== given && a !== "--no-deploy");
let version = given;
if (!version) {
  try {
    version = await currentVersion();
  } catch (error) {
    fail(error.message);
  }
}
const tag = `v${version}`;

const view = run("gh", ["release", "view", tag, "--json", "isDraft,assets"]);
if (view.error || view.status !== 0) fail(`No release ${tag} on GitHub (gh release view: ${(view.stderr ?? "").trim()}): bun run release says where it stands.`);
const { isDraft, assets } = JSON.parse(view.stdout);
if (isDraft) fail(`${tag} is still a draft: the site serves a published release only (release.yml's finalize publishes it).`);

const folder = path.join(publish.updates, version);
await rm(folder, { recursive: true, force: true });
await mkdir(folder, { recursive: true });
const download = (...patterns) => {
  const done = run("gh", ["release", "download", tag, "--dir", folder, ...patterns.flatMap((p) => ["--pattern", p])], { stdio: "inherit" });
  if (done.status !== 0) fail(`gh release download ${tag} failed`);
};
download("latest.json", "SHA256SUMS.txt");
const latest = JSON.parse(await readFile(path.join(folder, "latest.json"), "utf8"));
if (latest.version !== version) fail(`latest.json of ${tag} announces ${latest.version}`);

// The packages by the names latest.json gives them on the site: the same names as on GitHub.
const prefix = `${SITE}/downloads/${version}/`;
const files = [
  ...new Set(
    Object.values(latest.platforms).map(({ url }) => {
      if (!url.startsWith(prefix)) fail(`latest.json: ${url} is not under ${prefix}`);
      return decodeURIComponent(url.slice(prefix.length));
    }),
  ),
];
const names = assets.map((a) => a.name);
const absent = files.flatMap((f) => [f, `${f}.sig`]).filter((f) => !names.includes(f));
if (absent.length) fail(`${tag} has no ${absent.join(", ")}`);
download(...files.flatMap((f) => [f, `${f}.sig`]));

// The bytes are the ones the release lists (build-site.mjs checks the signatures).
const sums = await readFile(path.join(folder, "SHA256SUMS.txt"), "utf8");
for (const file of files) {
  const hash = createHash("sha256")
    .update(await readFile(path.join(folder, file)))
    .digest("hex");
  if (!sums.includes(`${hash}  ${file}`)) fail(`${file}: its SHA-256 ${hash} is not the one SHA256SUMS.txt of ${tag} lists`);
}
console.log(`\n${path.relative(root, folder)}: ${(await readdir(folder)).join(", ")}`);

if (noDeploy) {
  console.log("--no-deploy: the site goes out with pwsh scripts/deploy-site.ps1 -Server user@host");
  process.exit(0);
}
console.log(`\n== pwsh scripts/deploy-site.ps1 ${passed.join(" ")}`);
const deployed = run("pwsh", [path.join(root, "scripts", "deploy-site.ps1"), ...passed], { stdio: "inherit" });
if (deployed.error) fail(`pwsh: ${deployed.error.message} (PowerShell 7 runs deploy-site.ps1)`);
process.exit(deployed.status ?? 1);
