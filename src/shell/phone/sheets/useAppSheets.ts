import { useEffect, useRef } from "react";
import type { AppState } from "../../../app/appState";
import type { SheetEntry, Sheets } from "./useSheets";

/**
 * The app's own ways into the phone's sheets (NP-072b): the editor (`app.editing`, set by an Edit
 * anywhere) is the edit sheet, and closing that sheet closes the editor; "New link" (`app.surface`
 * "add", which shared code opens) is the newLink sheet.
 */
export function useAppSheets(app: AppState, sheets: Sheets, entries: SheetEntry[]) {
  const { editing, closeEditor, surface, setSurface } = app;
  const editOpen = entries.some((e) => e.kind === "edit" && !e.leaving);
  const was = useRef({ editing: null as number | null, editOpen: false });

  useEffect(() => {
    const before = was.current;
    const editingId = editing?.id ?? null;
    if (editingId !== null && editingId !== before.editing && !editOpen) sheets.open({ kind: "edit", props: {} });
    else if (editingId === null && editOpen) sheets.close(entries.find((e) => e.kind === "edit" && !e.leaving)?.id);
    else if (before.editOpen && !editOpen && editingId !== null) closeEditor();
    was.current = { editing: editingId, editOpen: editingId !== null && editingId !== before.editing ? true : editOpen };
  }, [editing, editOpen, sheets, entries, closeEditor]);

  useEffect(() => {
    if (surface !== "add") return;
    setSurface(null);
    sheets.open({ kind: "newLink", props: {} });
  }, [surface, setSurface, sheets]);
}
