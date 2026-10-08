// The AUR package of a release (NP-101, Р-55): PKGBUILD and .SRCINFO of koonapin-bin for the .deb that
// bun run build:linux made → release/publish/aur/<version>/, to push to aur.archlinux.org/koonapin-bin.git
// (doc/release-checklist.md). Any system: .SRCINFO is written here, and the «distro» job of Arch checks it
// against makepkg --printsrcinfo.
//   bun run build:aur                    the .deb of release/publish/linux/<version>/
//   bun scripts/build-aur.mjs --deb <file> --out <folder>
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { publish, root } from "./lib/paths.mjs";

/** Who answers for the package on the AUR, as in the .deb and .rpm (Р-54). */
const MAINTAINER = "Koona <support@koona.app>";

const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const { version } = JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const deb = path.resolve(arg("--deb") ?? path.join(publish.linux(version), `koonapin_${version}_amd64.deb`));
if (!existsSync(deb)) {
  console.error(`No .deb at ${deb}: bun run build:linux first, or --deb <file>.`);
  process.exit(1);
}
const out = path.resolve(arg("--out") ?? publish.aur(version));
const sha256 = createHash("sha256").update(await readFile(deb)).digest("hex");

const pkgbuild = (await readFile(path.join(root, "src-tauri", "linux", "aur", "PKGBUILD"), "utf8"))
  .replace(/\r/g, "")
  .replaceAll("@MAINTAINER@", MAINTAINER)
  .replaceAll("@VERSION@", version)
  .replaceAll("@SHA256@", sha256);

// The variables of the PKGBUILD, as bash would see them: one value or a list in (…), ${pkgver} filled in.
const field = (name) => {
  const match = pkgbuild.match(new RegExp(`^${name}=(\\([\\s\\S]*?\\)|.*)$`, "m"));
  if (!match) return [];
  const raw = match[1].startsWith("(") ? match[1].slice(1, -1) : match[1];
  return [...raw.matchAll(/'([^']*)'|"([^"]*)"|([^\s'"]+)/g)]
    .map((m) => m[1] ?? m[2] ?? m[3])
    .map((value) => value.replaceAll("${pkgver}", version).replaceAll("$pkgver", version));
};
// The order of makepkg --printsrcinfo.
const global = ["pkgdesc", "pkgver", "pkgrel", "url", "arch", "license", "depends", "optdepends", "provides", "conflicts", "options", "source", "sha256sums"];
const srcinfo = [
  `pkgbase = ${field("pkgname")[0]}`,
  ...global.flatMap((name) => field(name).map((value) => `\t${name} = ${value}`)),
  "",
  `pkgname = ${field("pkgname")[0]}`,
  "",
].join("\n");

await mkdir(out, { recursive: true });
await writeFile(path.join(out, "PKGBUILD"), pkgbuild);
await writeFile(path.join(out, ".SRCINFO"), srcinfo);
console.log(`${path.relative(root, out) || out}: PKGBUILD and .SRCINFO of koonapin-bin ${version}-1\n${path.basename(deb)} sha256 ${sha256}`);
