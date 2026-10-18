import { useEffect } from "react";
import { capabilities } from "../platform/capabilities";
import { desktopApi } from "../services/api";
import { describeError } from "../services/errors";
import { composing } from "../services/ime";
import { isArrow, isDeleteKey } from "../services/keys";
import type { AppState } from "./appState";

/**
 * The window's keys: `Ctrl K` search, `Ctrl N` a new link, `Ctrl Z` undo, `Ctrl Q` quit where the
 * app quits (NP-096), and in the library the selection's keys: `Ctrl A`, `Esc`, `Del`, `R`, `Space`
 * and the arrows (NP-028, NP-029, NP-121, NP-123, #319). A shell wires them.
 */
export function useShortcuts(app: AppState) {
  const {
    wide,
    reading,
    editing,
    setEditing,
    editorFocus,
    triage,
    setTriage,
    page,
    setPage,
    filters,
    searchRef,
    setSurface,
    undoRef,
    selectionRef,
    bulkBusyRef,
    selectionActionsRef,
    readSelectionRef,
    arrowsRef,
    actionsRef,
    say,
  } = app;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Keys an IME uses to build a character are not shortcuts (NP-090).
      if (composing(e)) return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "k" && !reading) {
        e.preventDefault();
        setPage("library");
        setTriage(null);
        // The toolbar's field mounts with the library: wait a few frames for it when coming from elsewhere.
        const focusSearch = (frames: number) =>
          requestAnimationFrame(() => (searchRef.current ? searchRef.current.focus() : frames > 0 && focusSearch(frames - 1)));
        focusSearch(5);
      }
      // Quits from the window on every system (NP-096): without a tray it is the way out.
      if (capabilities.quit && (e.ctrlKey || e.metaKey) && (key === "q" || e.code === "KeyQ") && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void desktopApi?.quitApp().catch(() => {});
      }
      if ((e.ctrlKey || e.metaKey) && key === "n" && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        setSurface("add");
      }
      if (e.key === "Escape" && wide && editing && !document.querySelector("dialog[open], [data-menu]")) {
        setEditing(null);
        editorFocus.current?.focus();
      }
      // Ctrl Z takes back the last action (NP-024). In a text field it stays
      // the field's own undo; under a dialog, a menu or the editor it waits:
      // the bookmark there could change under the form.
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable=true]");
      // Triage takes `Z` and Ctrl Z back for its own decisions.
      const above = editing || triage || document.querySelector("dialog[open], [data-menu]");
      // The reading mode is a layer too: the library under it keeps its selection and keys.
      // Ctrl Z still works there (#319): «Remove from Reading» is taken back from the mode.
      const layer = above || reading;
      if ((e.ctrlKey || e.metaKey) && key === "z" && !e.shiftKey && !typing && !above) {
        e.preventDefault();
        undoRef.current();
      }
      // Selection (NP-028): Ctrl A adds everything the list shows, loaded or
      // not; in a field it selects the field's text. Esc clears; the search
      // field keeps it while it holds a query (the toolbar stops it there).
      if (page === "library" && !layer) {
        if ((e.ctrlKey || e.metaKey) && key === "a" && !e.shiftKey && !typing) {
          e.preventDefault();
          void selectionRef.current.selectAll().catch((err) => say(describeError(err), true));
        }
        if (e.key === "Escape" && selectionRef.current.ids.size) selectionRef.current.clear();
        // Del: the selection to the trash, or, in the trash, the dialog to delete it for good (NP-029).
        // On a Mac ⌫ and ⌘⌫ too (#297).
        if (isDeleteKey(e) && !typing && selectionRef.current.ids.size && !e.repeat && !bulkBusyRef.current) {
          e.preventDefault();
          if (filters.onlyTrash) selectionActionsRef.current.deleteForever();
          else selectionActionsRef.current.trash();
        }
        // R: the selection into Reading, or out of it in Reading itself (NP-121).
        const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
        if (key === "r" && plain && !typing && !filters.onlyTrash && selectionRef.current.ids.size && !e.repeat && !bulkBusyRef.current) {
          e.preventDefault();
          selectionActionsRef.current.reading(!filters.onlyReading);
        }
        // Space: the reading sheet for the last one clicked of the selection (NP-123). A
        // focused card reads itself; a focused button presses itself. Triage keeps Space
        // for the browser: it is a layer, so this never runs there.
        const own = e.target instanceof HTMLElement && e.target.closest("button, a, [data-bookmark-id], [role=menuitem]");
        if (e.key === " " && plain && !e.shiftKey && !typing && !own && !e.repeat && !filters.onlyTrash && selectionRef.current.ids.size) {
          e.preventDefault();
          readSelectionRef.current();
        }
        // Arrows move the selection between cards and rows (#319), Shift adds the range
        // as Shift+click does. Only from the list or from nowhere: the sidebar, the toolbar
        // and fields keep their arrows; the reading sheet and menus are layers.
        const target = e.target instanceof HTMLElement ? e.target : null;
        const fromList = !target || target === document.body || !!target.closest("[data-view]");
        if (isArrow(e.key) && fromList && !e.ctrlKey && !e.metaKey && !e.altKey && !typing && !e.defaultPrevented && arrowsRef.current) {
          e.preventDefault();
          // From the focused card, else the last one clicked of the selection.
          const card = target?.closest<HTMLElement>("[data-bookmark-id]");
          const last = selectionRef.current.last();
          const from = card ? Number(card.dataset.bookmarkId) : last !== null && selectionRef.current.ids.has(last) ? last : null;
          const b = arrowsRef.current(e.key, from);
          if (b) actionsRef.current.select(b, e.shiftKey && from !== null ? "range" : "only");
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [wide, editing, triage, page, filters.onlyTrash, filters.onlyReading, reading]);
}
