import { MutableRefObject, useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import type { NewLink } from "../components/library/AddSheet";
import { DropArea, DropZoneState, dropZoneText } from "../components/shell/DropZone";
import { api, desktopApi } from "../services/api";
import { carriesLink, destinationOf, linkFrom } from "../services/addLink";
import { describeError } from "../services/errors";
import { exportOpml, onFollowFailed } from "../services/feeds";
import { draggedFile, openRequests, receiveNativeOpens } from "../services/openRequests";
import { ImportFile, ImportRefusal, importFile, isRefusal } from "../services/importFile";
import { capabilities } from "../platform/capabilities";
import type { CsvColumns, ExportFormat } from "../types";
import type { Editing } from "./editing";
import type { LibraryView } from "./library";
import type { Navigation } from "./navigation";
import type { Notices } from "./notices";
import { IMPORT_SURFACES, type Surfaces } from "./surfaces";

/** Columns of the CSV, titled in the interface's language (NP-032). */
const CSV_COLUMNS = ["title", "url", "domain", "collection", "tags", "notes", "favorite", "inbox", "saved"] as const;

/** A drag from outside over the list area: where the zone lies, Shift for a link, or a file to import (K9). */
type FileZone = DropZoneState & { link?: false };
export type Veil = { inbox: boolean; file?: FileZone; area: DropArea } | null;

const sameVeil = (a: Veil, b: Veil) =>
  a === b ||
  (!!a && !!b && a.inbox === b.inbox && a.file === b.file && (["top", "left", "width", "height"] as const).every((k) => a.area[k] === b.area[k]));

/**
 * What comes into the library and goes out of it: a link saved by hand, pasted or dropped
 * (2026-10-16), a file dropped on the list area or picked (NP-139, K9), a list the system opened with the app
 * (NP-142), and the exports and the copy of Settings (NP-032, NP-034, NP-132).
 */
export function useImportExport(
  t: TFunction,
  { say, sayRef, setNotice, setAnnouncement }: Pick<Notices, "say" | "sayRef" | "setNotice" | "setAnnouncement">,
  { setEditing, editingRef, editorFocus }: Pick<Editing, "setEditing" | "editingRef" | "editorFocus">,
  { filters, scrollRef, pageRef, triageRef }: Pick<Navigation, "filters" | "scrollRef" | "pageRef" | "triageRef">,
  { surfaceNow, setSurface, setDroppedFile }: Pick<Surfaces, "surfaceNow" | "setSurface" | "setDroppedFile">,
  { library }: Pick<LibraryView, "library">,
  readingRef: MutableRefObject<unknown>,
) {
  /** A link just saved by hand (2026-10-16): its card lands first with a spring. */
  const [fresh, setFresh] = useState<number | null>(null);
  /** A link or a file dragged over the list area: the drop zone (K9). */
  const [veil, setVeil] = useState<Veil>(null);
  /** The content region the drop zone lies over (K9): never the sidebar. */
  const mainRef = useRef<HTMLElement>(null);

  // «New link» closes once the bookmark is saved and follows the site after (NP-133): a follow
  // that fails then has no sheet to say so, so the app's own notice does.
  useEffect(() =>
    onFollowFailed((err) => {
      // Once the sheet's own closing has rendered: open, it shows the error itself.
      window.setTimeout(() => surfaceNow.current !== "add" && setNotice({ text: describeError(err), alert: true }), 50);
    }),
  []);
  // `⌘V` in the library with a link on the clipboard saves it at once (2026-10-16). The paste
  // event carries the clipboard itself: no permission, nothing read before the person pastes.
  // In a field, under a dialog, the editor or the reading mode the paste is theirs.
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest("input, textarea, select, [contenteditable=true]") || quickBlocked()) return;
      const data = e.clipboardData;
      const url = linkFrom(data?.getData("text/uri-list"), true) ?? linkFrom(data?.getData("text/plain"));
      if (!url) return;
      e.preventDefault();
      quickSaveRef.current(url);
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  }, []);
  // A link dragged from a browser or another app frosts the list; dropped, it is saved, with
  // Shift into the inbox (2026-10-16). The app's own drags are left alone: the selection's drag is
  // a pointer drag and never starts one of these. A file asks to be imported (NP-139): a `.kpin`
  // list, OPML or a bookmarks file; the webview must not open a dropped file itself, so a file
  // drag is always taken. While something is open over the window (a dialog, a menu, triage,
  // reading, the editor) it gets no veil and its drop is ignored, but for a dialog that takes drops
  // itself (`[data-drop-accepts]`: New, Import): it has the drag, and the window only keeps the
  // webview from opening a file dropped beside it. The zone lies over the list
  // area only: the sidebar has its own drops, and over it or the toolbar a drop does nothing.
  // Whether the pointer is in the area goes by where it is, not by which child it entered, so
  // moving between cards never flickers the zone.
  useEffect(() => {
    let depth = 0;
    let accepting: "link" | "file" | "dialog" | null = null;
    let fileZone: FileZone | null = null;
    /** Where the zone last lay: some webviews (WebKitGTK, WebView2) give a drop no coordinates. */
    let lastArea: DropArea | null = null;
    let said = false;
    let own = false;
    const start = () => (own = true);
    const end = () => (own = false);
    /**
     * The list area under the pointer, or null outside it: the view's `[data-drop-area]` (the
     * library's cards or rows, the posts and the article of Feeds, the content of Settings) below
     * the lowest `[data-drop-head]` on screen over it; `<main>` itself in a view without one.
     */
    const areaAt = (e: DragEvent): DropArea | null => {
      const main = mainRef.current;
      if (!main) return null;
      const box = (main.querySelector("[data-drop-area]") ?? main).getBoundingClientRect();
      // A head folded away (the post list behind a spread article) has no width and does not count.
      const heads = Array.from(main.querySelectorAll("[data-drop-head]"), (head) => head.getBoundingClientRect()).filter((head) => head.width > 0);
      const top = Math.max(box.top, ...heads.map((head) => head.bottom));
      const inside = e.clientX >= box.left && e.clientX < box.right && e.clientY >= top && e.clientY < box.bottom;
      return inside ? { top, left: box.left, width: box.width, height: box.bottom - top } : null;
    };
    /** The zone for where the pointer is now; it is said once per drag, when it first shows. */
    const show = (e: DragEvent) => {
      const area = (lastArea = areaAt(e));
      if (e.dataTransfer) e.dataTransfer.dropEffect = !area || (accepting === "file" && (importBlocked() || importBusy())) ? "none" : "copy";
      const next: Veil = !area ? null : accepting === "file" ? fileZone && { inbox: false, file: fileZone, area } : { inbox: e.shiftKey, area };
      if (next && !said) {
        said = true;
        announceZoneRef.current(next.file ?? { link: true, hint: "" });
      }
      setVeil((current) => (sameVeil(current, next) ? current : next));
    };
    const enter = (e: DragEvent) => {
      if (depth === 0) {
        const file = own ? null : draggedFile(e.dataTransfer);
        const taker = !own && (file || carriesLink(e.dataTransfer?.types)) && document.querySelector("[data-drop-accepts]");
        accepting = taker ? "dialog" : file ? "file" : !own && carriesLink(e.dataTransfer?.types) && !quickBlocked() ? "link" : null;
        // Another import open: the zone says so (K9 «Busy»); over anything else nothing shows.
        const busy = !!file && importBusy();
        fileZone = file && (busy || !importBlocked()) ? { file, busy } : null;
        said = false;
      }
      if (!accepting) return;
      depth++;
      if (accepting === "dialog") return keepOut(e);
      e.preventDefault();
      show(e);
    };
    /** Beside a dialog that takes drops: no drop, and no file opened by the webview. */
    const keepOut = (e: DragEvent) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
    };
    const over = (e: DragEvent) => {
      if (!accepting) return;
      if (accepting === "dialog") return keepOut(e);
      e.preventDefault();
      show(e);
    };
    const leave = () => {
      if (!accepting) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        accepting = null;
        lastArea = null;
        setVeil(null);
      }
    };
    const drop = (e: DragEvent) => {
      if (!accepting) return;
      e.preventDefault();
      const kind = accepting;
      depth = 0;
      accepting = null;
      setVeil(null);
      // The dialog under the pointer took it, or it fell beside the dialog.
      if (kind === "dialog") return;
      // Over the sidebar or the toolbar a drop does nothing; a drop at 0,0 goes by the last dragover.
      const area = e.clientX || e.clientY ? areaAt(e) : lastArea;
      lastArea = null;
      if (!area) return;
      const data = e.dataTransfer;
      if (kind === "file") {
        if (!importBlocked() && !importBusy()) dropFileRef.current(data?.files);
        // Another file while an import is open is refused: that is said, not dropped in silence.
        else if (importBusy()) sayRef.current(t("add.dropImportBusy"), true);
        return;
      }
      const url = linkFrom(data?.getData("text/uri-list"), true) ?? linkFrom(data?.getData("text/plain"));
      if (url) quickSaveRef.current(url, e.shiftKey);
    };
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", end);
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", end);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);
  // The lists Rust keeps (a `.kpin` opened with the app, a `koonapin://` link) wait in
  // openRequests for the list dialog (NP-139, NP-142); one refused because another is open is said.
  useEffect(() => receiveNativeOpens(() => sayRef.current(t("add.dropImportBusy"), true)), []);
  // The landing plays once; a later render of the card must not play it again.
  useEffect(() => {
    if (fresh === null) return;
    const timer = window.setTimeout(() => setFresh(null), 2200);
    return () => window.clearTimeout(timer);
  }, [fresh]);

  /**
   * Menu «⋯» → Export (NP-032, frame 29): the Save dialog, then «… сохранено
   * в … · Показать» for 8 seconds, or an alert with the reason and
   * «Повторить», which opens the dialog again. Cancelling says nothing.
   */
  const exportLibrary = (format: ExportFormat, ids?: number[]) => {
    const columns =
      format === "csv" ? (Object.fromEntries(CSV_COLUMNS.map((key) => [key, t(`export.columns.${key}`)])) as CsvColumns) : undefined;
    const retry = () => exportLibrary(format, ids);
    api.exportLibrary(format, columns, ids).then(
      (result) => {
        if (result.outcome === "cancelled") return;
        if (result.outcome === "saved")
          return setNotice({
            text: t("export.saved", { count: result.count, name: result.file_name }),
            alert: false,
            long: true,
            // A phone has no file manager to show it in (NP-151).
            show: !capabilities.file_manager ? undefined : () => void desktopApi?.revealExport().catch((err) => say(describeError(err), true)),
          });
        const { file_name: name, folder, detail } = result;
        const text =
          result.problem === "disk_full"
            ? t("export.diskFull", { name })
            : result.problem === "no_permission"
              ? t("export.noPermission", { folder })
              : result.problem === "in_use"
                ? t("export.inUse", { name })
                : t("export.other", { name, detail });
        setNotice({ text, alert: true, retry });
      },
      (err) => setNotice({ text: describeError(err), alert: true, retry }),
    );
  };
  /** «Export feeds (OPML)…» (NP-132): the desktop's Save dialog, then the notice of «Save a copy…». */
  const exportFeeds = () =>
    exportOpml().then(
      (result) =>
        result.outcome === "saved" &&
        setNotice({
          text: t("feeds.notice.exported", { count: result.count, name: result.file_name }),
          alert: false,
          long: true,
        }),
      (err) => setNotice({ text: describeError(err), alert: true, retry: () => void exportFeeds() }),
    );
  /**
   * Settings → «Save a copy…» (NP-034, sheet 33): like an export, «… · Show»
   * for 8 seconds, or an alert with the reason and «Retry».
   */
  const saveBackupCopy = () =>
    api.saveBackupCopy().then(
      (result) => {
        if (result.outcome === "cancelled") return;
        if (result.outcome === "saved")
          return setNotice({
            text: t("settings.copySaved", { name: result.file_name }),
            alert: false,
            long: true,
            show: !capabilities.file_manager ? undefined : () => void desktopApi?.revealExport().catch((err) => say(describeError(err), true)),
          });
        setNotice({ text: t("settings.copySaveFailed", { name: result.file_name, detail: result.detail }), alert: true, retry: () => void saveBackupCopy() });
      },
      (err) => setNotice({ text: describeError(err), alert: true, retry: () => void saveBackupCopy() }),
    );

  /**
   * A link saved by hand (2026-10-16): the sheet, `⌘V` in the library and a link
   * dropped on the window. Every link arrives in the inbox; «Library» sorts it at
   * once (into the chosen collection, if any), «Reading» sorts it and puts it in
   * Reading. A link already there changes nothing. The card lands first and a
   * glass notice says where it went, with «Undo».
   */
  const saveLink = async ({ url, title, collectionId, tags, destination }: NewLink) => {
    const added = await api.addBookmark({ url, title, collectionId: destination === "inbox" ? null : collectionId, tags });
    if (added.existing) return added;
    const b = added.bookmark;
    if (destination !== "inbox") await api.bulkUpdate([b.id], { action: "move", collection_id: collectionId ?? b.collection_id });
    if (destination === "reading") await api.bulkUpdate([b.id], { action: "reading", reading: true });
    scrollRef.current?.scrollTo({ top: 0 });
    await library.refresh();
    setFresh(b.id);
    const into = destination === "library" ? library.collections.find((c) => c.id === (collectionId ?? b.collection_id)) : undefined;
    const place = destination === "inbox" ? t("nav.inbox") : destination === "reading" ? t("nav.reading") : (into?.name ?? t("import.library"));
    setNotice({
      text: added.restored ? (destination === "inbox" ? t("notice.restoredLink") : t("add.restoredTo", { place })) : t("add.savedTo", { place }),
      alert: false,
      glass: true,
      undo: () => unsave(b.id, added.restored),
    });
    return added;
  };
  /**
   * «Undo» of a saved link: a new one is gone again, for good — it was never
   * there; one that came back from the trash goes back to it.
   */
  const unsave = (id: number, restored: boolean) => {
    setNotice(null);
    setFresh(null);
    void api
      .trashBookmark(id)
      .then(() => (restored ? undefined : api.deleteForever(id)))
      .then(() => library.refresh())
      .then(
        () => setNotice({ text: t("add.removed"), alert: false, glass: true }),
        (err) => say(describeError(err), true),
      );
  };
  /** `⌘V` and a drop save at once, where the person is; `toInbox`: Shift held on the drop. */
  const quickSave = (url: string, toInbox = false) => {
    const destination = toInbox ? "inbox" : destinationOf(filters);
    void saveLink({ url, collectionId: destination === "inbox" ? null : filters.collectionId, tags: [], destination }).then(
      (added) =>
        added.existing &&
        setNotice({
          text: t("notice.linkExisting"),
          alert: false,
          glass: true,
          show: () => {
            setNotice(null);
            editorFocus.current = null;
            setEditing(added.bookmark);
          },
        }),
      (err) => say(describeError(err), true),
    );
  };
  /** Where a drop saves without Shift, as the drop zone names it. */
  const dropPlace =
    destinationOf(filters) === "reading" ? t("nav.reading") : (library.collections.find((c) => c.id === filters.collectionId)?.name ?? t("import.library"));
  /** The drop zone's line for a link: where it goes, and that Shift sends it to the inbox. */
  const veilHint = (inbox: boolean) => (inbox || destinationOf(filters) === "inbox" ? t("add.dropHintInbox") : t("add.dropHint", { place: dropPlace }));
  const quickSaveRef = useRef(quickSave);
  quickSaveRef.current = quickSave;
  /**
   * A file dropped or picked, read and known (importFile.ts): a list waits for the list dialog,
   * OPML and bookmarks open their import dialog with it, a full copy opens Restore; or the person
   * hears why it is not taken.
   */
  const routeImport = (read: ImportFile | ImportRefusal) => {
    if (isRefusal(read)) {
      if (read.refused === "unsupported") say(t("add.dropImportOther"), true);
      else say(t("add.dropImportTooBig", { size: Math.round(read.cap / (1024 * 1024)) }), true);
      return false;
    }
    if (read.kind === "kpin") {
      if (openRequests.push({ kind: "kpin", name: read.name, text: read.text })) return true;
      say(t("add.dropImportBusy"), true);
      return false;
    }
    const target = read.kind === "opml" ? "importFeeds" : read.kind === "backup" ? "restore" : "import";
    setDroppedFile({ name: read.name, content: read.text, surface: target });
    setSurface(target);
    return true;
  };
  /** Of several dropped files the first is taken, and that is said. */
  const dropFile = (files: FileList | null | undefined) =>
    void importFile.readDropped(files).then(
      (read) => {
        if (read && routeImport(read) && !isRefusal(read) && read.more) say(t("add.dropImportOne", { name: read.name }));
      },
      (err) => say(describeError(err), true),
    );
  const dropFileRef = useRef(dropFile);
  dropFileRef.current = dropFile;
  /** Whether a dropped file may be imported now: nothing over the window, on any page. */
  const importBlocked = () => !!triageRef.current || !!readingRef.current || !!editingRef.current || !!document.querySelector("dialog[open], [data-menu]");
  /** Another import is open (K9 «Busy»): a list waits or shows, or an import or restore dialog. */
  const importBusy = () => !!openRequests.current() || IMPORT_SURFACES.includes(surfaceNow.current);
  /** The drop zone is said once per drag, through the live region (K9). */
  const announceZone = (zone: DropZoneState) => {
    const words = dropZoneText(zone.link ? { link: true, hint: veilHint(false) } : zone, t);
    setAnnouncement([words.title, words.line, words.hint].filter(Boolean).join(". "));
  };
  const announceZoneRef = useRef(announceZone);
  announceZoneRef.current = announceZone;
  /** Whether `⌘V` and a drop may save now: the library on screen, nothing over it. */
  const quickBlocked = () =>
    pageRef.current !== "library" || !!triageRef.current || !!readingRef.current || !!editingRef.current || !!document.querySelector("dialog[open], [data-menu]");

  return { fresh, veil, veilHint, mainRef, dropFile, exportLibrary, exportFeeds, saveBackupCopy, saveLink, unsave };
}

export type ImportExport = ReturnType<typeof useImportExport>;
