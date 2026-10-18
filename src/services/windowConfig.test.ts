import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A platform file replaces the whole `windows` array of tauri.conf.json (JSON merge patch), so
// each one must turn the native drop off again: with it on, Tauri takes every file dropped on the
// window and the page never sees it (macOS 2.5.0 took no `.kpin`, no bookmarks file).
describe("the window configs", () => {
  const files = readdirSync("src-tauri").filter((name) => /^tauri(\.[\w-]+)?\.conf\.json$/.test(name));
  it.each(files)("%s leaves drops to the page", (name) => {
    const windows: { dragDropEnabled?: boolean }[] | undefined = JSON.parse(readFileSync(`src-tauri/${name}`, "utf8")).app?.windows;
    for (const window of windows ?? []) expect(window.dragDropEnabled).toBe(false);
  });
});
