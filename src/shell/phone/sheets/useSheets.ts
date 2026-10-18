import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { openPlace } from "../../../platform/back";
import { selection } from "../../../platform/haptics";
import type { SheetKind, SheetRequest } from "./registry";

/** An open sheet: its kind and props, its place in Back's order, and whether it is leaving. */
export type SheetEntry = SheetRequest & {
  id: number;
  place: number;
  leaving: boolean;
  /** What had focus when it opened: focus goes back there when it is gone. */
  opener: Element | null;
};

/**
 * The phone's sheets (NP-072b): `open({ kind, props })` puts a sheet of a kind registered in
 * ./registry.ts over everything (over another sheet too) and returns its id; `close()` closes the
 * top one, `close(id)` that one. Each open sheet answers system Back above the screens' stack.
 */
export type Sheets = {
  open: (request: SheetRequest) => number;
  close: (id?: number) => void;
  closeAll: () => void;
  /** A sheet of this kind is open and not leaving. */
  isOpen: (kind: SheetKind) => boolean;
};

export const SheetsContext = createContext<Sheets | null>(null);

/** The sheets of the phone shell. */
export function useSheets(): Sheets {
  const sheets = useContext(SheetsContext);
  if (!sheets) throw new Error("useSheets outside the phone shell");
  return sheets;
}

/** How long a leaving sheet may take before it is removed anyway (its exit is ~350 ms). */
const EXIT_MS = 600;

/** The sheets' state, held by the shell: the open entries and the API over them. */
export function useSheetState() {
  const [entries, setEntries] = useState<SheetEntry[]>([]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const nextId = useRef(1);

  const exited = useCallback((id: number) => {
    const entry = entriesRef.current.find((e) => e.id === id);
    if (!entry) return;
    entriesRef.current = entriesRef.current.filter((e) => e.id !== id);
    setEntries(entriesRef.current);
    const opener = entry.opener;
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
  }, []);

  const leave = useCallback(
    (ids: number[]) => {
      if (!ids.length) return;
      entriesRef.current = entriesRef.current.map((e) => (ids.includes(e.id) ? { ...e, leaving: true } : e));
      setEntries(entriesRef.current);
      window.setTimeout(() => ids.forEach(exited), EXIT_MS);
    },
    [exited],
  );

  const sheets = useMemo<Sheets>(
    () => ({
      open: (request) => {
        const id = nextId.current++;
        // A long-press menu opens with a tick (doc/mobile-design.md, Motion).
        if (request.kind === "bookmarkMenu") void selection();
        const entry = { ...request, id, place: openPlace(), leaving: false, opener: document.activeElement } as SheetEntry;
        entriesRef.current = [...entriesRef.current, entry];
        setEntries(entriesRef.current);
        return id;
      },
      close: (id) => {
        const open = entriesRef.current.filter((e) => !e.leaving);
        const target = id === undefined ? open[open.length - 1] : open.find((e) => e.id === id);
        if (target) leave([target.id]);
      },
      closeAll: () => leave(entriesRef.current.filter((e) => !e.leaving).map((e) => e.id)),
      isOpen: (kind) => entriesRef.current.some((e) => e.kind === kind && !e.leaving),
    }),
    [leave],
  );

  return { entries, sheets, exited };
}
