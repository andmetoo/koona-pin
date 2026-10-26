import { useCallback, useRef, useState } from "react";
import type { EditHooks } from "../components/library/Triage";
import { restoreFocus } from "../components/ui/focus";
import { useBack } from "../platform/useBack";
import type { Bookmark } from "../types";

/** The bookmark's editor (frame 05): beside the list in a wide window, a drawer otherwise. */
export function useEditing() {
  const [editing, setEditingState] = useState<Bookmark | null>(null);
  /**
   * Grows every time the editor opens or closes: a save that finishes later closes the
   * editor only if it is still the one that was saved, not one opened since with its draft.
   */
  const editorSession = useRef(0);
  /**
   * Asked for the note (the note marker, #410): a new number for each such open, never reused, 0
   * otherwise. The editor already open for that bookmark moves its caret there too, keeping its
   * draft, and one remounted later (the window crossing to the drawer) does not move it again.
   */
  const [notesRequest, setNotesRequest] = useState(0);
  const notesRequests = useRef(0);
  const setEditing = useCallback((b: Bookmark | null, field: "notes" | null = null) => {
    editorSession.current++;
    setNotesRequest(field === "notes" ? ++notesRequests.current : 0);
    setEditingState(b);
  }, []);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  /** What had the focus when the editor opened: it gets it back. */
  const editorFocus = useRef<HTMLElement | null>(null);
  /** The editor opened from triage: its save and «В корзину» are triage decisions. */
  const editHooks = useRef<EditHooks | null>(null);
  const closeEditor = () => {
    const opener = editorFocus.current;
    // The note marker of a note just cleared is gone: its card takes the focus instead (#410).
    const card =
      !opener?.isConnected && opener?.matches("[data-note-marker]") && editingRef.current
        ? document.querySelector<HTMLElement>(`article[data-bookmark-id="${editingRef.current.id}"]`)
        : null;
    editHooks.current = null;
    setEditing(null);
    restoreFocus(card ?? opener);
  };
  // A phone's Back closes the editor, beside the list or in a drawer (NP-151). Registered here for
  // as long as it is open, so moving between the two (a Fold opening) keeps its place under a
  // dialog opened over it; the drawer does not register itself (`back={false}`).
  useBack(closeEditor, !!editing);
  return { editing, setEditing, editingRef, editorSession, notesRequest, editorFocus, editHooks, closeEditor };
}

export type Editing = ReturnType<typeof useEditing>;
