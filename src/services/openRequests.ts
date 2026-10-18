// Lists and import files that come from outside the window (NP-139, NP-142): a file dropped on it,
// a `.kpin` opened with the app (double-click, Open With) and a `koonapin://import?url=…` link.
// Every one becomes one «open request»; nothing is parsed or downloaded here. The import dialog
// takes the request and asks the person first.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { OpenRequest as NativeOpenRequest } from "../bindings/OpenRequest";
import { isTauri } from "./api";

/** The files the window takes: a `.kpin` list, feeds in OPML, a browser's bookmarks `.html`. */
export type FileKind = "kpin" | "opml" | "html";

/**
 * A dropped file, read already; or from Rust (`open_requests.rs`) a `.kpin` by its checked path,
 * or the `https` address of a list from a `koonapin://import` link, not downloaded yet.
 */
export type OpenRequest = { kind: FileKind; name: string; text: string } | NativeOpenRequest;

/** A list is at most 2 MB (kpin-lists.md, «Format v1»); a bigger dropped file is not read. */
export const MAX_FILE = 2 * 1024 * 1024;

/** The kind of a file by its name; `.xml` is OPML, as the import dialog takes it. */
export function fileKindOf(name: string): FileKind | null {
  const ext = /\.([^./\\]+)$/.exec(name.trim())?.[1]?.toLowerCase();
  if (ext === "kpin") return "kpin";
  if (ext === "opml" || ext === "xml") return "opml";
  if (ext === "html" || ext === "htm") return "html";
  return null;
}

/** The kind of a file by its media type, when the name is not known yet (a drag over the window). */
function fileKindOfType(type: string): FileKind | null {
  const media = type.split(";")[0].trim().toLowerCase();
  if (media === "application/vnd.koona.list+json") return "kpin";
  if (media === "text/x-opml" || media === "text/x-opml+xml" || media === "application/x-opml" || media === "application/x-opml+xml") return "opml";
  if (media === "text/html") return "html";
  return null;
}

/** What a drag over the window carries, for the veil: files or not, and the first one's name and kind. */
export type DraggedFile = { name: string | null; kind: FileKind | null };

/**
 * A drag that carries files, with what can be known of the first one before the drop. Browsers
 * and WebKit hide the file's name until the drop; its media type is often known (the system's
 * own types: `text/html`, and `.kpin` once the app has registered it).
 */
export function draggedFile(data: DataTransfer | null | undefined): DraggedFile | null {
  if (!data || !Array.from(data.types ?? []).includes("Files")) return null;
  const file = data.files?.[0];
  if (file?.name) return { name: file.name, kind: fileKindOf(file.name) ?? fileKindOfType(file.type) };
  const item = Array.from(data.items ?? []).find((entry) => entry.kind === "file");
  return { name: null, kind: item ? fileKindOfType(item.type) : null };
}

/** Why a dropped file is not taken. */
export type DropRefusal = "unsupported" | "tooBig";

/** The first dropped file as a request, read here; or why not. */
export async function droppedRequest(files: FileList | readonly File[] | null | undefined): Promise<OpenRequest | DropRefusal | null> {
  const file = files?.[0];
  if (!file) return null;
  const kind = fileKindOf(file.name);
  if (!kind) return "unsupported";
  if (file.size > MAX_FILE) return "tooBig";
  return { kind, name: file.name, text: await file.text() };
}

type Listener = (request: OpenRequest | null) => void;

/**
 * One request at a time: while one waits or its dialog is open, later ones are dropped, so a page
 * firing `koonapin://` links cannot stack dialogs. The dialog calls `done` when it closes.
 */
export function createOpenRequests() {
  let current: OpenRequest | null = null;
  const listeners = new Set<Listener>();
  const tell = () => listeners.forEach((listener) => listener(current));
  return {
    /** Keeps the request unless one is pending; `true` when kept. */
    push(request: OpenRequest): boolean {
      if (current) return false;
      current = request;
      tell();
      return true;
    },
    current: () => current,
    /** The request is handled (imported, cancelled or refused): the next one may come. */
    done() {
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
 * announces with `open-request`. In the browser demo there are none.
 */
export function receiveNativeOpens(queue = openRequests): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  const take = () =>
    void invoke<NativeOpenRequest | null>("take_pending_opens")
      .then((request) => {
        if (request && !disposed) queue.push(request);
      })
      .catch(console.error);
  const unlisten = listen("open-request", take);
  take();
  return () => {
    disposed = true;
    void unlisten.then((stop) => stop()).catch(console.error);
  };
}
