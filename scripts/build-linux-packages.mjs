// Builds the Linux packages (NP-055, Р-45, Р-53): koonapin_<version>_amd64.deb for Ubuntu and Debian and
// koonapin-<version>-1.x86_64.rpm for Fedora, with --features public-release (the native host accepts only
// the store extensions, feedback must have its address) → release/publish/linux/<version>/ with
// SHA256SUMS.txt. No GPG signature in the beta (Р-45, п. 8).
//   bun run build:linux
// On Debian 13, the oldest glibc of the matrix (a binary built on a newer one does not start on an older),
// with the packages of scripts/linux/deps.sh plus rpm (rpmbuild). Settings come from the environment or
// from .env, as for build:installer.
//
// Tauri compiles once and builds the .deb; the package's manifests come from the app itself
// (`koonapin --package-manifests`, the constants of native_host.rs). The .rpm is packed by rpmbuild from
// the .deb's tree (src-tauri/linux/koonapin.spec): Tauri's rpm writer sets no changelog and no build host.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { publish, root } from "./lib/paths.mjs";

if (process.platform !== "linux") {
  console.error("The Linux packages are built on Linux (Debian 13): see doc/testing.md, «Linux».");
  process.exit(1);
}
const dotenv = path.join(root, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);
if (!process.env.KOONAPIN_FEEDBACK_URL) {
  console.error("KOONAPIN_FEEDBACK_URL is not set: the release build does not compile without it (supabase/README.md).");
  process.exit(1);
}

/** Who answers for the packages: Maintainer of the .deb, Packager of the .rpm. */
const MAINTAINER = "Koona <support@koona.app>";
const SUMMARY = "Desktop bookmark library: save a link in one click";
const DESCRIPTION = [
  "Koona Pin is a desktop bookmark library. Pages arrive from Chrome, Edge, Chromium and Firefox with one",
  "button of the Koona Pin extension and stay on your computer: no account, no cloud. The package brings the",
  "native messaging host and registers it in the browsers, so saving works before the app is first started.",
].join(" ");

const conf = JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
const linux = path.join(root, "src-tauri", "linux");
const target = path.join(root, "src-tauri", "target", "release");
const stage = path.join(target, "linux-package");
const bundles = path.join(target, "bundle");

// Packages want 0755 binaries and 0644 files; a group-writable umask would carry into the .rpm.
process.umask(0o022);
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.status !== 0) {
    console.error(`${command} ${args.join(" ")}: exit ${result.status ?? result.signal}`);
    process.exit(result.status ?? 1);
  }
  return result;
};
const output = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

// Stripped binaries (lintian, rpmlint), and the C of the app (SQLite) built with Debian's hardening flags.
const flags = (name) => output("dpkg-buildflags", ["--get", name]);
const env = {
  ...process.env,
  CARGO_PROFILE_RELEASE_STRIP: "symbols",
  CFLAGS: `${flags("CFLAGS")} ${flags("CPPFLAGS")}`,
};
const tauri = (...args) => run(process.execPath, [path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"), ...args], { env });

tauri("build", "--no-bundle", "--features", "public-release");
const binaries = ["koonapin", "koonapin-host"].map((name) => path.join(target, name));
// What Cargo's strip leaves: the compiler's notes (lintian, as dh_strip does).
run("strip", ["--remove-section=.comment", "--remove-section=.note", ...binaries]);

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
const staged = (name) => path.join(stage, name);

// The manifests of each package, written by the app from its own constants.
for (const kind of ["deb", "rpm"]) run(binaries[0], ["--package-manifests", kind, staged(`${kind}-root`)], { stdio: "ignore" });
const filesUnder = async (dir) =>
  (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
const manifests = async (kind) =>
  Object.fromEntries((await filesUnder(staged(`${kind}-root`))).map((file) => [`/${path.relative(staged(`${kind}-root`), file).split(path.sep).join("/")}`, file]));

const date = new Date();
await writeFile(
  staged("app.koona.pin.metainfo.xml"),
  (await readFile(path.join(linux, "app.koona.pin.metainfo.xml"), "utf8")).replaceAll("@VERSION@", version).replaceAll("@DATE@", date.toISOString().slice(0, 10)),
);
// Debian wants the whole license text: the AGPL is not among /usr/share/common-licenses.
const license = (await readFile(path.join(root, "LICENSE"), "utf8")).replace(/\r/g, "").trimEnd().split("\n");
await writeFile(
  staged("copyright"),
  `${(await readFile(path.join(linux, "copyright"), "utf8")).replace(/\r/g, "").trimEnd()}\n\nLicense: AGPL-3.0-only\n${license.map((l) => (l.trim() ? ` ${l}` : " .")).join("\n")}\n`,
);
await writeFile(
  staged("changelog"),
  `koonapin (${version}) unstable; urgency=medium\n\n  * Koona Pin ${version} for Linux.\n\n -- ${MAINTAINER}  ${date.toUTCString().replace("GMT", "+0000")}\n`,
);
for (const page of ["koonapin.1", "koonapin-host.1"]) await writeFile(staged(`${page}.gz`), gzipSync(await readFile(path.join(linux, page)), { level: 9 }));
// hicolor takes an icon's folder from its size: 128x128@2x.png would land in 256x256@2 (for 512 px).
await copyFile(path.join(root, "src-tauri", "icons", "128x128@2x.png"), staged("256x256.png"));
const icons = ["icons/32x32.png", "icons/64x64.png", "icons/128x128.png", staged("256x256.png"), "icons/icon.png"];

// Libraries the binaries link, with the versions this Debian has; the tray library is loaded at run time
// and named by hand (Р-26, п. 3).
await mkdir(staged("shlibdeps/debian"), { recursive: true });
await writeFile(staged("shlibdeps/debian/control"), "Source: koonapin\n\nPackage: koonapin\nArchitecture: any\n");
const linked = output("dpkg-shlibdeps", ["-O", ...binaries], { cwd: staged("shlibdeps") })
  .replace(/^shlibs:Depends=/, "")
  .split(/,\s*/);

const bundle = (kind, linuxConfig) =>
  tauri(
    "bundle",
    "--bundles",
    kind,
    "--features",
    "public-release",
    "--config",
    JSON.stringify({
      // The package and its .desktop are named after the program (`koonapin`), not «Koona Pin»: the
      // compiled app keeps its name, `tauri bundle` does not compile.
      productName: "koonapin",
      bundle: {
        active: true,
        publisher: MAINTAINER,
        shortDescription: SUMMARY,
        longDescription: DESCRIPTION,
        icon: icons,
        linux: linuxConfig,
      },
    }),
  );

for (const dir of ["deb", "rpm"]) await rm(path.join(bundles, dir), { recursive: true, force: true });
bundle("deb", {
  deb: {
    depends: [...linked, "libayatana-appindicator3-1"],
    recommends: ["fonts-noto-cjk"],
    section: "utils",
    changelog: staged("changelog"),
    desktopTemplate: path.join(linux, "koonapin.desktop"),
    files: {
      ...(await manifests("deb")),
      "/usr/share/metainfo/app.koona.pin.metainfo.xml": staged("app.koona.pin.metainfo.xml"),
      "/usr/share/doc/koonapin/copyright": staged("copyright"),
      "/usr/share/man/man1/koonapin.1.gz": staged("koonapin.1.gz"),
      "/usr/share/man/man1/koonapin-host.1.gz": staged("koonapin-host.1.gz"),
      "/usr/share/lintian/overrides/koonapin": path.join(linux, "lintian-overrides"),
    },
  },
});
const deb = path.join(bundles, "deb", `koonapin_${version}_amd64.deb`);

// What Tauri's deb writer cannot do, by dpkg-deb on its package. A file in /etc would have to be a conffile,
// and dpkg keeps those after `apt remove` (a manifest naming a host that is gone) and does not bring a
// deleted one back on reinstall — the remedy the app suggests (Р-53, п. 2). So the manifests of Chrome,
// Edge and Chromium are links to one file of the package, as Debian's own native hosts do.
const repack = staged("deb");
run("dpkg-deb", ["--raw-extract", deb, repack]);
const shared = "/usr/share/koonapin/native-messaging-hosts/app.koona.pin.json";
await mkdir(path.join(repack, path.dirname(shared)), { recursive: true });
for (const at of Object.keys(await manifests("deb")).filter((at) => at.startsWith("/etc/"))) {
  await rename(path.join(repack, at), path.join(repack, shared));
  await symlink(shared, path.join(repack, at));
}
// The extended description in lines of at most 80 characters.
const wrapped = DESCRIPTION.split(" ").reduce((lines, word) => {
  const last = lines.at(-1);
  if (last && `${last} ${word}`.length <= 78) lines[lines.length - 1] = `${last} ${word}`;
  else lines.push(word);
  return lines;
}, []);
const control = path.join(repack, "DEBIAN", "control");
const fields = (await readFile(control, "utf8")).replace(/^Description:[\s\S]*?(?=^\S|$(?![\s\S]))/m, "");
const installed = Math.ceil(
  (await Promise.all((await filesUnder(repack)).filter((f) => !f.includes(`${path.sep}DEBIAN${path.sep}`)).map((f) => stat(f)))).reduce(
    (sum, s) => sum + s.size,
    0,
  ) / 1024,
);
// Tauri adds its own unversioned libwebkit2gtk-4.1-0 and libgtk-3-0 after the versions dpkg-shlibdeps
// found (libgtk-3-0t64 provides libgtk-3-0): each library once, the first, versioned entry.
const depends = (line) => {
  const seen = new Set();
  return line
    .split(/,\s*/)
    .filter((entry) => {
      const name = entry.split(/[\s(]/)[0].replace(/t64$/, "");
      return !seen.has(name) && seen.add(name);
    })
    .join(", ");
};
await writeFile(
  control,
  `${fields
    .replace(/^Installed-Size: .*$/m, `Installed-Size: ${installed}`)
    .replace(/^Depends: (.*)$/m, (_, line) => `Depends: ${depends(line)}`)
    .trimEnd()}\nDescription: ${SUMMARY}\n${wrapped.map((l) => ` ${l}`).join("\n")}\n`,
);
const md5 = [];
for (const file of (await filesUnder(repack)).filter((f) => !f.includes(`${path.sep}DEBIAN${path.sep}`)).sort()) {
  md5.push(`${createHash("md5").update(await readFile(file)).digest("hex")}  ${path.relative(repack, file).split(path.sep).join("/")}`);
}
await writeFile(path.join(repack, "DEBIAN", "md5sums"), `${md5.join("\n")}\n`);
run("dpkg-deb", ["--build", "--root-owner-group", repack, deb], { stdio: ["ignore", "ignore", "inherit"] });

// Tauri marks the binaries with their package type for the updater; its own .rpm is not used.
bundle("rpm", { rpm: { desktopTemplate: path.join(linux, "koonapin.desktop") } });
// The tree of the repacked .deb, links in /etc included; the Debian-only files go, the lib64 manifest of
// Fedora's Firefox comes.
const tree = staged("rpm-tree");
await cp(repack, tree, { recursive: true, verbatimSymlinks: true, filter: (from) => !from.startsWith(path.join(repack, "DEBIAN")) });
for (const binary of binaries) await copyFile(binary, path.join(tree, "usr", "bin", path.basename(binary)));
// Debian wants a link between top-level folders absolute, rpm relative.
for (const at of Object.keys(await manifests("deb")).filter((at) => at.startsWith("/etc/"))) {
  await rm(path.join(tree, at));
  await symlink(path.posix.relative(path.posix.dirname(at), shared), path.join(tree, at));
}
await rm(path.join(tree, "usr", "share", "doc"), { recursive: true });
await rm(path.join(tree, "usr", "share", "lintian"), { recursive: true });
for (const [at, file] of Object.entries(await manifests("rpm")).filter(([at]) => !at.startsWith("/etc/"))) {
  await mkdir(path.join(tree, path.dirname(at)), { recursive: true });
  await copyFile(file, path.join(tree, at));
}
await mkdir(path.join(tree, "usr", "share", "licenses", "koonapin"), { recursive: true });
await copyFile(path.join(root, "LICENSE"), path.join(tree, "usr", "share", "licenses", "koonapin", "LICENSE"));
for (const file of await filesUnder(tree)) await chmod(file, file.includes(`${path.sep}bin${path.sep}`) ? 0o755 : 0o644);
await writeFile(
  staged("koonapin.spec"),
  (await readFile(path.join(linux, "koonapin.spec"), "utf8"))
    .replaceAll("@VERSION@", version)
    .replaceAll("@PACKAGER@", MAINTAINER)
    // «Thu Oct 08 2026», the order rpm reads.
    .replaceAll("@CHANGELOG_DATE@", date.toDateString()),
);
run("rpmbuild", ["-bb", "--quiet", "--define", `_topdir ${staged("rpmbuild")}`, "--define", `tree ${tree}`, staged("koonapin.spec")], { env });
const rpm = path.join(stage, "rpmbuild", "RPMS", "x86_64", `koonapin-${version}-1.x86_64.rpm`);

// Into release/, with the hashes and where they came from.
const out = publish.linux(version);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const sums = [];
for (const file of [deb, rpm]) {
  const copy = path.join(out, path.basename(file));
  await copyFile(file, copy);
  sums.push(`${createHash("sha256").update(await readFile(copy)).digest("hex")}  ${path.basename(file)}`);
  console.log(`\n${path.relative(root, copy)}: ${((await stat(copy)).size / 1024 / 1024).toFixed(1)} MB`);
}
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout?.trim() ?? "";
const dirty = git("status", "--porcelain", "--untracked-files=no") ? " with uncommitted changes" : "";
await writeFile(
  path.join(out, "SHA256SUMS.txt"),
  `${sums.join("\n")}\n\nunsigned (no GPG in the beta); commit ${git("rev-parse", "--short", "HEAD") || "unknown"}${dirty}; built ${date.toISOString()}\n`,
);
console.log(`\n${output("dpkg-deb", ["--info", deb])}\n\n${output("dpkg-deb", ["--contents", deb])}`);
// A query of the file only: an empty database of its own, Debian has none in /var/lib/rpm.
const rpmdb = ["--dbpath", staged("rpmdb")];
await mkdir(staged("rpmdb"), { recursive: true });
console.log(`\n${output("rpm", [...rpmdb, "-qip", "--requires", rpm])}\n\n${output("rpm", [...rpmdb, "-qlpv", rpm])}`);
console.log(`\n${sums.join("\n")}`);
