// Builds the Linux packages (NP-055, Р-45, Р-53): koonapin_<version>_amd64.deb for Ubuntu and Debian,
// koonapin-<version>-1.x86_64.rpm for Fedora and koonapin-<version>-x86_64.AppImage for the rest (NP-116), with --features public-release (the native host accepts only
// the store extensions, feedback must have its address) → release/publish/linux/<version>/ with
// SHA256SUMS.txt. No GPG signature in the beta (Р-45, п. 8).
//
// The binaries are compiled once and every package is made from them, each on its own system, by stages
// that hand files to each other through dist-linux/ (the artifact of .github/workflows/linux.yml):
//   --stage compile   Void Linux (image «void»): the release build, stripped, glibc checked against the
//                     floor of the matrix; dist-linux/bin/ (unmarked binaries), dist-linux/raw/ (Tauri's .deb)
//                     and the AppImage
//   --stage deb       Debian 13 («debian»): Tauri's .deb repacked → dist-linux/koonapin_<v>_amd64.deb
//   --stage rpm       Fedora («fedora»): the tree of Tauri's .deb, packed by rpmbuild → dist-linux/*.rpm
//   --stage collect   anywhere: the three packages → release/publish/linux/<version>/ with SHA256SUMS.txt
//   no --stage        on Linux: every stage in turn (needs every tool of the four)
//
//   bun run build:linux                          on macOS or Windows: the stages in Docker, in the CI's own
//                                                images (scripts/linux/images.mjs), then collect
//   bun run build:linux -- --from-ci <tag|run>   anywhere: the packages of a CI run (gh run download)
// Settings come from the environment or from .env, as for build:installer.
//
// Tauri compiles once and builds the .deb; the package's manifests come from the app itself
// (`koonapin --package-manifests`, the constants of native_host.rs). The .rpm is packed by rpmbuild from
// the .deb's tree (src-tauri/linux/koonapin.spec): Tauri's rpm writer sets no changelog and no build host.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { publish, root } from "./lib/paths.mjs";

const dotenv = path.join(root, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);
const conf = JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;

/** Who answers for the packages: Maintainer of the .deb, Packager of the .rpm. */
const MAINTAINER = "Koona <support@koona.app>";
const SUMMARY = "Desktop bookmark library: save a link in one click";
const DESCRIPTION = [
  "Koona Pin is a desktop bookmark library. Pages arrive from Chrome, Edge, Chromium and Firefox with one",
  "button of the Koona Pin extension and stay on your computer. The package brings the native messaging",
  "host and registers it in the browsers, so saving works before the app is first started.",
].join(" ");
/** The artifact of linux.yml that holds the packages (and, from release.yml, their .sig). */
const ARTIFACT = "koonapin-linux-x86_64";
const STAGES = ["compile", "deb", "rpm", "collect"];

const linux = path.join(root, "src-tauri", "linux");
const target = path.join(root, "src-tauri", "target", "release");
const bundles = path.join(target, "bundle");
/** What the stages hand each other; the CI uploads it between jobs. */
const dist = path.join(root, "dist-linux");
const NAMES = ["koonapin", "koonapin-host", "koonapin-mcp"];
const files = {
  bin: (name) => path.join(dist, "bin", name),
  raw: path.join(dist, "raw", `koonapin_${version}_amd64.deb`),
  deb: path.join(dist, `koonapin_${version}_amd64.deb`),
  rpm: path.join(dist, `koonapin-${version}-1.x86_64.rpm`),
  // The name people know from other AppImages: <name>-<version>-<arch>.AppImage.
  appimage: path.join(dist, `koonapin-${version}-x86_64.AppImage`),
};
const SHARED = "/usr/share/koonapin/native-messaging-hosts/app.koona.pin.json";

// Packages want 0755 binaries and 0644 files; a group-writable umask would carry into the .rpm.
process.umask(0o022);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
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
const has = (command) => spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
const filesUnder = async (dir) =>
  (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
const mb = async (file) => `${((await stat(file)).size / 1024 / 1024).toFixed(1)} MB`;
const need = (file, by) => {
  if (!existsSync(file)) fail(`${path.relative(root, file)} is missing: ${by} makes it`);
};

/** A stage's own working folder, empty. */
async function staging(name) {
  const dir = path.join(target, "linux-package", name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return (file) => path.join(dir, file);
}

// The manifests of each package, written by the app from its own constants in compile, where the binary
// runs anyway: the deb and rpm stages read them from the artifact, so the image of the rpm stage needs no
// WebKitGTK to start the app (Fedora's run-time checks want the package to bring it).
const manifestsOf = (kind) => path.join(dist, "raw", "manifests", kind);
/** The manifests of a package, as compile wrote them: { "/etc/…": file }. */
async function manifests(kind) {
  const into = manifestsOf(kind);
  need(into, "--stage compile");
  return Object.fromEntries((await filesUnder(into)).map((file) => [`/${path.relative(into, file).split(path.sep).join("/")}`, file]));
}

/** The binaries of dist-linux/bin lose their mode in an artifact of Actions; they run in deb and rpm. */
async function binariesRun() {
  for (const name of NAMES) {
    need(files.bin(name), "--stage compile");
    await chmod(files.bin(name), 0o755);
  }
}

// The updater looks for the release of the binary's package type (`linux-x86_64-rpm`). Tauri marks only
// the copy it packs, never target/release: the binary of the .deb says «deb», and the .rpm made it «rpm»
// as Tauri does, the bytes of a string of the same length. Up to 0.11.0 the .rpm took the unmarked binary
// of target/release, found no release for itself and said it was up to date.
const bundleType = (kind) => Buffer.from(`__TAURI_BUNDLE_TYPE_VAR_${kind}`);
/** What a package carries, not its tree: the files of it unpacked, where only koonapin has the mark. */
function checkMark(kind, command, args) {
  const payload = spawnSync(command, args, { maxBuffer: 1024 ** 3 }).stdout;
  const marks = payload.toString("latin1").match(/__TAURI_BUNDLE_TYPE_VAR_\w{3}/g) ?? [];
  if (marks.join() !== `__TAURI_BUNDLE_TYPE_VAR_${kind}`) throw new Error(`${command} ${args.at(-1)}: bundle type ${marks.join() || "none"}, not ${kind}`);
}

// Debian 13's hardening flags for amd64 (`dpkg-buildflags --get CFLAGS` and `--get CPPFLAGS` on debian:13,
// less -ffile-prefix-map, which names the build folder), for the C of the app (SQLite). The compile stage
// runs on Void, which has no dpkg-buildflags; the binaries are the ones Debian's checks (lintian) see.
const DEBIAN_CFLAGS = [
  "-g -O2 -Werror=implicit-function-declaration -fstack-protector-strong -fstack-clash-protection -Wformat -Werror=format-security -fcf-protection",
  "-Wdate-time -D_FORTIFY_SOURCE=2",
].join(" ");

/** On Void: the release build, once; the binaries, Tauri's .deb and the AppImage into dist-linux/. */
async function compile() {
  if (!process.env.KOONAPIN_FEEDBACK_URL) fail("KOONAPIN_FEEDBACK_URL is not set: the release build does not compile without it (supabase/README.md).");
  // Stripped binaries (lintian, rpmlint), and the C of the app built with Debian's hardening flags.
  const env = { ...process.env, CARGO_PROFILE_RELEASE_STRIP: "symbols", CFLAGS: DEBIAN_CFLAGS };
  const tauri = (...args) => run(process.execPath, [path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"), ...args], { env });

  tauri("build", "--no-bundle", "--features", "public-release");
  const binaries = NAMES.map((name) => path.join(target, name));
  // What Cargo's strip leaves: the compiler's notes (lintian, as dh_strip does).
  run("strip", ["--remove-section=.comment", "--remove-section=.note", ...binaries]);
  // A binary built on a newer glibc does not start on an older one: the oldest of the matrix is the floor.
  run("bash", [path.join(root, "scripts", "linux", "check-glibc.sh"), ...binaries]);
  // The unmarked binaries, before Tauri packs any copy: the tests run them as they are.
  await rm(dist, { recursive: true, force: true });
  await mkdir(path.join(dist, "bin"), { recursive: true });
  await mkdir(path.join(dist, "raw"), { recursive: true });
  for (const name of NAMES) await copyFile(path.join(target, name), files.bin(name));
  for (const kind of ["deb", "rpm"]) run(files.bin("koonapin"), ["--package-manifests", kind, manifestsOf(kind)], { stdio: "ignore" });

  const staged = await staging("compile");
  const date = new Date();
  await writeFile(
    staged("app.koona.pin.metainfo.xml"),
    (await readFile(path.join(linux, "app.koona.pin.metainfo.xml"), "utf8")).replaceAll("@VERSION@", version).replaceAll("@DATE@", date.toISOString().slice(0, 10)),
  );
  // Debian Policy 12.5 (lintian copyright-not-using-common-license-for-gpl): the GPL is not copied
  // into the package but named by its path in base-files. The .rpm and the AppImage carry LICENSE.
  await writeFile(
    staged("copyright"),
    `${(await readFile(path.join(linux, "copyright"), "utf8")).replace(/\r/g, "").trimEnd()}\n\nLicense: GPL-3.0-only\n On Debian systems, the complete text of the GNU General Public License version 3 can be found\n in "/usr/share/common-licenses/GPL-3".\n`,
  );
  await writeFile(
    staged("changelog"),
    `koonapin (${version}) unstable; urgency=medium\n\n  * Koona Pin ${version} for Linux.\n\n -- ${MAINTAINER}  ${date.toUTCString().replace("GMT", "+0000")}\n`,
  );
  for (const page of ["koonapin.1", "koonapin-host.1", "koonapin-mcp.1"]) await writeFile(staged(`${page}.gz`), gzipSync(await readFile(path.join(linux, page)), { level: 9 }));
  // hicolor takes an icon's folder from its size: 128x128@2x.png would land in 256x256@2 (for 512 px).
  await copyFile(path.join(root, "src-tauri", "icons", "128x128@2x.png"), staged("256x256.png"));
  const icons = ["icons/32x32.png", "icons/64x64.png", "icons/128x128.png", staged("256x256.png"), "icons/icon.png"];

  // --verbose for the AppImage: Tauri prints linuxdeploy's own output only then, and says no more than
  // «failed to run linuxdeploy» otherwise.
  const bundle = (kind, linuxConfig) =>
    tauri(
      "bundle",
      ...(kind === "appimage" ? ["--verbose"] : []),
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

  // The raw .deb: Tauri's writer is Rust, no dpkg needed. The libraries the binaries link are added to
  // Depends by the deb stage, where dpkg-shlibdeps knows Debian's versions; the tray library is loaded at
  // run time and named by hand (Р-26, п. 3).
  await rm(path.join(bundles, "deb"), { recursive: true, force: true });
  bundle("deb", {
    deb: {
      depends: ["libayatana-appindicator3-1"],
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
        "/usr/share/man/man1/koonapin-mcp.1.gz": staged("koonapin-mcp.1.gz"),
        "/usr/share/lintian/overrides/koonapin": path.join(linux, "lintian-overrides"),
      },
    },
  });
  await copyFile(path.join(bundles, "deb", `koonapin_${version}_amd64.deb`), files.raw);

  // The AppImage for the other distributions (NP-116, Р-63), last: Tauri marks the binary «appimage» for the
  // updater. It carries WebKitGTK and the tray library with it; the manifests and the autostart entry the
  // app writes itself at the start (appimage.rs). linuxdeploy is an AppImage too: in a container without
  // FUSE it runs unpacked.
  await rm(path.join(bundles, "appimage"), { recursive: true, force: true });
  env.APPIMAGE_EXTRACT_AND_RUN = "1";
  // Tauri (cli 2.12) takes the whole line of `pkg-config --libs-only-L ayatana-appindicator3-0.1` for the
  // tray library's folder; Void's pkgconf names several (-L/usr/lib64 -L/usr/lib …). A pkg-config first on
  // PATH for this step gives it the first folder only.
  const realPkgConfig = output("sh", ["-c", "command -v pkg-config"]);
  const shim = await mkdtemp(path.join(tmpdir(), "koonapin-pkg-config-"));
  await writeFile(
    path.join(shim, "pkg-config"),
    `#!/bin/sh
case " $* " in
  *" --libs-only-L "*) "${realPkgConfig}" "$@" | awk '{ print $1; exit }' ;;
  *) exec "${realPkgConfig}" "$@" ;;
esac
`,
    { mode: 0o755 },
  );
  env.PATH = `${shim}:${env.PATH}`;
  bundle("appimage", { deb: { desktopTemplate: path.join(linux, "koonapin.desktop") }, appimage: { bundleMediaFramework: false } });
  await copyFile(path.join(bundles, "appimage", `koonapin_${version}_amd64.AppImage`), files.appimage);
  await chmod(files.appimage, 0o755);
  // The AppImage carries Void's own WebKitGTK, GTK and the rest (linuxdeploy): they must not need a newer
  // glibc than the floor either, or the AppImage would not start where the binaries do.
  const extracted = await mkdtemp(path.join(tmpdir(), "koonapin-appimage-"));
  run(files.appimage, ["--appimage-extract"], { cwd: extracted, stdio: "ignore" });
  const libraries = (await filesUnder(path.join(extracted, "squashfs-root"))).filter((file) => /\.so(\.\d+)*$/.test(file));
  if (!libraries.length) fail(`${path.relative(root, files.appimage)}: no libraries inside`);
  run("bash", [path.join(root, "scripts", "linux", "check-glibc.sh"), "--libraries", ...libraries]);
  await rm(extracted, { recursive: true, force: true });
  console.log(`\n${path.relative(root, files.raw)}: ${await mb(files.raw)}\n${path.relative(root, files.appimage)}: ${await mb(files.appimage)}`);
}

/** On Debian: Tauri's .deb repacked, with Depends from dpkg-shlibdeps. */
async function deb() {
  need(files.raw, "--stage compile");
  await binariesRun();
  const staged = await staging("deb");
  const etc = Object.keys(await manifests("deb")).filter((at) => at.startsWith("/etc/"));

  // Libraries the binaries link, with the versions this Debian has.
  await mkdir(staged("shlibdeps/debian"), { recursive: true });
  await writeFile(staged("shlibdeps/debian/control"), "Source: koonapin\n\nPackage: koonapin\nArchitecture: any\n");
  const linked = output("dpkg-shlibdeps", ["-O", ...NAMES.map(files.bin)], { cwd: staged("shlibdeps") }).replace(/^shlibs:Depends=/, "");

  // What Tauri's deb writer cannot do, by dpkg-deb on its package. A file in /etc would have to be a conffile,
  // and dpkg keeps those after `apt remove` (a manifest naming a host that is gone) and does not bring a
  // deleted one back on reinstall — the remedy the app suggests (Р-53, п. 2). So the manifests of Chrome,
  // Edge and Chromium are links to one file of the package, as Debian's own native hosts do.
  const repack = staged("deb");
  run("dpkg-deb", ["--raw-extract", files.raw, repack]);
  await mkdir(path.join(repack, path.dirname(SHARED)), { recursive: true });
  for (const at of etc) {
    await rename(path.join(repack, at), path.join(repack, SHARED));
    await symlink(SHARED, path.join(repack, at));
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
  // The libraries dpkg-shlibdeps found go first, then what the raw package names: the tray library, and
  // Tauri's own unversioned libwebkit2gtk-4.1-0 and libgtk-3-0 (libgtk-3-0t64 provides libgtk-3-0): each
  // library once, the first, versioned entry.
  const depends = (line) => {
    const seen = new Set();
    return line
      .split(/,\s*/)
      .filter((entry) => {
        if (!entry.trim()) return false;
        const name = entry.split(/[\s(]/)[0].replace(/t64$/, "");
        return !seen.has(name) && seen.add(name);
      })
      .join(", ");
  };
  await writeFile(
    control,
    `${fields
      .replace(/^Installed-Size: .*$/m, `Installed-Size: ${installed}`)
      .replace(/^Depends: (.*)$/m, (_, line) => `Depends: ${depends(`${linked}, ${line}`)}`)
      .trimEnd()}\nDescription: ${SUMMARY}\n${wrapped.map((l) => ` ${l}`).join("\n")}\n`,
  );
  const md5 = [];
  for (const file of (await filesUnder(repack)).filter((f) => !f.includes(`${path.sep}DEBIAN${path.sep}`)).sort()) {
    md5.push(`${createHash("md5").update(await readFile(file)).digest("hex")}  ${path.relative(repack, file).split(path.sep).join("/")}`);
  }
  await writeFile(path.join(repack, "DEBIAN", "md5sums"), `${md5.join("\n")}\n`);
  await rm(files.deb, { force: true });
  run("dpkg-deb", ["--build", "--root-owner-group", repack, files.deb], { stdio: ["ignore", "ignore", "inherit"] });
  checkMark("DEB", "dpkg-deb", ["--fsys-tarfile", files.deb]);
  console.log(`\n${output("dpkg-deb", ["--info", files.deb])}\n\n${output("dpkg-deb", ["--contents", files.deb])}`);
  console.log(`\n${path.relative(root, files.deb)}: ${await mb(files.deb)}`);
}

/** The files of a .deb into a folder: by dpkg-deb where there is one, else by ar and tar (Fedora). */
async function extractDeb(file, into) {
  await mkdir(into, { recursive: true });
  if (has("dpkg-deb")) return run("dpkg-deb", ["-x", file, into]);
  const members = await mkdtemp(path.join(tmpdir(), "koonapin-deb-"));
  const data = output("ar", ["t", file]).split("\n").find((m) => m.startsWith("data.tar"));
  if (!data) fail(`${file}: no data.tar member`);
  run("ar", ["x", file, data], { cwd: members });
  // GNU tar finds the compression (gz, xz, zst) itself.
  run("tar", ["-xf", path.join(members, data), "-C", into]);
  await rm(members, { recursive: true, force: true });
}

/** On Fedora: the tree of Tauri's .deb, made the .rpm's, packed by rpmbuild. From the raw .deb, not the
 * deb stage's, so the two run side by side. */
async function rpm() {
  need(files.raw, "--stage compile");
  await binariesRun();
  const staged = await staging("rpm");
  const etc = Object.keys(await manifests("deb")).filter((at) => at.startsWith("/etc/"));

  // The tree of the .deb with the /etc manifests made links to one file, as in the deb stage; the
  // Debian-only files go, the lib64 manifest of Fedora's Firefox comes.
  const tree = staged("rpm-tree");
  await extractDeb(files.raw, tree);
  await mkdir(path.join(tree, path.dirname(SHARED)), { recursive: true });
  // Debian wants a link between top-level folders absolute, rpm relative.
  for (const at of etc) {
    await rename(path.join(tree, at), path.join(tree, SHARED));
    await symlink(path.posix.relative(path.posix.dirname(at), SHARED), path.join(tree, at));
  }
  const binary = path.join(tree, "usr", "bin", "koonapin");
  const bytes = await readFile(binary);
  const at = bytes.indexOf(bundleType("DEB"));
  if (at < 0 || bytes.indexOf(bundleType("DEB"), at + 1) >= 0) throw new Error(`${binary}: not one bundle type «deb»`);
  bundleType("RPM").copy(bytes, at);
  await writeFile(binary, bytes);
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
      .replaceAll("@CHANGELOG_DATE@", new Date().toDateString()),
  );
  run("rpmbuild", ["-bb", "--quiet", "--define", `_topdir ${staged("rpmbuild")}`, "--define", `tree ${tree}`, staged("koonapin.spec")]);
  await rm(files.rpm, { force: true });
  await copyFile(staged(path.join("rpmbuild", "RPMS", "x86_64", path.basename(files.rpm))), files.rpm);
  checkMark("RPM", "rpm2cpio", [files.rpm]);
  console.log(`\n${path.relative(root, files.rpm)}: ${await mb(files.rpm)}`);
}

/** Into release/, with the hashes and where they came from. */
async function collect() {
  const packages = [files.deb, files.rpm, files.appimage];
  for (const file of packages) need(file, `--stage ${file === files.appimage ? "compile" : file === files.deb ? "deb" : "rpm"}`);
  const out = publish.linux(version);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const sums = [];
  for (const file of packages) {
    const copy = path.join(out, path.basename(file));
    await copyFile(file, copy);
    await chmod(copy, file === files.appimage ? 0o755 : 0o644);
    sums.push(`${createHash("sha256").update(await readFile(copy)).digest("hex")}  ${path.basename(file)}`);
    console.log(`${path.relative(root, copy)}: ${await mb(copy)}`);
  }
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout?.trim() ?? "";
  const dirty = git("status", "--porcelain", "--untracked-files=no") ? " with uncommitted changes" : "";
  // A container may not read the repository's .git (another owner): then the commit is the GITHUB_SHA of
  // the run.
  const commit = git("rev-parse", "--short", "HEAD") || process.env.GITHUB_SHA?.slice(0, 7) || "unknown";
  await writeFile(
    path.join(out, "SHA256SUMS.txt"),
    `${sums.join("\n")}\n\nunsigned (no GPG in the beta); commit ${commit}${dirty}; built ${new Date().toISOString()}\n`,
  );
  // A query of the file only: an empty database of its own, the host may have none in /var/lib/rpm.
  if (has("rpm")) {
    const rpmdb = await mkdtemp(path.join(tmpdir(), "koonapin-rpmdb-"));
    const rpmFile = path.join(out, path.basename(files.rpm));
    console.log(`\n${output("rpm", ["--dbpath", rpmdb, "-qip", "--requires", rpmFile])}\n\n${output("rpm", ["--dbpath", rpmdb, "-qlpv", rpmFile])}`);
    await rm(rpmdb, { recursive: true, force: true });
  }
  console.log(`\n${sums.join("\n")}`);
}

/** The packages of a CI run (linux.yml's artifact), by run id or by tag (the newest release.yml run of it). */
async function fromCi(ref) {
  if (!has("gh")) fail("gh is not installed: https://cli.github.com, then gh auth login");
  let id = ref;
  if (!/^\d+$/.test(ref)) {
    // A run of a tag push has the tag as its branch. The newest successful one: a later run that failed
    // or still runs has no packages, an earlier one of the same tag does.
    const list = spawnSync("gh", ["run", "list", "--workflow", "release.yml", "--branch", ref, "--status", "success", "--limit", "1", "--json", "databaseId,status,conclusion,url"], {
      cwd: root,
      encoding: "utf8",
    });
    if (list.status !== 0) fail(`gh run list: ${list.stderr.trim()}`);
    const runs = JSON.parse(list.stdout || "[]");
    if (!runs.length) fail(`No successful release.yml run of ${ref}: a tag v<version> pushed by bun run release:tag starts one (gh run list --workflow release.yml --branch ${ref})`);
    id = String(runs[0].databaseId);
    console.log(`${ref}: run ${id} (${runs[0].conclusion || runs[0].status}) ${runs[0].url}`);
  }
  const unpacked = await mkdtemp(path.join(tmpdir(), "koonapin-linux-"));
  if (spawnSync("gh", ["run", "download", id, "--name", ARTIFACT, "--dir", unpacked], { cwd: root, stdio: "inherit" }).status !== 0) {
    fail(`Run ${id} has no ${ARTIFACT} artifact (yet): its «packages» job makes it`);
  }
  const sums = existsSync(path.join(unpacked, "SHA256SUMS.txt")) ? await readFile(path.join(unpacked, "SHA256SUMS.txt"), "utf8") : "";
  const built = sums.match(/koonapin_(\S+)_amd64\.deb/)?.[1];
  if (!built) fail(`The ${ARTIFACT} artifact of run ${id} has no SHA256SUMS.txt naming a .deb`);
  if (/^v\d/.test(ref) && ref !== `v${built}`) fail(`The artifact of ${ref} is of ${built}`);
  if (built !== version) console.log(`The artifact is of ${built}; tauri.conf.json here says ${version}.`);
  const packages = [`koonapin_${built}_amd64.deb`, `koonapin-${built}-1.x86_64.rpm`, `koonapin-${built}-x86_64.AppImage`];
  for (const file of packages) {
    const line = sums.split("\n").find((l) => l.trimEnd().endsWith(`  ${file}`));
    if (!line || !existsSync(path.join(unpacked, file))) fail(`${file} is missing from the artifact of run ${id}`);
    const hash = createHash("sha256").update(await readFile(path.join(unpacked, file))).digest("hex");
    if (line.split(/\s+/)[0] !== hash) fail(`${file} of the artifact does not match its SHA256SUMS.txt`);
  }

  const out = publish.linux(built);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  // The update signatures come along when the run was a release (linux.yml, release: true).
  const signatures = packages.map((file) => `${file}.sig`).filter((file) => existsSync(path.join(unpacked, file)));
  for (const file of [...packages, ...signatures, "SHA256SUMS.txt"]) await copyFile(path.join(unpacked, file), path.join(out, file));
  await chmod(path.join(out, packages[2]), 0o755);
  await rm(unpacked, { recursive: true, force: true });
  for (const file of packages) console.log(`${path.relative(root, path.join(out, file))}: ${await mb(path.join(out, file))}`);
  console.log(`${signatures.length ? `with ${signatures.join(", ")}` : "no .sig (not a release run)"}\n\n${sums.trim()}`);
}

/** On macOS or Windows: each stage in the CI's image of its system, the repository mounted at /work. */
async function inDocker() {
  if (!process.env.KOONAPIN_FEEDBACK_URL) fail("KOONAPIN_FEEDBACK_URL is not set in .env: the release build does not compile without it (supabase/README.md)");
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
    fail(
      "Docker is not running (or not installed): bun run build:linux builds in the CI's Linux images. Start Docker Desktop, " +
        "or take the packages of a CI run: bun run build:linux -- --from-ci <v<version>|run id>",
    );
  }
  const images = {};
  for (const role of ["void", "debian", "fedora"]) {
    const ref = output(process.execPath, [path.join(root, "scripts", "linux", "images.mjs"), "ref", role]);
    const present = spawnSync("docker", ["image", "inspect", ref], { stdio: "ignore" }).status === 0;
    if (!present && spawnSync("docker", ["pull", "--platform", "linux/amd64", ref], { stdio: "inherit" }).status !== 0) {
      fail(`No image ${ref}: the CI builds and pushes it (the «images» job of linux.yml), or build it here with bun scripts/linux/images.mjs ensure`);
    }
    images[role] = ref;
  }
  if (process.arch === "arm64") console.log("An arm64 machine runs the amd64 images emulated: the compile stage takes a long while.");

  // Linux's node_modules, Cargo's target (where every stage keeps its working folder) and the download
  // caches in volumes of their own: the host's (macOS or Windows) are of another system and stay as they are.
  const common = { "koona-build-target": "/work/src-tauri/target" };
  const compiling = {
    ...common,
    "koona-build-node-modules": "/work/node_modules",
    "koona-build-cargo-registry": "/usr/local/cargo/registry",
    "koona-build-bun-cache": "/var/cache/koona-bun",
  };
  const settings = ["KOONAPIN_FEEDBACK_URL", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "PADDLE_ENVIRONMENT"].filter((name) => process.env[name]);
  const stage = (role, volumes, command) => {
    console.log(`\n== ${role}: ${command}`);
    // A new volume belongs to root; the stage runs as «dev» (uid 1001), as in the CI. su may reset PATH,
    // so the toolchain's folders are named again. Docker Desktop shows dev's files in the mounted
    // repository as the host user's.
    const mounts = Object.values(volumes).join(" ");
    const script =
      `mkdir -p ${mounts} && chown dev: ${mounts} && su dev -c '` +
      "export RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo BUN_INSTALL_CACHE_DIR=/var/cache/koona-bun PATH=/usr/local/cargo/bin:/usr/local/bin:$PATH; " +
      `cd /work && ${command}'`;
    run("docker", [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "-v",
      `${root}:/work`,
      ...Object.entries(volumes).flatMap(([name, at]) => ["-v", `${name}:${at}`]),
      ...settings.flatMap((name) => ["-e", name]),
      "-w",
      "/work",
      images[role],
      "sh",
      "-c",
      script,
    ]);
  };
  stage("void", compiling, "bun install --frozen-lockfile && bun scripts/build-linux-packages.mjs --stage compile");
  stage("debian", common, "bun scripts/build-linux-packages.mjs --stage deb");
  stage("fedora", common, "bun scripts/build-linux-packages.mjs --stage rpm");
  await collect();
}

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  if (!args[at + 1] || args[at + 1].startsWith("--")) fail(`${name} needs a value`);
  return args[at + 1];
};
const only = option("--stage");
const ci = option("--from-ci");
if (only && !STAGES.includes(only)) fail(`--stage ${only}: one of ${STAGES.join(", ")}`);

if (ci) await fromCi(ci);
else if (only === "collect") await collect();
else if (process.platform !== "linux") {
  if (only) fail(`--stage ${only} runs on Linux (in the CI's image of it); bun run build:linux runs every stage in Docker`);
  await inDocker();
} else if (only) await { compile, deb, rpm }[only]();
else for (const step of [compile, deb, rpm, collect]) await step();
