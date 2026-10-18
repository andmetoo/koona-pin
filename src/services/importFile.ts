// One way in for a file to import (share-bundle.md, «"Import a file…" and the sniffer»): a file
// dropped on the window and one picked with «Import a file…» in the ⋯ menu are read here and told
// apart by what they hold, never by their name alone. The caller routes the kind to its dialog;
// nothing is imported here.
import { invoke } from "@tauri-apps/api/core";
import type { PickedImport } from "../bindings/PickedImport";
import { isTauri } from "./api";
import { toCommandError } from "./errors";
import { MAX_FILE, opmlRoot } from "./openRequests";

/** What a file is: a `.kpin` list, a full copy (JSON backup), feeds in OPML, a browser's bookmarks. */
export type ImportKind = "kpin" | "backup" | "opml" | "bookmarks";

const MB = 1024 * 1024;

/** The most each kind may weigh: a list as its format says (2 MB), the others new caps of 2.5. */
export const CAPS: Record<ImportKind, number> = { kpin: MAX_FILE, opml: 8 * MB, bookmarks: 64 * MB, backup: 256 * MB };

/** A file bigger than this is not read at all: no kind may weigh more. */
export const LARGEST = Math.max(...Object.values(CAPS));

/** `format` of a `.kpin` list and of a full copy (`export::JSON_FORMAT`). */
const LIST_FORMAT = "koona";
const COPY_FORMAT = "koona-pin";

/** How much of a JSON file is scanned for its top-level `format`. */
const HEAD = 64 * 1024;

/** Past the closing quote of the JSON string that opens at `from`; -1 when it does not close in `text`. */
function stringEnd(text: string, from: number) {
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i + 1;
  }
  return -1;
}

/** The first index from `at` that is not JSON white space. */
const skipSpace = (text: string, at: number) => {
  while (at < text.length && " \t\n\r".includes(text[at])) at++;
  return at;
};

/**
 * The top-level `format` of a JSON object, read from its head without parsing the rest (a full
 * copy may weigh 256 MB): its string value; `null` when the object has none, or not a string; or
 * `undefined` when the head does not tell. Only the shape is followed and nested values are
 * skipped: Rust validates the whole file afterwards (format.rs, restore.rs), so a broken tail is
 * refused there.
 */
export function topLevelFormat(json: string): string | null | undefined {
  const text = json.slice(0, HEAD);
  let depth = 0;
  let keyNext = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = stringEnd(text, i);
      if (end < 0) return undefined;
      if (depth !== 1 || !keyNext) {
        i = end - 1;
        continue;
      }
      keyNext = false;
      let key: unknown;
      try {
        key = JSON.parse(text.slice(i, end));
      } catch {
        return null;
      }
      let at = skipSpace(text, end);
      if (at >= text.length) return undefined;
      if (text[at] !== ":") return null;
      at = skipSpace(text, at + 1);
      if (key === "format") {
        if (at >= text.length) return undefined;
        if (text[at] !== '"') return null;
        const close = stringEnd(text, at);
        if (close < 0) return undefined;
        try {
          return JSON.parse(text.slice(at, close)) as string;
        } catch {
          return null;
        }
      }
      i = at - 1;
    } else if (c === "{" || c === "[") {
      depth++;
      if (depth === 1 && c === "[") return null;
      if (depth === 1) keyNext = true;
    } else if (c === "}" || c === "]") {
      depth--;
      // The object closed with no `format`.
      if (depth <= 0) return null;
    } else if (c === "," && depth === 1) keyNext = true;
  }
  return undefined;
}

/**
 * The kind of a file by its text:
 * 1. JSON (past a BOM and white space, `{` first): a list or a full copy by its top-level `format`;
 *    any other JSON is none of ours.
 * 2. An `<opml>` root.
 * 3. A Netscape bookmarks file: its DOCTYPE or a `<dl>` in the first 64 KB.
 */
export function sniff(text: string): ImportKind | null {
  const start = text.replace(/^\uFEFF/, "").trimStart();
  if (start.startsWith("{")) {
    let format = topLevelFormat(start);
    // A `format` past the head (written by hand, not by Koona Pin): a file of a list's size is parsed whole.
    if (format === undefined && start.length <= CAPS.kpin) {
      try {
        const value = (JSON.parse(start) as { format?: unknown } | null)?.format;
        format = typeof value === "string" ? value : null;
      } catch {
        format = null;
      }
    }
    return format === LIST_FORMAT ? "kpin" : format === COPY_FORMAT ? "backup" : null;
  }
  if (opmlRoot(start)) return "opml";
  const head = start.slice(0, 64 * 1024);
  if (/<!DOCTYPE\s+NETSCAPE-Bookmark-file-1\s*>/i.test(head) || /<dl[\s>]/i.test(head)) return "bookmarks";
  return null;
}

/** A file read and known. */
export type ImportFile = { kind: ImportKind; name: string; text: string };

/** Why a file is not taken: none of ours, or over the cap (in bytes) of its kind or of all. */
export type ImportRefusal = { refused: "unsupported" } | { refused: "tooBig"; cap: number };

export const isRefusal = (read: ImportFile | ImportRefusal): read is ImportRefusal => "refused" in read;

/** The text of a file of `bytes`, known or refused: its kind, then the cap of that kind. */
export function classify(name: string, bytes: number, text: string): ImportFile | ImportRefusal {
  const kind = sniff(text);
  if (!kind) return { refused: "unsupported" };
  if (bytes > CAPS[kind]) return { refused: "tooBig", cap: CAPS[kind] };
  return { kind, name, text };
}

/** One file, read unless it is over the largest cap. */
export async function readFile(file: File): Promise<ImportFile | ImportRefusal> {
  if (file.size > LARGEST) return { refused: "tooBig", cap: LARGEST };
  return classify(file.name, file.size, await file.text());
}

/** The first dropped file, read and known, and whether others came with it; or why not. */
export async function readDropped(
  files: FileList | readonly File[] | null | undefined,
): Promise<(ImportFile & { more: boolean }) | ImportRefusal | null> {
  const file = files?.[0];
  if (!file) return null;
  const read = await readFile(file);
  return isRefusal(read) ? read : { ...read, more: (files?.length ?? 0) > 1 };
}

/**
 * «Import a file…»: the system Open dialog (Rust `pick_import_file`, which reads up to the largest
 * cap), then the file known as a drop is. In the browser preview a file input stands for the
 * dialog. `null`: cancelled.
 */
export async function pick(): Promise<ImportFile | ImportRefusal | null> {
  if (isTauri()) {
    const picked = await invoke<PickedImport>("pick_import_file").catch((error: unknown) => {
      throw toCommandError(error);
    });
    if (picked.outcome === "cancelled") return null;
    if (picked.outcome === "too_big") return { refused: "tooBig", cap: LARGEST };
    return classify(picked.name, picked.bytes, picked.text);
  }
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
  return file ? readFile(file) : null;
}

export const importFile = { sniff, classify, readFile, readDropped, pick };
