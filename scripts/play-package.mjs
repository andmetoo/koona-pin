// Gathers what the Google Play listing uploads for this version into one folder beside its App Bundles:
// release/publish/android/<version>/store/ (scripts/lib/paths.mjs). The sources stay where they are kept
// (src-tauri/store/play/README.md says which is which); this folder is only the upload's copy.
//
//   bun run play:package           copy the screenshots, icon and feature graphic, and the rendered film
//   bun run play:package -- --render   render the film first (src-tauri/store/play/video/film), then copy
//
// The film needs its clips in video/film/public/clips (video/scenario.md); without a rendered film the
// folder gets the pictures only and the script says so.
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { publish, root } from "./lib/paths.mjs";

const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const play = path.join(root, "src-tauri", "store", "play");
const film = path.join(play, "video", "film");
const rendered = path.join(film, "out", "koona-pin-play-preview.mp4");
const out = publish.play(version);

if (process.argv.includes("--render")) {
  execFileSync("bunx", ["remotion", "render", "PlayPreview", rendered, "--codec=h264", "--crf=18", "--log=error"], {
    cwd: film,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

await mkdir(path.join(out, "screenshots"), { recursive: true });
const pictures = path.join(play, "en-US");
const copied = [];
for (const name of await readdir(pictures)) {
  if (!name.endsWith(".png")) continue;
  const target = name.startsWith("phone-") ? path.join(out, "screenshots", name) : path.join(out, name);
  await copyFile(path.join(pictures, name), target);
  copied.push(path.relative(out, target));
}
/** The newest change among what the film is made of: its clips, its code and stills, the app's version. */
async function newestSource() {
  const files = [path.join(root, "package.json")];
  for (const dir of ["src", "public", path.join("public", "clips")])
    for (const name of await readdir(path.join(film, dir)).catch(() => [])) files.push(path.join(film, dir, name));
  const times = await Promise.all(files.map((file) => stat(file).then((s) => (s.isFile() ? s.mtimeMs : 0), () => 0)));
  return Math.max(...times);
}
// A film older than its sources (new clips, a changed scene, a new version) would go up as this
// version's: it is left out, and the script says how to render it.
const filmFile = await stat(rendered).catch(() => null);
const filmOut = path.join(out, `koona-pin-${version}-play-preview.mp4`);
if (filmFile && filmFile.mtimeMs >= (await newestSource())) {
  await copyFile(rendered, filmOut);
  copied.push(path.basename(filmOut));
} else {
  // An earlier copy here is as stale as the film it came from.
  await rm(filmOut, { force: true });
  console.log(
    filmFile
      ? "The rendered film is older than its clips, its scenes or this version: not copied. bun run play:package -- --render"
      : "No rendered film: bun run play:package -- --render (needs the clips, video/scenario.md)",
  );
}
console.log(`${out}\n  ${copied.join("\n  ")}`);
