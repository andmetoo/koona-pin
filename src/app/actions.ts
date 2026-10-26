import { MutableRefObject, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { landInBundle } from "../components/bundle/Capsule";
import { addedText, addView, bookmarksByIds } from "../components/bundle/actions";
import type { BookmarkChanges } from "../components/library/BookmarkEditor";
import type { BookmarkActions } from "../components/library/Bookmarks";
import type { Arrows } from "../components/library/BookmarkList";
import type { SelectionActions } from "../components/library/SelectionBar";
import type { useSelection } from "../hooks/useSelection";
import { useSelectionDrag } from "../hooks/useSelectionDrag";
import type { usePreviewRefresh } from "../hooks/usePreviewRefresh";
import { api } from "../services/api";
import { bulkFailure, bulkNotice, readingNotice } from "../services/bulk";
import { Added, bundle } from "../services/bundle";
import { collectionColor, suggestedName } from "../services/collections";
import type { RowDragItem } from "../services/drag";
import { describeError } from "../services/errors";
import type { Bookmark, BulkChange, Collection } from "../types";
import type { Editing } from "./editing";
import type { ImportExport } from "./importExport";
import type { LibraryView } from "./library";
import type { Navigation } from "./navigation";
import type { Notices } from "./notices";
import type { Reading } from "./reading";
import type { Surfaces } from "./surfaces";
import { opener } from "../services/opener";

type Selection = ReturnType<typeof useSelection>;
type Previews = ReturnType<typeof usePreviewRefresh>;

/** Opening a link in the browser and copying text, with a notice when either fails. */
export function linkActions(t: TFunction, { say }: Pick<Notices, "say">) {
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      say(t("notice.copied"));
    } catch {
      say(t("notice.copyFailed"), true);
    }
  };
  const open = opener(say);
  return { copy, open };
}

/**
 * What can be done to bookmarks (editing): one at a time from a card, its menu or the editor, and
 * many at once from the selection bar or a drag onto the sidebar (NP-028, NP-029, NP-030).
 */
export function useBookmarkActions({
  t,
  narrow,
  notices: { say, setNotice, setAnnouncement },
  undoing,
  editing: { editing, editingRef, setEditing, editorFocus, editHooks, editorSession, closeEditor },
  nav: { changeFilters },
  surfaces: { setSurface },
  view: { library, loadedRef },
  selection,
  selectionRef,
  previews,
  reading: { readSelection, readHereRef, openReadingRef, linkTarget, linkTargetRef, offlineRef },
  io: { exportLibrary },
  links: { copy, open },
}: {
  t: TFunction;
  narrow: boolean;
  notices: Pick<Notices, "say" | "setNotice" | "setAnnouncement">;
  undoing: (command: number | null) => (() => void) | undefined;
  editing: Editing;
  nav: Pick<Navigation, "changeFilters">;
  surfaces: Pick<Surfaces, "setSurface">;
  view: Pick<LibraryView, "library" | "loadedRef">;
  selection: Selection;
  selectionRef: MutableRefObject<Selection>;
  previews: Previews;
  reading: Pick<Reading, "readSelection" | "readHereRef" | "openReadingRef" | "linkTarget" | "linkTargetRef" | "offlineRef">;
  io: Pick<ImportExport, "exportLibrary">;
  links: ReturnType<typeof linkActions>;
}) {
  const [deletingCollection, setDeletingCollection] = useState<Collection | null>(null);
  /** What the confirmation (frame 26) would delete for good: one bookmark, the selection or the whole trash. */
  const [purging, setPurging] = useState<Bookmark | "all" | { selected: number[] } | null>(null);
  /** A bulk action is running: the bar waits (NP-029). */
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulkBusyRef = useRef(bulkBusy);
  bulkBusyRef.current = bulkBusy;
  /** «Новая коллекция из выбранного»: the name offered in the sidebar field and the colour the collection will get, while it is open. */
  const [naming, setNaming] = useState<{ suggested: string; color: string } | null>(null);
  /** The arrows of the grid and the list (#319), filled by `BookmarkList` while it is shown. */
  const arrowsRef = useRef<Arrows | null>(null);

  /** The name «Новая коллекция из выбранного» offers, from the selected the list has loaded. */
  const offeredName = () =>
    suggestedName(library.bookmarks.filter((b) => selection.ids.has(b.id))) ?? t("selection.newCollectionName");
  /**
   * One action on every selected bookmark (NP-029, frame 27): one transaction
   * and one command of the journal. The notice counts them and undoes the
   * whole action; after «В корзину» and «Восстановить» the selected leave the
   * list and the selection clears, after the rest it stays. A failure changed
   * nothing: the alert waits with «Повторить», which repeats the same action
   * on the same bookmarks.
   */
  const runBulk = (change: BulkChange, ids = [...selection.ids]) => {
    const target = change.action === "move" ? library.collections.find((c) => c.id === change.collection_id)?.name : undefined;
    setBulkBusy(true);
    setNotice(null);
    api.bulkUpdate(ids, change).then(
      (result) => {
        setBulkBusy(false);
        if (change.action === "trash" || change.action === "restore") {
          selectionRef.current.clear();
          if (editingRef.current && ids.includes(editingRef.current.id)) closeEditor();
        }
        if (result.collection) void library.refreshCatalog();
        say(bulkNotice(t, change, result.count, target), false, undoing(result.command));
      },
      (err) => {
        setBulkBusy(false);
        setNotice({ text: bulkFailure(t, change, ids.length, err, target), alert: true, retry: () => runBulk(change, ids) });
      },
    );
  };
  const selectionActions: SelectionActions = {
    read: () => readSelection(),
    move: (collectionId) => runBulk({ action: "move", collection_id: collectionId }),
    // The strip of a narrow window has no room for the field: the dialog asks instead.
    newCollection: () => {
      if (narrow) return setSurface("selectionCollection");
      const suggested = offeredName();
      // Colours follow the id (services/collections); the library knows the next one.
      void api.nextCollectionId().then(
        (id) => setNaming({ suggested, color: collectionColor(id) }),
        (err) => say(describeError(err), true),
      );
    },
    tag: (name) => runBulk({ action: "tag", name }),
    favorite: (favorite) => runBulk({ action: "favorite", favorite }),
    reading: (reading) => runBulk({ action: "reading", reading }),
    export: (format) => exportLibrary(format, [...selection.ids]),
    addToBundle: () => addSelectionToBundle(null),
    trash: () => runBulk({ action: "trash" }),
    restore: () => runBulk({ action: "restore" }),
    deleteForever: () => setPurging({ selected: [...selection.ids] }),
    refresh: () => {
      const before = previews.run;
      previews.start({ ids: [...selection.ids] }).then(
        (run) =>
          // Only one run at a time: one under way goes on, and says where it is.
          before?.state === "running" && run.started_at === before.started_at
            ? say(t("notice.previewsAlready", { done: run.done, total: run.total }))
            : say(t("notice.previewsStarted")),
        (err) => say(describeError(err), true),
      );
    },
  };
  const selectionActionsRef = useRef(selectionActions);
  selectionActionsRef.current = selectionActions;
  /** The selection dropped on the sidebar (NP-030): the bar's action, one command of the journal. */
  const selectionDrag = useSelectionDrag((target, at) => {
    const run = selectionActionsRef.current;
    if (target.kind === "collection") run.move(target.id);
    else if (target.kind === "tag") run.tag(target.name);
    else if (target.kind === "trash") run.trash();
    else if (target.kind === "favorites") run.favorite(true);
    else if (target.kind === "reading") run.reading(true);
    else if (target.kind === "bundle") addSelectionToBundle(at);
    else run.newCollection();
  });
  /**
   * What an add by drag says, and the capsule's landing at `at` (share-bundle.md, piece C) once it
   * is known that something came in.
   */
  const bundleAdded = (added: Added, at: { x: number; y: number } | null) => {
    setAnnouncement(addedText(t, added));
    if (at && added.kind !== "already") landInBundle(at, added.added);
  };
  const addSelectionToBundle = (at: { x: number; y: number } | null) =>
    void bookmarksByIds(selection.ids, library.bookmarks).then(
      (picked) => bundleAdded(bundle.addBookmarks(picked), at),
      (err) => say(describeError(err), true),
    );
  /** A collection, a tag chip, a feed row or All feeds dropped on the bundle. */
  const addRowToBundle = (item: RowDragItem, at: { x: number; y: number }) => {
    const added =
      item.kind === "feeds"
        ? Promise.resolve(bundle.addFeeds(item.feeds))
        : addView(item.kind === "collection" ? { kind: "collection", collection: item.collection } : { kind: "tag", name: item.name });
    void added.then(
      (result) => bundleAdded(result, at),
      (err) => say(describeError(err), true),
    );
  };
  const dragging = selectionDrag.drag;
  const startDrag = (e: PointerEvent, id: number) => {
    const bookmark = library.bookmarks.find((b) => b.id === id);
    if (bookmark) selectionDrag.start(e, bookmark, selection.ids.size);
  };
  /**
   * One bookmark's Reading change through the bulk command (into or out of Reading, read or
   * unread, or the phone's "finished": read to the end, onto Reading's Read page, in one command), its notice with
   * Undo or the error; true once done.
   */
  const readingChange = (b: Bookmark, change: BulkChange): Promise<boolean> =>
    api.bulkUpdate([b.id], change).then(
      ({ command }) => {
        say(readingNotice(t, change, b), false, undoing(command));
        return true;
      },
      (err) => {
        say(describeError(err), true);
        return false;
      },
    );
  const actions: BookmarkActions = useMemo(
    () => ({
      open,
      copy: (url) => void copy(url),
      edit: (b, field) => {
        editorFocus.current = document.activeElement as HTMLElement;
        setEditing(b, field);
      },
      favorite: (b) => void api.updateBookmark(b.id, { is_favorite: !b.is_favorite }).catch((err) => say(describeError(err), true)),
      // Reading (NP-121): one bookmark through the bulk command, undone the same way.
      reading: (b) => readingChange(b, { action: "reading", reading: !b.reading_at }),
      read: (b) => readingChange(b, { action: "read", read: !b.read_at }),
      offline: (b) => void (b.offline_at ? offlineRef.current.remove(b) : offlineRef.current.save(b)),
      move: (b, collectionId) =>
        void api
          .updateBookmark(b.id, { collection_id: collectionId })
          .then(({ command }) =>
            say(
              collectionId === null
                ? t("notice.movedOut")
                : t("notice.moved", { name: library.collections.find((c) => c.id === collectionId)?.name ?? "" }),
              false,
              undoing(command),
            ),
          )
          .catch((err) => say(describeError(err), true)),
      trash: (b) =>
        void api
          .trashBookmark(b.id)
          .then(({ command }) => {
            if (editingRef.current?.id === b.id) closeEditor();
            say(t("notice.trashed"), false, undoing(command));
          })
          .catch((err) => say(describeError(err), true)),
      restore: (b) =>
        void api
          .restoreBookmark(b.id)
          .then(({ command }) => say(t("notice.restored"), false, undoing(command)))
          .catch((err) => say(describeError(err), true)),
      deleteForever: (b) => setPurging(b),
      tag: (name) => changeFilters({ tag: name }),
      domain: (domain) => changeFilters({ domain }),
      refresh: (b) =>
        void api
          .refreshPreview(b.id)
          // Said as it is: a new picture or icon, none at all, or nothing new beside the old one.
          .then((fresh) =>
            say(
              fresh.image_url !== b.image_url || fresh.favicon_url !== b.favicon_url || fresh.site_name !== b.site_name
                ? t("notice.previewRefreshed")
                : fresh.image_url
                  ? t("notice.previewUnchanged")
                  : t("notice.noPicture"),
            ),
          )
          .catch((err) => say(describeError(err), true)),
      select: (b, how) => {
        const selection = selectionRef.current;
        if (how === "only") selection.only(b.id);
        else if (how === "range") selection.range(b.id, loadedRef.current.map((item) => item.id));
        else selection.toggle(b.id);
        // The ids are set at once; the hook's own state follows on the next render.
        const title = b.title || b.url;
        const now = how === "toggle" ? !selection.ids.has(b.id) : true;
        setAnnouncement(t(now ? "selection.announce" : "selection.unannounce", { title }));
      },
      readHere: (b) => readHereRef.current(b),
      follow: (b) => (linkTargetRef.current === "reader" ? openReadingRef.current(b.id) : open(b.url)),
      linksToBrowser: linkTarget === "browser",
    }),
    [library.collections, t, linkTarget],
  );
  /** For the arrows of the key handler, which is set up before `actions`. */
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  /** The editor's save: through triage when it opened from there, else one command to undo. */
  const saveEdit = async (data: BookmarkChanges) => {
    const hooks = editHooks.current;
    const session = editorSession.current;
    // Another editor opened while this save was on its way keeps its draft open.
    const closeSaved = () => session === editorSession.current && closeEditor();
    if (hooks) {
      await hooks.save(data);
      return void closeSaved();
    }
    const { command } = await api.updateBookmark(editing!.id, data);
    closeSaved();
    say(t("notice.saved"), false, undoing(command));
  };
  /** The editor's «В корзину»: a triage decision when it opened from triage. */
  const deleteEdit = (b: Bookmark) => {
    const hooks = editHooks.current;
    if (!hooks) return actions.trash(b);
    closeEditor();
    hooks.trash();
  };

  return {
    actions,
    actionsRef,
    arrowsRef,
    selectionActions,
    selectionActionsRef,
    selectionDrag,
    dragging,
    startDrag,
    runBulk,
    offeredName,
    readingChange,
    bulkBusy,
    bulkBusyRef,
    naming,
    setNaming,
    purging,
    setPurging,
    deletingCollection,
    setDeletingCollection,
    addRowToBundle,
    saveEdit,
    deleteEdit,
  };
}

export type BookmarkActionsState = ReturnType<typeof useBookmarkActions>;
