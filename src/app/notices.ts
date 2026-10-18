import { useCallback, useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { api } from "../services/api";
import { describeError } from "../services/errors";
import { undoNotice } from "../services/undo";

/**
 * `undo` turns the notice into «… · Отменить Ctrl Z» for 8 seconds (frame 12);
 * `retry` adds «Повторить» to an alert (frame 20); `long` keeps a plain notice
 * 8 seconds with a close button (frame 21); `show` is «Показать» after an
 * export, 8 seconds (frame 29).
 */
export type Notice = { text: string; alert: boolean; undo?: () => void; retry?: () => void; long?: boolean; show?: () => void; glass?: boolean } | null;

export const NOTICE_MS = 3000;
export const UNDO_MS = 8000;

/** How long a notice stays before it goes by itself; an alert stays until it is closed (null). */
export function noticeDuration(notice: NonNullable<Notice>): number | null {
  if (notice.alert) return null;
  return notice.undo || notice.long ? UNDO_MS : NOTICE_MS;
}

/** The one notice at the bottom of the window (frames 12, 20, 21, 29). */
export function useNotices() {
  const [notice, setNotice] = useState<Notice>(null);
  const say = (text: string, alert = false, undo?: () => void) => setNotice({ text, alert, undo });
  const sayAlert = useCallback((text: string) => setNotice({ text, alert: true }), []);
  const sayRef = useRef(say);
  sayRef.current = say;
  /**
   * What a screen reader hears in the live region: a click that changes the selection (NP-123),
   * an add to the bundle, the drop zone once per drag (K9).
   */
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (!notice) return;
    const ms = noticeDuration(notice);
    if (ms === null) return;
    const timer = window.setTimeout(() => setNotice(null), ms);
    return () => window.clearTimeout(timer);
  }, [notice]);
  return { notice, setNotice, say, sayAlert, sayRef, announcement, setAnnouncement };
}

export type Notices = ReturnType<typeof useNotices>;

/**
 * Ctrl Z takes back the last command, «Отменить» in a notice its own
 * (NP-024). What was changed since is not overwritten: the notice says why.
 * `undone` hears which bookmarks came back, so an editor open on one of them closes.
 */
export function useUndo(t: TFunction, { say, setNotice }: Notices, undone: (ids: number[]) => void) {
  const undo = (command?: number) => {
    setNotice(null);
    api.undo(command).then(
      (result) => {
        if (result.outcome === "undone") undone(result.bookmarks.map((b) => b.id));
        const { text, alert } = undoNotice(t, result);
        say(text, alert);
      },
      (err) => say(describeError(err), true),
    );
  };
  const undoRef = useRef(undo);
  undoRef.current = undo;
  /** «Отменить» for a notice, when the command changed anything. */
  const undoing = (command: number | null) => (command === null ? undefined : () => undoRef.current(command));
  return { undo, undoRef, undoing };
}
