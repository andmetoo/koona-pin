import { useCallback, useRef, useState } from "react";
import type { EditHooks } from "../components/library/Triage";
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
  const setEditing = useCallback((b: Bookmark | null) => {
    editorSession.current++;
    setEditingState(b);
  }, []);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  /** What had the focus when the editor opened: it gets it back. */
  const editorFocus = useRef<HTMLElement | null>(null);
  /** The editor opened from triage: its save and «В корзину» are triage decisions. */
  const editHooks = useRef<EditHooks | null>(null);
  const closeEditor = () => {
    editHooks.current = null;
    setEditing(null);
    editorFocus.current?.focus();
  };
  // A phone's Back closes the editor, beside the list or in a drawer (NP-151). Registered here for
  // as long as it is open, so moving between the two (a Fold opening) keeps its place under a
  // dialog opened over it; the drawer does not register itself (`back={false}`).
  useBack(closeEditor, !!editing);
  return { editing, setEditing, editingRef, editorSession, editorFocus, editHooks, closeEditor };
}

export type Editing = ReturnType<typeof useEditing>;
