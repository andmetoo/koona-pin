// The prebuilt CI images of .github/workflows/linux.yml (plan A1): toolchains, Bun and system packages are in
// the image, so a job installs nothing. One Dockerfile per role in scripts/linux/images/, built with the
// repository root as its context; the tag is a hash of the Dockerfile and every file it COPYs, so an image is
// rebuilt exactly when what goes into it changes (a rolling base moves with the date in its FROM line).
//
//   bun scripts/linux/images.mjs ref <role>                         the image's full reference
//   bun scripts/linux/images.mjs ensure [--push] [--check] [--github-output] [role...]
//       for each role (all by default): present in the registry → skipped; else built (linux/amd64) and with
//       --push pushed. --check builds nothing and fails on a missing image (a fork's pull request cannot
//       push). --github-output writes <role>=<ref> lines to $GITHUB_OUTPUT.
//
// Registry: KOONAPIN_CI_REGISTRY, ghcr.io/andmetoo by default → <registry>/koona-ci-<role>:<tag>.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
export const ROLES = ["void", "debian", "ubuntu", "fedora", "arch", "ui"];
const registry = () => (process.env.KOONAPIN_CI_REGISTRY || "ghcr.io/andmetoo").replace(/\/+$/, "").toLowerCase();
const dockerfile = (role) => path.join("scripts", "linux", "images", `${role}.Dockerfile`);

/** Repository paths (POSIX) the Dockerfile COPYs, directories expanded, sorted. */
function inputs(role) {
  const text = readFileSync(path.join(root, dockerfile(role)), "utf8").replace(/\\\r?\n/g, " ");
  const files = new Set();
  const add = (rel) => {
    const full = path.join(root, rel);
    if (!existsSync(full)) throw new Error(`${dockerfile(role)}: COPY ${rel}: no such file`);
    if (statSync(full).isDirectory()) for (const entry of readdirSync(full)) add(path.posix.join(rel, entry));
    else files.add(rel.split(path.sep).join("/"));
  };
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(COPY|ADD)\s+(.*)$/i.exec(line);
    if (!match) continue;
    if (/^ADD$/i.test(match[1])) throw new Error(`${dockerfile(role)}: ADD is not hashed, use COPY`);
    const words = match[2].trim().split(/\s+/).filter((word) => !word.startsWith("--"));
    if (words[0]?.startsWith("[") || words.some((word) => /[*?[]/.test(word)))
      throw new Error(`${dockerfile(role)}: COPY with JSON form or wildcards is not hashed: ${line.trim()}`);
    for (const source of words.slice(0, -1)) add(source.replace(/^\.\//, "").replace(/\/+$/, ""));
  }
  return [...files].sort();
}

/** LF line ends, so a Windows checkout hashes and builds the same image as Linux and macOS. */
function content(rel) {
  const data = readFileSync(path.join(root, rel));
  return data.includes(0) ? data : Buffer.from(data.toString("utf8").replace(/\r\n/g, "\n"));
}

/** The Playwright of bun.lock must be the one an image hard-codes (the ui image's FROM, PLAYWRIGHT_VERSION). */
function checkPlaywright(role) {
  const text = readFileSync(path.join(root, dockerfile(role)), "utf8");
  const pinned = [...text.matchAll(/playwright:v([0-9][0-9.]*)-|PLAYWRIGHT_VERSION=([0-9][0-9.]*)/g)].map((m) => m[1] || m[2]);
  if (!pinned.length) return;
  const locked = /"playwright": \["playwright@([0-9.]+)"/.exec(readFileSync(path.join(root, "bun.lock"), "utf8"))?.[1];
  for (const version of pinned)
    if (version !== locked)
      throw new Error(`${dockerfile(role)} pins Playwright ${version}, bun.lock has ${locked}: update the Dockerfile`);
}

export function tag(role) {
  if (!ROLES.includes(role)) throw new Error(`Unknown image role «${role}»: ${ROLES.join(", ")}`);
  checkPlaywright(role);
  const hash = createHash("sha256");
  for (const rel of [dockerfile(role).split(path.sep).join("/"), ...inputs(role)].sort()) {
    hash.update(`${rel}\0`);
    hash.update(content(rel));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

export const ref = (role) => `${registry()}/koona-ci-${role}:${tag(role)}`;

function docker(args, options = {}) {
  const result = spawnSync("docker", args, { stdio: "inherit", ...options });
  if (result.error) throw new Error(`docker: ${result.error.message}`);
  return result.status === 0;
}
const present = (image) => docker(["manifest", "inspect", image], { stdio: "ignore" });

/** The build context: only the files the Dockerfile COPYs, LF-normalised — what the tag is made of. */
function build(role, image) {
  const context = mkdtempSync(path.join(tmpdir(), `koona-ci-${role}-`));
  try {
    for (const rel of inputs(role)) {
      mkdirSync(path.join(context, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(context, rel), content(rel));
    }
    const file = path.join(context, "Dockerfile");
    cpSync(path.join(root, dockerfile(role)), file);
    const source = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
      : "https://github.com/andmetoo/koona-pin";
    // The source label links a new GHCR package to the repository, so the workflow's token may push to it.
    if (!docker(["build", "--platform", "linux/amd64", "--pull", "--label", `org.opencontainers.image.source=${source}`, "-f", file, "-t", image, context]))
      throw new Error(`docker build of ${image} failed`);
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

function ensure(flags, roles) {
  const missing = [];
  for (const role of roles) {
    const image = ref(role);
    if (present(image)) {
      console.log(`ok: ${image} is in the registry`);
    } else if (flags.has("--check")) {
      console.error(`missing: ${image}`);
      missing.push(image);
    } else {
      console.log(`\n== ${role}: building ${image}`);
      build(role, image);
      if (flags.has("--push") && !docker(["push", image])) throw new Error(`docker push of ${image} failed`);
    }
    if (flags.has("--github-output")) {
      if (!process.env.GITHUB_OUTPUT) throw new Error("--github-output: GITHUB_OUTPUT is not set");
      appendFileSync(process.env.GITHUB_OUTPUT, `${role}=${image}\n`);
    }
  }
  if (missing.length) {
    console.error(
      `\n${missing.length} CI image(s) missing. A pull request from a fork cannot push images: a maintainer's ` +
        "run (push to main, or the Linux workflow on a branch of this repository) builds them first.",
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((word) => word.startsWith("--")));
  const names = rest.filter((word) => !word.startsWith("--"));
  try {
    if (command === "ref" && names.length === 1) console.log(ref(names[0]));
    else if (command === "tag" && names.length === 1) console.log(tag(names[0]));
    else if (command === "ensure") {
      for (const flag of flags)
        if (!["--push", "--check", "--github-output"].includes(flag)) throw new Error(`Unknown flag ${flag}`);
      for (const role of names) if (!ROLES.includes(role)) throw new Error(`Unknown image role «${role}»: ${ROLES.join(", ")}`);
      ensure(flags, names.length ? names : ROLES);
    } else {
      console.error("usage: bun scripts/linux/images.mjs ref <role> | ensure [--push] [--check] [--github-output] [role...]");
      process.exit(2);
    }
  } catch (error) {
    console.error(`images.mjs: ${error.message}`);
    process.exit(1);
  }
}
