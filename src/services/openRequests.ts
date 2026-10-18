// Lists and import files that come from outside the window (NP-139, NP-142): a file dropped on it,
// a `.kpin` opened with the app (double-click, Open With) and a `koonapin://import?url=…` link.
// A list becomes one «open request» for the list dialog; nothing is parsed or downloaded here.
// A dropped OPML or bookmarks file opens the import dialog of its format instead.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { OpenRequest as NativeOpenRequest } from "../bindings/OpenRequest";
import { isTauri } from "./api";

/** The files the window takes: a `.kpin` list, feeds in OPML, a browser's bookmarks `.html`. */
export type FileKind = "kpin" | "opml" | "html";

/** A dropped file the window takes, read already. */
export type DroppedFile = { kind: FileKind; name: string; text: string };

/**
 * A list for the list dialog: a dropped `.kpin`, read already; or from Rust (`open_requests.rs`)
 * a `.kpin` by its checked path, or the `https` address of a list from a `koonapin://import`
 * link, not downloaded yet. OPML and bookmarks files never come here: they open their own dialog.
 */
export type OpenRequest = (DroppedFile & { kind: "kpin" }) | NativeOpenRequest;

/** A list is at most 2 MB (kpin-lists.md, «Format v1»); a bigger dropped file is not read. */
export const MAX_FILE = 2 * 1024 * 1024;

/** The kind of a file by its name; `.xml` is OPML, as the import dialog takes it. */
export function fileKindOf(name: string): FileKind | null {
  const ext = /\.([^./\\]+)$/.exec(name.trim())?.[1]?.toLowerCase();
  if (ext === "kpin") return "kpin";
  // Not every `.xml`: a feed, a sitemap or any other XML is not a subscriptions list.
  if (ext === "opml") return "opml";
  if (ext === "html" || ext === "htm") return "html";
  return null;
}

/** The kind of a file by its media type, when the name is not known (a drag over the window). */
function fileKindOfType(type: string): FileKind | null {
  const media = type.split(";")[0].trim().toLowerCase();
  if (media === "application/vnd.koona.list+json") return "kpin";
  if (media === "text/x-opml" || media === "text/x-opml+xml" || media === "application/x-opml" || media === "application/x-opml+xml") return "opml";
  if (media === "text/html") return "html";
  return null;
}

/** What a drag over the window carries, for the veil: the first file's name and kind, where known. */
export type DraggedFile = { name: string | null; kind: FileKind | null };

/**
 * A drag that carries files, with what can be known of the first one before the drop. In real
 * use WebKit, WebView2 and Chromium keep `files` empty until the drop, so the name is null and the
 * veil says the generic line; at most the item's media type may tell the kind. The name is a
 * progressive enhancement, used only where a webview does show it (a DataTransfer made by a
 * script, as in the tests).
 */
export function draggedFile(data: DataTransfer | null | undefined): DraggedFile | null {
  if (!data || !Array.from(data.types ?? []).includes("Files")) return null;
  const file = data.files?.[0];
  if (file?.name) return { name: file.name, kind: fileKindOf(file.name) ?? fileKindOfType(file.type) };
  const item = Array.from(data.items ?? []).find((entry) => entry.kind === "file");
  return { name: null, kind: item ? fileKindOfType(item.type) : null };
}

/** Why a dropped file is not taken. */
/**
 * The first element is `<opml>`, past the XML declaration, comments and white space. Walked
 * by hand: a pattern for «any number of comments» backtracks exponentially on hostile text.
 */
export function opmlRoot(content: string) {
  let rest = content.slice(0, 64 * 1024).trimStart();
  for (;;) {
    const [open, close] = rest.startsWith("<?") ? ["<?", "?>"] : rest.startsWith("<!--") ? ["<!--", "-->"] : [null, null];
    if (!open || !close) return /^<opml[\s>]/i.test(rest);
    const end = rest.indexOf(close, open.length);
    if (end < 0) return false;
    rest = rest.slice(end + close.length).trimStart();
  }
}

export type DropRefusal = "unsupported" | "tooBig";

/** The first dropped file, read here, and whether others came with it; or why not. */
export async function readDropped(
  files: FileList | readonly File[] | null | undefined,
): Promise<{ file: DroppedFile; more: boolean } | DropRefusal | null> {
  const file = files?.[0];
  if (!file) return null;
  // An `.xml` may be OPML (some readers export subscriptions so): its first element decides.
  const xml = /\.xml$/i.test(file.name.trim());
  const kind = fileKindOf(file.name);
  if (!kind && !xml) return "unsupported";
  if (file.size > MAX_FILE) return "tooBig";
  const text = await file.text();
  if (!kind) return opmlRoot(text) ? { file: { kind: "opml", name: file.name, text }, more: (files?.length ?? 0) > 1 } : "unsupported";
  return { file: { kind, name: file.name, text }, more: (files?.length ?? 0) > 1 };
}

type Listener = (request: OpenRequest | null) => void;

/**
 * One request at a time, so a page firing `koonapin://` links cannot stack dialogs: while one
 * waits or its dialog is open, in any state, a later one is refused and dropped (`push` says so,
 * and the caller tells the person). `setBusy` marks a dialog that downloads or imports, which App
 * keeps over anything else. Each kept request gets a new `id`, the dialog's key. The list dialog
 * calls `done` whenever it closes.
 */
export function createOpenRequests() {
  let current: OpenRequest | null = null;
  let busy = false;
  let id = 0;
  const listeners = new Set<Listener>();
  const tell = () => listeners.forEach((listener) => listener(current));
  return {
    /** Keeps the request unless one is pending or shown; `true` when kept. */
    push(request: OpenRequest): boolean {
      if (current) return false;
      current = request;
      id++;
      tell();
      return true;
    },
    current: () => current,
    /** The number of the current request: a new one is a new dialog. */
    id: () => id,
    busy: () => busy,
    /** The dialog downloads or imports: nothing may replace or drop its request meanwhile. */
    setBusy(value: boolean) {
      if (busy === value) return;
      busy = value;
      tell();
    },
    /** The request is handled (imported, cancelled or refused): the next one may come. */
    done() {
      busy = false;
      if (!current) return;
      current = null;
      tell();
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export const openRequests = createOpenRequests();

/**
 * Takes the request Rust keeps from the start (argv, macOS `Opened`) and every later one it
 * announces with `open-request`, first once the listener is in place, so nothing kept in between
 * is missed. A taken request is always pushed, even after the caller stopped (React's StrictMode
 * runs an effect twice): the queue outlives it. `onBusy`: refused, another one is open. In the
 * browser demo there are none.
 */
export function receiveNativeOpens(onBusy: () => void, queue = openRequests): () => void {
  if (!isTauri()) return () => {};
  const take = () =>
    void invoke<NativeOpenRequest | null>("take_pending_opens")
      .then((request) => {
        if (request && !queue.push(request)) onBusy();
      })
      .catch(console.error);
  const unlisten = listen("open-request", take);
  void unlisten.then(take, console.error);
  return () => void unlisten.then((stop) => stop()).catch(console.error);
}
