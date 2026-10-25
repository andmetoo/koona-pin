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

// Tauri writes the `.kpin` type into Info.plist from bundle.fileAssociations but names no icon, and
// Finder showed a blank page on a list (2.18.1). src-tauri/macos/Info.plist replaces both keys whole
// with the icon added, so it must say what tauri.conf.json says, and the icon must be bundled.
describe("the macOS document type", () => {
  const read = (name: string) => readFileSync(`src-tauri/${name}`, "utf8");
  const [association] = JSON.parse(read("tauri.conf.json")).bundle.fileAssociations;
  const macos = JSON.parse(read("tauri.macos.conf.json")).bundle;
  const plist = read(macos.macOS.infoPlist);
  /** The strings of the plist under `key`: the string itself, or those of its array. */
  const strings = (key: string, from = plist) => {
    const after = from.slice(from.indexOf(`<key>${key}</key>`) + key.length + 11).trimStart();
    const value = after.startsWith("<array>") ? after.slice(0, after.indexOf("</array>")) : after.slice(0, after.indexOf("</string>") + 9);
    return [...value.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  };
  const exported = plist.slice(plist.indexOf("<key>UTExportedTypeDeclarations</key>"));
  const documents = plist.slice(0, plist.indexOf("<key>UTExportedTypeDeclarations</key>"));

  it("declares the type of tauri.conf.json, with the bundled icon", () => {
    expect(strings("CFBundleTypeExtensions", documents)).toEqual(association.ext);
    expect(strings("CFBundleTypeName", documents)).toEqual([association.name]);
    expect(strings("CFBundleTypeRole", documents)).toEqual([association.role]);
    expect(strings("LSHandlerRank", documents)).toEqual([association.rank]);
    expect(strings("LSItemContentTypes", documents)).toEqual([association.exportedType.identifier]);
    expect(strings("UTTypeIdentifier", exported)).toEqual([association.exportedType.identifier]);
    expect(strings("UTTypeConformsTo", exported)).toEqual(association.exportedType.conformsTo);
    expect(strings("public.filename-extension", exported)).toEqual(association.ext);
    expect(strings("public.mime-type", exported)).toEqual([association.mimeType]);
    expect(strings("CFBundleTypeIconFile", documents)).toEqual(["kpin.icns"]);
    expect(strings("UTTypeIconFile", exported)).toEqual(["kpin.icns"]);
    expect(Object.entries(macos.resources)).toContainEqual(["macos/kpin.icns", "kpin.icns"]);
    expect(readFileSync("src-tauri/macos/kpin.icns").subarray(0, 4).toString()).toBe("icns");
  });
});
