import { useCallback, useEffect, useRef, useState } from "react";
import type { AppState } from "../../../app/appState";
import { impactMedium } from "../../../platform/haptics";
import { api } from "../../../services/api";
import { describeError, reasonOf, toCommandError } from "../../../services/errors";
import { short, undoNotice } from "../../../services/undo";
import type { Bookmark, BookmarkPage, Changed, Collection, PageCursor, Suggestion } from "../../../types";
import { current, type Decision, type TriageAction, triageReducer, type TriageState } from "./triage";

/** A decision just made: the card on screen leaves toward its side (Reading up, a collection down). */
export type Leaving = { b: Bookmark; kind: Decision; from: number; n: number };

/**
 * The phone's triage (NP-072b) over the app: the inbox read once when the screen opens, changes
 * from anywhere, and every decision through the same commands as the desktop's triage
 * (components/library/Triage.tsx) — `update_bookmark` keeps or files, `trash_bookmark` throws away,
 * Reading is a keep and then the bulk "reading" action — so sync and undo behave as there. The
 * card leaves at once; the commands run one after another, and a failure brings it back with
 * "Try again" and drops the decisions made after it.
 */
export function useTriage(app: AppState) {
  const { t } = app;
  const [state, setState] = useState<TriageState | null>(null);
  const [loadError, setLoadError] = useState("");
  /** The truth for work in flight, updated before React renders. */
  const ref = useRef(state);
  const apply = useCallback((action: TriageAction) => {
    const next = triageReducer(ref.current, action);
    if (next === ref.current) return;
    ref.current = next;
    setState(next);
  }, []);
  const appRef = useRef(app);
  appRef.current = app;

  const chain = useRef(Promise.resolve());
  const epoch = useRef(0);
  const enqueue = (work: () => Promise<void>) => {
    const mine = epoch.current;
    chain.current = chain.current.then(() => (mine === epoch.current ? work() : undefined)).catch(() => {});
  };

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const bookmarks: Bookmark[] = [];
      let after: PageCursor | null = null;
      do {
        const page: BookmarkPage = await api.getBookmarks({ onlyInbox: true }, { limit: 1000, after: after ?? undefined });
        bookmarks.push(...page.items);
        after = page.next;
      } while (after);
      apply({ type: "loaded", bookmarks, at: Date.now() });
    } catch (err) {
      setLoadError(describeError(err));
    }
  }, [apply]);
  useEffect(() => {
    void load();
  }, [load]);

  /** The collection picker opened from triage, for this card: a collection it sets is a decision. */
  const picking = useRef<number | null>(null);
  useEffect(() => {
    const hear = (change: Parameters<Parameters<typeof api.onBookmarkChanged>[0]>[0]) => {
      const shown = current(ref.current);
      const b = change.bookmark;
      if (b && shown && b.id === shown.id && picking.current === b.id && b.collection_id !== null && b.collection_id !== shown.collection_id) {
        // Filed through the picker: it leaves as filed. Its undo is the picker's own notice.
        picking.current = null;
        apply({ type: "decide", id: b.id, kind: "move", collectionId: b.collection_id, at: Date.now() });
        apply({ type: "settled", id: b.id, bookmark: b, commands: [] });
        void impactMedium();
        return;
      }
      apply({ type: "changed", change });
    };
    const offOne = api.onBookmarkChanged(hear);
    const offMany = api.onBookmarksChanged((changes) => changes.forEach(hear));
    return () => {
      offOne();
      offMany();
    };
  }, [apply]);

  const shown = current(state);
  const decisions = state?.steps.length ?? 0;

  /** The suggested collection of the card on screen (NP-026), asked again after each decision. */
  const [suggestion, setSuggestion] = useState<{ id: number; value: Suggestion | null } | null>(null);
  const shownId = shown?.id;
  useEffect(() => {
    if (shownId === undefined) return;
    let live = true;
    const settle = (value: Suggestion | null) => live && setSuggestion({ id: shownId, value });
    api.suggestCollection(shownId).then(settle, () => settle(null));
    return () => {
      live = false;
    };
  }, [shownId, decisions]);
  const suggested = suggestion?.id === shownId ? (suggestion?.value ?? null) : null;

  const [leaving, setLeaving] = useState<Leaving | null>(null);

  /** What the snackbar says after a decision. */
  const said = (kind: Decision, title: string, collection?: Collection) =>
    kind === "keep"
      ? t("phone.inbox.kept", { title: short(title) })
      : kind === "trash"
        ? t("phone.inbox.trashed", { title: short(title) })
        : kind === "reading"
          ? t("phone.inbox.toReading", { title: short(title) })
          : t("phone.inbox.filed", { name: collection?.name ?? "", title: short(title) });

  /** Why a decision failed, short: "the library is busy" (desktop frame 20). */
  const reason = (err: unknown) => {
    const { code } = toCommandError(err);
    return code === "database_busy" || code === "disk_full" || code === "read_only" ? reasonOf(err) : describeError(err);
  };

  /** The commands of a decision; Reading keeps first, then adds to Reading, as two steps of the journal. */
  const commandsOf = async (kind: Decision, b: Bookmark, collection?: Collection): Promise<{ bookmark: Bookmark; commands: number[] }> => {
    const of = ({ bookmark, command }: Changed) => ({ bookmark, commands: command === null ? [] : [command] });
    if (kind === "trash") return of(await api.trashBookmark(b.id));
    if (kind === "move") return of(await api.updateBookmark(b.id, { collection_id: collection?.id ?? null }));
    const kept = of(await api.updateBookmark(b.id, {}));
    if (kind === "keep") return kept;
    try {
      const { command } = await api.bulkUpdate([b.id], { action: "reading", reading: true });
      return { bookmark: { ...kept.bookmark, reading_at: kept.bookmark.reading_at ?? new Date().toISOString() }, commands: command === null ? kept.commands : [...kept.commands, command] };
    } catch (err) {
      // Half a decision is none: the keep goes back too.
      for (const command of kept.commands) await api.undo(command).catch(() => {});
      throw err;
    }
  };

  /**
   * A decision about the card on screen. `from`: where a swipe let it go (px), so it flies on
   * from there.
   */
  const decide = (kind: Decision, { collection, from = 0 }: { collection?: Collection; from?: number } = {}) => {
    const b = current(ref.current);
    if (!b) return;
    picking.current = null;
    apply({ type: "decide", id: b.id, kind, collectionId: collection?.id ?? null, at: Date.now() });
    setLeaving((last) => ({ b, kind, from, n: (last?.n ?? 0) + 1 }));
    void impactMedium();
    enqueue(async () => {
      try {
        const { bookmark, commands } = await commandsOf(kind, b, collection);
        apply({ type: "settled", id: b.id, bookmark, commands });
        const now = appRef.current;
        now.say(said(kind, bookmark.title || bookmark.url, collection), false, undo);
      } catch (err) {
        epoch.current++;
        apply({ type: "failed", id: b.id });
        const why = reason(err);
        const text =
          kind === "trash"
            ? t("triage.failedTrash", { reason: why })
            : kind === "move"
              ? t("triage.failedMove", { name: collection?.name ?? "", reason: why })
              : t("triage.failedKeep", { reason: why });
        appRef.current.setNotice({ text, alert: true, retry: () => decide(kind, { collection }) });
      }
    });
  };

  /** The heart: a change of the card, not a decision (the snackbar's Undo stays the decision's). */
  const favorite = () => {
    const b = current(ref.current);
    if (!b) return;
    enqueue(async () => {
      try {
        const { bookmark } = await api.updateBookmark(b.id, { is_favorite: !b.is_favorite });
        apply({ type: "patched", bookmark });
      } catch (err) {
        appRef.current.say(describeError(err), true);
      }
    });
  };

  /** The last decision taken back: its card returns to the screen. */
  const undo = () =>
    enqueue(async () => {
      const step = ref.current?.steps.at(-1);
      const say = appRef.current.say;
      if (!step) return say(t("undo.nothing"));
      try {
        let back: Bookmark | null = null;
        for (const command of [...step.commands].reverse()) {
          const result = await api.undo(command);
          if (result.outcome !== "undone") {
            // Changed since, gone or forgotten: the decision cannot come back.
            apply({ type: "forgotten" });
            const { text, alert } = undoNotice(t, result);
            return say(text, alert);
          }
          back = result.bookmarks.find((b) => b.id === step.id) ?? back;
        }
        apply({ type: "undone", bookmark: back });
        setLeaving(null);
        say(t("triage.backInQueue", { title: short(back?.title || step.title) }));
      } catch (err) {
        epoch.current++;
        say(describeError(err), true);
      }
    });

  return {
    state,
    loadError,
    reload: load,
    current: shown,
    suggested,
    leaving,
    endLeaving: (n: number) => setLeaving((last) => (last?.n === n ? null : last)),
    decide,
    favorite,
    undo,
    /** The picker is about to open for the card on screen. */
    pickFor: (id: number | null) => {
      picking.current = id;
    },
  };
}

export type Triage = ReturnType<typeof useTriage>;
