// One way in for a file to import (share-bundle.md, «"Import a file…" and the sniffer»): a file
// dropped on the window and one picked with «Import a file…» in the ⋯ menu are read here and told
// apart by what they hold, never by their name alone. The caller routes the kind to its dialog;
// nothing is imported here.
import { invoke } from "@tauri-apps/api/core";
import type { PickedImport } from "../bindings/PickedImport";
import type { PickedImportText } from "../bindings/PickedImportText";
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

/**
 * How much of a file is read before its kind is known (Rust `IMPORT_HEAD`): the rest is read only
 * once the kind and that kind's cap allow it.
 */
export const HEAD = 64 * 1024;

/** What a scan for the top-level `format` says so far: its string; `null`, none; `undefined`, not yet. */
export type FormatScan = string | null | undefined;

/** A key or a `format` value longer than this is not one of ours (an escaped `format` is 38). */
const TOKEN_MAX = 256;

/**
 * A scanner for the top-level `format` of a JSON object, fed its text in pieces (a full copy may
 * weigh 256 MB): its string value; `null` when the object has none, or not a string; or
 * `undefined` while the text fed so far does not tell. Only the shape is followed and nested
 * values are skipped, its state kept across pieces: Rust validates the whole file afterwards
 * (format.rs, restore.rs), so a broken tail is refused there. A BOM and white space before the
 * object are passed over.
 */
export function formatScanner() {
  let depth = 0;
  let keyNext = false;
  let inString = false;
  let escaped = false;
  /** The raw text of the key or `format` value being read; null for a string that is skipped. */
  let token: string | null = null;
  let tokenIsValue = false;
  /** After a top-level key: its colon, then (for `format`) its value. */
  let expect: "none" | "colon" | "value" = "none";
  let isFormat = false;
  let done: FormatScan = undefined;
  const parsed = (raw: string) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  };
  return (piece: string): FormatScan => {
    if (done !== undefined) return done;
    for (let i = 0; i < piece.length; i++) {
      const c = piece[i];
      if (inString) {
        if (token !== null && token.length <= TOKEN_MAX) token += c;
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') {
          inString = false;
          if (token === null) continue;
          const long = token.length > TOKEN_MAX;
          const value = long ? undefined : parsed(token);
          token = null;
          if (tokenIsValue) return (done = typeof value === "string" ? value : null);
          // A broken key is no JSON; one too long to be `format` is some other key.
          if (!long && value === undefined) return (done = null);
          isFormat = value === "format";
          expect = "colon";
        }
        continue;
      }
      if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
      if (expect === "colon") {
        if (c !== ":") return (done = null);
        expect = isFormat ? "value" : "none";
        continue;
      }
      if (expect === "value") {
        if (c !== '"') return (done = null);
        expect = "none";
        inString = true;
        token = c;
        tokenIsValue = true;
        continue;
      }
      if (c === '"') {
        inString = true;
        if (depth === 1 && keyNext) {
          keyNext = false;
          token = c;
          tokenIsValue = false;
        }
      } else if (c === "{" || c === "[") {
        depth++;
        if (depth === 1 && c === "[") return (done = null);
        if (depth === 1) keyNext = true;
      } else if (c === "}" || c === "]") {
        depth--;
        // The object closed with no `format`.
        if (depth <= 0) return (done = null);
      } else if (c === "," && depth === 1) keyNext = true;
    }
    return undefined;
  };
}

/** The top-level `format` of a JSON object, read from its first `limit` characters (`formatScanner`). */
export function topLevelFormat(json: string, limit = HEAD): FormatScan {
  return formatScanner()(json.length > limit ? json.slice(0, limit) : json);
}

/**
 * A browser's bookmarks (the Netscape format): its DOCTYPE; or, as some exports drop it, a `<dl>`
 * with what only such a file has — a `<DT><H3` folder, or a `<DT><A` with both HREF and ADD_DATE.
 * A page that merely has a `<dl>`, such as a saved article with a glossary, is not.
 */
function bookmarksHead(head: string) {
  if (/<!DOCTYPE\s+NETSCAPE-Bookmark-file-1\s*>/i.test(head)) return true;
  if (!/<dl[\s>]/i.test(head)) return false;
  return /<dt>\s*<h3[\s>]/i.test(head) || /<dt>\s*<a\s(?=[^>]*\bhref\s*=)(?=[^>]*\badd_date\s*=)/i.test(head);
}

/**
 * The kind of a file by its head (its first `HEAD` bytes, or all of a smaller file):
 * 1. JSON (past a BOM and white space, `{` first): a list or a full copy by its top-level `format`;
 *    any other JSON is none of ours. `undefined` when the head does not reach the `format`.
 * 2. An `<opml>` root.
 * 3. A Netscape bookmarks file (`bookmarksHead`).
 */
export function sniffHead(head: string): ImportKind | null | undefined {
  const start = head.replace(/^\uFEFF/, "").trimStart();
  if (start.startsWith("{")) {
    const format = topLevelFormat(start);
    return format === undefined ? undefined : byFormat(format);
  }
  if (opmlRoot(start)) return "opml";
  return bookmarksHead(start.slice(0, HEAD)) ? "bookmarks" : null;
}

const byFormat = (format: string | null): ImportKind | null =>
  format === LIST_FORMAT ? "kpin" : format === COPY_FORMAT ? "backup" : null;

/**
 * The kind of a whole file by its text: by its head (`sniffHead`), and for a JSON whose `format`
 * is past the head (keys sorted by a tool, or written by hand) by the same scan over all of it,
 * still without parsing it. Caps are the caller's (`known`).
 */
export function sniff(text: string): ImportKind | null {
  const kind = sniffHead(text);
  if (kind !== undefined) return kind;
  return byFormat(topLevelFormat(text.replace(/^\uFEFF/, "").trimStart(), Infinity) ?? null);
}

/** A file read and known. */
export type ImportFile = { kind: ImportKind; name: string; text: string };

/** Why a file is not taken: none of ours, or over the cap (in bytes) of its kind or of all. */
export type ImportRefusal = { refused: "unsupported" } | { refused: "tooBig"; cap: number };

export const isRefusal = (read: ImportFile | ImportRefusal): read is ImportRefusal => "refused" in read;

/**
 * The top-level `format` of a JSON file whose head does not reach it, by a scan of all of it under
 * `cap` (`null` past it), with the whole text when it had to be read for the scan.
 */
export type LateFormat = (cap: number) => Promise<{ format: string | null; text?: string } | null>;

/** A file is scanned in pieces of this size (`late` of `readFile`). */
const SCAN_PIECE = 4 * 1024 * 1024;

/**
 * `LateFormat` from one whole read: the text, read under the cap, is scanned once and kept, so it is
 * neither read nor scanned whole again.
 */
const scanWhole =
  (whole: (cap: number) => Promise<string | null>): LateFormat =>
  async (cap) => {
    const text = await whole(cap);
    return text === null ? null : { format: topLevelFormat(text, Infinity) ?? null, text };
  };

/**
 * The one place of the sniff and cap rules. A file of `bytes` known by its `head`, then read
 * whole by `whole` (up to a cap; `null` past it) only once its kind is known and under that
 * kind's cap; a head of the whole file is not read again. A JSON whose `format` is past the head
 * is scanned whole by `late` under the largest cap (a full copy's), then held to the cap of the
 * kind found. The whole text must have a head of the same kind (or, scanned late, one that still
 * does not tell): a file changed in between is refused. The whole text is scanned at most once.
 * Exported for tests.
 */
export async function known(
  name: string,
  bytes: number,
  head: string,
  whole: (cap: number) => Promise<string | null>,
  late: LateFormat = scanWhole(whole),
): Promise<ImportFile | ImportRefusal> {
  let kind = sniffHead(head);
  /** The kind came from a scan of the whole file: its head does not tell. */
  const scanned = kind === undefined && bytes > HEAD;
  let text: string | null = null;
  if (kind === undefined) {
    if (bytes > CAPS.backup) return { refused: "tooBig", cap: CAPS.backup };
    if (bytes <= HEAD) {
      // The head is all of it and was scanned whole: a JSON cut short, none of ours.
      text = head;
      kind = null;
    } else {
      const found = await late(CAPS.backup);
      if (found === null) return { refused: "tooBig", cap: CAPS.backup };
      kind = byFormat(found.format);
      text = found.text ?? null;
    }
  }
  if (!kind) return { refused: "unsupported" };
  if (bytes > CAPS[kind]) return { refused: "tooBig", cap: CAPS[kind] };
  if (text === null) {
    text = bytes <= HEAD ? head : await whole(CAPS[kind]);
    if (text === null) return { refused: "tooBig", cap: CAPS[kind] };
    // A file changed in between has another head; only the head is checked again, as a scan of
    // the whole text would be the second one. After a scan in pieces (`late` of `readFile`), a
    // `format` past the head that changed before this read is not caught here but by Rust, which
    // validates the whole text (format.rs, restore.rs).
    if (text !== head) {
      const again = sniffHead(text);
      if (again !== kind && !(scanned && again === undefined)) return { refused: "unsupported" };
    }
  }
  return { kind, name, text };
}

/**
 * One file: its head first, the rest only once its kind and that kind's cap allow it. A JSON
 * whose `format` is past its head is scanned in pieces, so one that is none of ours is never held
 * whole. A piece may cut a character of several bytes in two; the scan follows only ASCII (quotes,
 * brackets, `format` and our values), so that does not change what it finds.
 */
export async function readFile(file: File): Promise<ImportFile | ImportRefusal> {
  if (file.size > LARGEST) return { refused: "tooBig", cap: LARGEST };
  const head = await file.slice(0, HEAD).text();
  const late: LateFormat = async (cap) => {
    if (file.size > cap) return null;
    const scan = formatScanner();
    for (let at = 0; at < file.size; at += SCAN_PIECE) {
      const format = scan(await file.slice(at, at + SCAN_PIECE).text());
      if (format !== undefined) return { format };
    }
    return { format: null };
  };
  return known(file.name, file.size, head, () => file.text(), late);
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
 * «Import a file…»: the system Open dialog (Rust `pick_import_file`, which gives the file's head),
 * then the file known as a drop is; Rust `read_picked_import` reads the rest under its kind's cap.
 * In the browser preview a file input stands for the dialog. `null`: cancelled.
 */
export async function pick(): Promise<ImportFile | ImportRefusal | null> {
  if (isTauri()) {
    const picked = await invoke<PickedImport>("pick_import_file").catch((error: unknown) => {
      throw toCommandError(error);
    });
    if (picked.outcome === "cancelled") return null;
    if (picked.outcome === "too_big") return { refused: "tooBig", cap: LARGEST };
    // The read empties Rust's slot; a file refused by its head, or whole in it, is forgotten.
    // Rust reads a picked file once and whole, not in pieces: a JSON whose `format` is past its
    // head (never one Koona Pin writes) is read under the largest cap and scanned here, and its
    // text kept (`known`'s default `late`).
    let read = false;
    const result = await known(picked.name, picked.bytes, picked.head, async (cap) => {
      read = true;
      const text = await invoke<PickedImportText>("read_picked_import", { cap }).catch((error: unknown) => {
        throw toCommandError(error);
      });
      return text.outcome === "read" ? text.text : null;
    });
    if (!read) await invoke("forget_picked_import").catch(() => undefined);
    return result;
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

export const importFile = { sniff, sniffHead, readFile, readDropped, pick };
