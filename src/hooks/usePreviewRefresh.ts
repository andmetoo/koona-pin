import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../services/api";
import { savePreference, storedValue } from "../services/preferences";
import { PreviewRefresh, PreviewScope } from "../types";

const DISMISSED = "previewRefresh.dismissed";

/** What the link check found among the pages a refresh could not open. */
export interface HandedOff {
  /** The refresh's start: the notification's key. */
  key: string;
  gone: number;
  moved: number;
}

/**
 * «Refresh previews» for many bookmarks (Settings → Storage, the selection bar, after an import):
 * the run of this session as Rust reports it, picked up again after a reload, and whether its
 * result was dismissed from the notification centre. The run is told apart by when it began.
 *
 * Pages it could not open go to the link check (`check_ids`); when that check of them ends, what
 * it found among them is `handedOff`, for the notification centre.
 */
export function usePreviewRefresh() {
  const [run, setRun] = useState<PreviewRefresh | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() => storedValue(DISMISSED));
  const [handedOff, setHandedOff] = useState<HandedOff | null>(null);
  /** A hand-off waiting for its link check: the refresh's start and the ids, and whether the check began. */
  const waiting = useRef<{ key: string; ids: Set<number>; began: boolean } | null>(null);
  /** When the hand-off's check ended: other listeners of that same event still ask. */
  const ended = useRef(0);

  useEffect(() => {
    const off = api.onPreviewRefresh((state) => {
      setRun(state);
      if (state.started_at && state.state === "done" && state.check_ids.length && waiting.current?.key !== state.started_at)
        waiting.current = { key: state.started_at, ids: new Set(state.check_ids), began: false };
    });
    // An event that came first is newer than the answer.
    void api
      .getPreviewRefresh()
      .then((state) => setRun((now) => now ?? state))
      .catch(() => {});
    return off;
  }, []);

  useEffect(
    () =>
      api.onLinkCheck((progress) => {
        const handoff = waiting.current;
        if (!handoff) return;
        // A check the person started may run first: the hand-off's checks just these.
        if (progress.state === "running") {
          if (progress.total <= handoff.ids.size) handoff.began = true;
          return;
        }
        if (!handoff.began) return;
        waiting.current = null;
        ended.current = Date.now();
        if (progress.state !== "idle") return;
        void api
          .getLinkCheck()
          .then((report) => {
            const among = (list: { bookmark: { id: number } }[]) => list.filter((c) => handoff.ids.has(c.bookmark.id)).length;
            setHandedOff({ key: handoff.key, gone: among(report.gone), moved: among(report.moved) });
          })
          .catch(() => {});
      }),
    [],
  );

  /** The run started, or the one already under way. */
  const start = useCallback(async (target: { scope: PreviewScope } | { ids: number[] }) => {
    const state = await api.startPreviewRefresh(target);
    // Events of this run may have moved it on already.
    setRun((now) => (now?.started_at === state.started_at ? now : state));
    return state;
  }, []);

  const stop = useCallback(() => api.stopPreviewRefresh(), []);

  const startedAt = run?.started_at ?? null;
  const dismiss = useCallback(() => {
    if (!startedAt) return;
    setDismissed(startedAt);
    savePreference(DISMISSED, startedAt);
  }, [startedAt]);
  const dismissHandedOff = useCallback(() => setHandedOff(null), []);

  const running = run?.state === "running";
  const finished = !!run?.started_at && !running && run.state !== "idle";
  return {
    run,
    running,
    start,
    stop,
    dismiss,
    resultShown: finished && dismissed !== run?.started_at,
    handedOff,
    dismissHandedOff,
    /** The link check now under way, or next, is the hand-off's: its own notice would say it twice. */
    handingOff: () => !!waiting.current || Date.now() - ended.current < 1000,
  };
}
