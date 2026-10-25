import { CSSProperties, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CircleAlert, Heart, Sparkle, Tag, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../services/api";
import { collectionTint } from "../../services/collections";
import { buildTree, pathPrefix } from "../../services/collectionTree";
import { describeError, reasonOf, toCommandError } from "../../services/errors";
import { browserName, collectionKeys, nextWaiting, savedDay, Step, summary, waiting } from "../../services/triage";
import { short, undoNotice } from "../../services/undo";
import { Bookmark, BookmarkPage, Changed, Collection, PageCursor, Suggestion } from "../../types";
import { Icon } from "../icons";
import { Hint } from "../ui/Hint";
import { BookmarkChanges } from "./BookmarkEditor";
import { Preview, SiteMark } from "./Bookmarks";
import { TagField } from "./Fields";

/** What the app shows at the bottom: one notice at a time. */
export interface TriageNotice {
  text: string;
  alert?: boolean;
  /** «Повторить» of a failed decision (frame 20). */
  retry?: () => void;
  /** 8 seconds and a close button, like an undo notice (frame 21). */
  long?: boolean;
}

/** E opens the editor of the app; its save and «В корзину» are decisions of triage. */
export interface EditHooks {
  save: (data: BookmarkChanges) => Promise<void>;
  trash: () => void;
}

interface Queue {
  /** Fixed when triage opens, newest first; links saved meanwhile join the end. */
  ids: number[];
  items: Record<number, Bookmark>;
  /** The card on screen; the queue length once everything is decided. */
  position: number;
  /** Links saved during triage: «+1 новая» (frame 22). */
  fresh: number;
  steps: Step[];
}

/** The card just decided, flying off: right when kept, left to the trash, down into a collection. */
interface Leaving {
  b: Bookmark;
  way: "keep" | "trash" | "file";
  n: number;
}

/** Collections 1–9: the first nine in sidebar order (frame 19, no suggestion until NP-026). */
const KEYS = 9;
/** Up to this many cards the header shows a dot for each; a longer queue gets a bar. */
const DOTS = 12;
/** The longest a leaving card stays, should its animation never end (a hidden window). */
const LEAVE_MS = 400;

/** Lucide's trash with its lid apart, so the lid can tilt on hover. */
function TrashIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <g className="lid">
        <path d="M3 6h18" />
        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2" />
      </g>
    </svg>
  );
}

/**
 * How much of the decision capsule fits (NP-084): 0 everything, 1 the trash
 * half as its arrow and icon, 2 Keep too. A longer label or a narrower window
 * gives up the trash words first; a wider one brings them back.
 */
function useFit(label: string) {
  const [fit, setFit] = useState(0);
  const row = useRef<HTMLElement | null>(null);
  /** The width each larger fit needed when it did not fit: a row that wide tries it again. */
  const needs = useRef({ label, widths: [] as number[] });
  const check = useRef(() => {});
  check.current = () => {
    const el = row.current;
    if (!el) return;
    if (needs.current.label !== label) {
      needs.current = { label, widths: [] };
      if (fit > 0) return setFit(0);
    }
    const width = el.clientWidth;
    // The halves clip their sheen, so a word too long shows as a half wider inside than out.
    const over = Math.max(el.scrollWidth - width, 0) + [...el.children].reduce((sum, half) => sum + Math.max(half.scrollWidth - half.clientWidth, 0), 0);
    if (over > 0 && fit < 2) {
      // Both halves grow alike: the row needs twice what one half lacks.
      needs.current.widths[fit] = width + 2 * over;
      setFit(fit + 1);
    } else if (fit > 0 && needs.current.widths[fit - 1] <= width) setFit(fit - 1);
  };
  useLayoutEffect(() => check.current());
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    row.current = el;
    if (!el) return;
    // The row for a narrower window, the halves for their words.
    observer.current = new ResizeObserver(() => check.current());
    for (const node of [el, ...el.children]) observer.current.observe(node);
  }, []);
  return [fit, ref] as const;
}

/**
 * Inbox triage (NP-025, frames 03 and 19–23): one card at a time and a key
 * for each decision. Every decision is saved at once and recorded in the
 * journal (NP-024); `Z` takes the last one back.
 */
export function Triage({
  collections,
  blocked,
  notify,
  onOpen,
  onEdit,
  onFinish,
  onLibrary,
  noticeUp = false,
}: {
  collections: Collection[];
  /** The editor, a dialog or a menu is open: the keys wait. */
  blocked: boolean;
  notify: (notice: TriageNotice | null) => void;
  onOpen: (url: string) => void;
  onEdit: (bookmark: Bookmark, hooks: EditHooks) => void;
  /** «Закончить» `Esc`: back where triage was opened. */
  onFinish: () => void;
  /** «В библиотеку» `Enter` at the end: All bookmarks. */
  onLibrary: () => void;
  /** The app's own notice is at the bottom: the undo toast steps aside for it. */
  noticeUp?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [queue, setQueue] = useState<Queue | null>(null);
  const [loadError, setLoadError] = useState("");
  const [tagging, setTagging] = useState(false);
  /** The starter links of a new library: added by Koona Pin, not by hand (NP-117). */
  const [starter, setStarter] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => {
    let live = true;
    api
      .getStarterLinks()
      .then((ids) => live && setStarter(new Set(ids)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const collectionsRef = useRef(collections);
  collectionsRef.current = collections;
  /** The truth for decisions in flight: updated at once, before React renders. */
  const queueRef = useRef(queue);
  const update = (change: (q: Queue) => Queue) => {
    if (!queueRef.current) return;
    queueRef.current = change(queueRef.current);
    setQueue(queueRef.current);
  };
  /**
   * Decisions run one after another in the order of the keys, so fast typing
   * loses none. A failure drops the ones pressed after it: they were meant
   * for cards the failed one did not reach.
   */
  const chain = useRef(Promise.resolve());
  const epoch = useRef(0);
  const enqueue = (work: () => Promise<void>) => {
    const mine = epoch.current;
    chain.current = chain.current.then(() => (mine === epoch.current ? work() : undefined)).catch(() => {});
  };

  const load = async () => {
    setLoadError("");
    try {
      const items: Record<number, Bookmark> = {};
      const ids: number[] = [];
      let after: PageCursor | null = null;
      do {
        const page: BookmarkPage = await api.getBookmarks({ onlyInbox: true }, { limit: 1000, after: after ?? undefined });
        for (const b of page.items) {
          items[b.id] = b;
          ids.push(b.id);
        }
        after = page.next;
      } while (after);
      queueRef.current = { ids, items, position: 0, fresh: 0, steps: [] };
      setQueue(queueRef.current);
    } catch (err) {
      setLoadError(describeError(err));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  // A link saved during triage joins the end; changes elsewhere update the
  // cards, and the queue skips what was sorted or deleted (redesign, «Очередь»).
  useEffect(
    () =>
      api.onBookmarkChanged((change) =>
        update((q) => {
          const b = change.bookmark;
          if (!b) {
            if (!(change.id in q.items)) return q;
            const items = { ...q.items };
            delete items[change.id];
            return { ...q, items };
          }
          if (q.ids.includes(b.id)) {
            const known = q.items[b.id];
            return known && known.revision > b.revision ? q : { ...q, items: { ...q.items, [b.id]: b } };
          }
          if (change.kind === "created" && waiting(b))
            return { ...q, ids: [...q.ids, b.id], items: { ...q.items, [b.id]: b }, fresh: q.fresh + 1 };
          return q;
        }),
      ),
    [],
  );

  const done = !!queue && queue.position >= queue.ids.length;
  const current = queue && !done ? queue.items[queue.ids[queue.position]] : undefined;
  // The card on screen was deleted for good elsewhere: the next one.
  useEffect(() => {
    if (queue && !done && !current) update((q) => ({ ...q, position: nextWaiting(q.ids, q.items, q.position + 1) }));
  }, [queue, done, current]);

  /**
   * The suggestion for the card on screen (NP-026), asked again after each
   * decision: filing one link can make the next one of the site suggested.
   * Keys 1–9 wait for it, so they never shift under a pressed key.
   */
  const [suggestion, setSuggestion] = useState<{ id: number; value: Suggestion | null } | null>(null);
  const currentId = current?.id;
  const decisions = queue?.steps.length ?? 0;
  useEffect(() => {
    if (currentId === undefined) return;
    let live = true;
    const settle = (value: Suggestion | null) => live && setSuggestion({ id: currentId, value });
    api.suggestCollection(currentId).then(settle, () => settle(null));
    return () => {
      live = false;
    };
  }, [currentId, decisions]);
  const keysReady = suggestion?.id === currentId;
  const suggested = keysReady ? (suggestion?.value ?? null) : null;
  const whyId = useId();
  const [fit, decisionsRef] = useFit(t("triage.trash"));

  const [leaving, setLeaving] = useState<Leaving | null>(null);
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(null), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  const record = (kind: Step["kind"], { bookmark, command }: Changed, advance: boolean, collectionId: number | null = null) => {
    // The card on screen flies off the way it was decided; the next one springs in.
    const shown = onScreen();
    if (advance && shown) {
      const way = kind === "trash" ? "trash" : collectionId !== null && collectionId !== shown.collection_id ? "file" : "keep";
      setLeaving((last) => ({ b: shown, way, n: (last?.n ?? 0) + 1 }));
    }
    update((q) => {
      const items = { ...q.items, [bookmark.id]: bookmark };
      const step: Step = { id: bookmark.id, title: bookmark.title || bookmark.url, kind, collectionId, command, advanced: advance };
      return {
        ...q,
        items,
        steps: [...q.steps, step],
        position: advance ? nextWaiting(q.ids, items, q.position + 1) : q.position,
      };
    });
  };

  /** Why a decision failed, short: «библиотека занята» (frame 20). */
  const reason = (err: unknown) => {
    const { code } = toCommandError(err);
    return code === "database_busy" || code === "disk_full" || code === "read_only" ? reasonOf(err) : describeError(err);
  };

  /**
   * One decision about the card on screen. A failure leaves the card, the
   * queue and the journal as they were; «Повторить» or the same key tries again.
   */
  const decide = (kind: Step["kind"], run: (b: Bookmark) => Promise<Changed>, advance: boolean, collection?: Collection) =>
    enqueue(() => decision(kind, run, advance, collection));
  /** The card a queued decision applies to: the one on screen when its turn comes. */
  const onScreen = () => {
    const q = queueRef.current;
    return q && q.position < q.ids.length ? q.items[q.ids[q.position]] : undefined;
  };
  const decision = async (kind: Step["kind"], run: (b: Bookmark) => Promise<Changed>, advance: boolean, collection?: Collection) => {
    const b = onScreen();
    if (!b) return;
    try {
      const changed = await run(b);
      record(kind, changed, advance, collection?.id ?? null);
      if (advance) notify(null);
    } catch (err) {
      const why = reason(err);
      const text =
        kind === "trash"
          ? t("triage.failedTrash", { reason: why })
          : kind === "move"
            ? t("triage.failedMove", { name: collection?.name ?? "", reason: why })
            : kind === "keep"
              ? t("triage.failedKeep", { reason: why })
              : t("triage.failedSave", { reason: why });
      epoch.current++;
      notify({ text, alert: true, retry: () => decide(kind, run, advance, collection) });
    }
  };
  /**
   * A number key: which collection it means depends on the card it reaches,
   * whose suggestion may differ from the card on screen when it was pressed.
   */
  const fileByKey = (n: number) =>
    enqueue(async () => {
      const b = onScreen();
      if (!b) return;
      const offer = await api.suggestCollection(b.id).catch(() => null);
      const c = collectionKeys(collectionsRef.current, offer, KEYS)[n - 1];
      if (c) await decision("move", (b) => api.updateBookmark(b.id, { collection_id: c.id }), true, c);
    });
  const keep = () => decide("keep", (b) => api.updateBookmark(b.id, {}), true);
  const trash = () => decide("trash", (b) => api.trashBookmark(b.id), true);
  const file = (c: Collection) => decide("move", (b) => api.updateBookmark(b.id, { collection_id: c.id }), true, c);
  const favorite = () => decide("favorite", (b) => api.updateBookmark(b.id, { is_favorite: !b.is_favorite }), false);
  // The notice names the tag added: the bookmark's tags come back in the
  // library's order, not in the order they were added.
  const tag = (name: string) =>
    decide(
      "tag",
      async (b) => {
        const changed = await api.updateBookmark(b.id, { tags: [...(b.tags ?? []).filter((t) => t !== name), name] });
        notify({ text: t("triage.tagAdded", { tag: name }) });
        return changed;
      },
      false,
    );
  const edit = () => {
    if (!current) return;
    onEdit(current, {
      // The editor shows its own error and keeps the form; a save moves on.
      save: async (data) => {
        const changed = await api.updateBookmark(current.id, data);
        record("edit", changed, true, changed.bookmark.collection_id);
        notify(null);
      },
      trash,
    });
  };

  /** `Z`: the last decision of triage comes back; a card returns to the screen (frame 21). */
  const undo = () =>
    enqueue(async () => {
      const step = queueRef.current?.steps.at(-1);
      if (!step) return notify({ text: t("undo.nothing") });
      try {
        const result = step.command === null ? null : await api.undo(step.command);
        if (result && result.outcome !== "undone") {
          // Changed since, gone or forgotten: the step cannot come back.
          update((q) => ({ ...q, steps: q.steps.slice(0, -1) }));
          return notify(undoNotice(t, result));
        }
        const back = result?.bookmarks.find((b) => b.id === step.id);
        update((q) => {
          const index = q.ids.indexOf(step.id);
          return {
            ...q,
            items: back ? { ...q.items, [back.id]: back } : q.items,
            steps: q.steps.slice(0, -1),
            position: step.advanced && index >= 0 ? index : q.position,
          };
        });
        notify(
          step.advanced
            ? { text: t("triage.backInQueue", { title: short(back?.title ?? step.title) }), long: true }
            : undoNotice(t, result!),
        );
      } catch (err) {
        epoch.current++;
        notify({ text: describeError(err), alert: true });
      }
    });

  const tree = buildTree(collections);
  const keys = collectionKeys(collections, suggested, KEYS);
  const handler = useRef<(e: KeyboardEvent) => void>(() => {});
  handler.current = (e: KeyboardEvent) => {
    if (blocked || !queue || document.querySelector("dialog[open], [data-menu]")) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable=true]")) return;
    // A focused button answers Enter and Space itself.
    if ((e.key === "Enter" || e.key === " ") && target.closest("button, a")) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.code === "KeyZ" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      return void undo();
    }
    if (ctrl || e.altKey) return;
    const act = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (e.key === "Escape") return act(onFinish);
    if (done) {
      if (e.key === "Enter") act(onLibrary);
      return;
    }
    const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
    if (digit) return act(() => fileByKey(Number(digit[1])));
    switch (e.code) {
      case "ArrowRight":
      case "Enter":
      case "NumpadEnter":
        return act(() => void keep());
      case "ArrowLeft":
        return act(() => void trash());
      case "KeyF":
        return act(() => void favorite());
      case "KeyT":
        return act(() => setTagging(true));
      case "KeyE":
        return act(edit);
      case "Space":
        return act(() => current && onOpen(current.url));
    }
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => handler.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  if (loadError)
    return (
      <div className="px-8 pt-6">
        <div role="alert" className="sort-failed sort-col">
          <Icon icon={CircleAlert} className="shrink-0 text-danger" />
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{loadError}</span>
          <button type="button" className="sort-btn" onClick={() => void load()}>
            {t("common.retry")}
          </button>
        </div>
      </div>
    );
  if (!queue) return null;

  const total = queue.ids.length;
  const number = Math.min(queue.position + 1, total);
  const waitingNext = queue.ids.slice(queue.position + 1).filter((id) => waiting(queue.items[id]));
  const sum = summary(queue.steps);
  const saved = (b: Bookmark) => {
    const at = new Date(b.created_at);
    const time = at.toLocaleTimeString(i18n.language, { hour: "numeric", minute: "2-digit" });
    const day = savedDay(b.created_at);
    const when =
      day === "earlier"
        ? t("triage.onDate", { date: at.toLocaleDateString(i18n.language, { day: "numeric", month: "long" }) })
        : t(day === "today" ? "triage.todayAt" : "triage.yesterdayAt", { time });
    const browser = browserName(b.source);
    if (starter.has(b.id)) return t("triage.starter", { when });
    if (browser) return t("triage.savedFrom", { when, browser });
    if (b.source === "app") return t("triage.addedByHand", { when });
    if (b.source === "import") return t("triage.imported", { when });
    // A link of a shared `.kpin` list (NP-138): the list's title.
    if (b.source === "list") return b.source_name ? t("triage.fromList", { when, name: b.source_name }) : t("triage.imported", { when });
    if (b.source === "extension") return t("triage.savedFromBrowser", { when });
    // Share → Koona Pin on a phone (NP-071); synced to a computer, it says so there too.
    if (b.source === "share") return t("triage.sharedFromApp", { when });
    // An AI assistant over MCP (NP-091): «from Claude Code», as «from Chrome».
    if (b.source === "mcp")
      return b.source_name ? t("triage.savedFrom", { when, browser: b.source_name }) : t("triage.savedByAssistant", { when });
    return t("triage.saved", { when });
  };

  /** The card itself: cover, where it came from, title and description. */
  const card = (b: Bookmark, open?: () => void) => (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        onClick={open}
        // 16 : 8.4 as the prototype; a low window keeps the decisions on screen.
        className="sort-cover max-h-[clamp(112px,calc(100dvh_-_470px),336px)]"
      >
        <Preview b={b} live />
      </button>
      <div className="flex flex-col gap-1.5 px-[22px] pt-4 pb-5">
        {/* A long «saved … from …» moves to the next line rather than being cut (NP-089);
            the dot stays with the site, so the moved line doesn't start with it. */}
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-meta">
          <span className="flex min-w-0 items-center gap-1.5">
            <SiteMark b={b} />
            <span className="min-w-0 truncate font-medium text-icon" data-user-text>{b.domain}</span>
            <span className="shrink-0" aria-hidden>·</span>
          </span>
          <span>{saved(b)}</span>
        </p>
        <h2 className="line-clamp-2 text-xl leading-[26px] font-semibold tracking-[-0.012em] text-balance" title={b.title}>
          {b.title || b.url}
        </h2>
        {b.description && <p className="line-clamp-2 text-md leading-[21px] text-muted">{b.description}</p>}
      </div>
    </>
  );

  /** What `Z` would take back, said in the toast. */
  const last = queue.steps.at(-1);
  const lastCollection = last?.kind === "move" || last?.kind === "edit" ? collections.find((c) => c.id === last.collectionId) : undefined;
  const lastWhat = !last
    ? ""
    : last.kind === "keep"
      ? t("triage.toastKept")
      : last.kind === "trash"
        ? t("triage.toastTrashed")
        : last.kind === "move"
          ? t("triage.toastFiled", { name: lastCollection?.name ?? "" })
          : last.kind === "edit"
            ? t("triage.toastSaved")
            : last.kind === "favorite"
              ? t(queue.items[last.id]?.is_favorite ? "triage.toastFavorite" : "triage.toastUnfavorite")
              : t("triage.toastTagged");

  return (
    <section aria-label={t("triage.title")} className="relative flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-8 pt-3 pb-24">
        <div className="sort-col flex flex-col gap-[18px]">
          <header className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
            <h1 className="flex min-w-0 items-baseline gap-2 text-xl font-semibold tracking-[-0.015em]">
              {t("triage.title")}
              <span className="text-sm font-medium text-subtle tabular-nums" aria-live="polite">
                {t("triage.progress", { current: number, total })}
              </span>
              {queue.fresh > 0 && <span className="text-xs font-medium text-accent">{t("triage.fresh", { count: queue.fresh })}</span>}
            </h1>
            <div role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done ? total : number} aria-label={t("triage.title")}>
              {total <= DOTS ? (
                <div className="sort-steps">
                  {queue.ids.map((id, i) => (
                    <i key={id} className={i < queue.position ? "ok" : i === queue.position ? "now" : ""} />
                  ))}
                </div>
              ) : (
                <div className="sort-bar">
                  <span className="ok" style={{ width: `${(Math.min(queue.position, total) / total) * 100}%` }} />
                  {!done && <span className="now" style={{ left: `${(queue.position / total) * 100}%`, width: `max(8px, ${100 / total}%)` }} />}
                </div>
              )}
            </div>
            <span className="flex-1" />
            <button type="button" onClick={onFinish} className="sort-btn">
              {t("triage.finish")}
              <kbd className="sort-cap font-sans">Esc</kbd>
            </button>
          </header>

          {current ? (
            <>
              <div className="sort-stack">
                {waitingNext.length > 1 && <div className="sort-behind b2" aria-hidden />}
                {waitingNext.length > 0 && <div className="sort-behind b1" aria-hidden />}
                <article key={`card-${current.id}`} data-triage-card={current.id} className="sort-card in">
                  {card(current, () => onOpen(current.url))}
                </article>
                {leaving && (
                  <div
                    key={`leaving-${leaving.n}`}
                    aria-hidden
                    className={`sort-card leaving ${leaving.way}`}
                    onAnimationEnd={(e) => e.target === e.currentTarget && setLeaving(null)}
                  >
                    {card(leaving.b)}
                  </div>
                )}
              </div>

              {/* One capsule: «← Move to trash | Keep →» and the heart; words go before the row overflows (NP-084). */}
              <div ref={decisionsRef} data-fit={fit} className="sort-seg">
                <button type="button" aria-label={t("triage.trash")} onClick={() => void trash()} className="sort-half trash">
                  <Icon icon={ArrowLeft} size={18} className="arrow" />
                  <TrashIcon />
                  {fit < 1 && <span data-label>{t("triage.trash")}</span>}
                </button>
                <span className="sort-mid" aria-hidden />
                <button type="button" aria-label={t("triage.keep")} onClick={() => void keep()} className="sort-half keep">
                  <Icon icon={Check} strokeWidth={2} />
                  {fit < 2 && <span>{t("triage.keep")}</span>}
                  <Icon icon={ArrowRight} size={18} className="arrow" />
                </button>
                <button
                  type="button"
                  aria-label={current.is_favorite ? t("card.unfavorite") : t("card.favorite")}
                  aria-pressed={current.is_favorite}
                  aria-keyshortcuts="F"
                  onClick={() => void favorite()}
                  className="sort-fav"
                >
                  <Icon icon={Heart} />
                </button>
              </div>

              <div className="flex flex-col gap-2.5">
                <p className="sort-lbl">{t("triage.fileHint")}</p>
                <div data-keys className="flex min-h-[34px] flex-wrap gap-2">
                  {keysReady &&
                    keys.map((c, i) => {
                      // The suggestion leads under key 1, its reason in the hint (NP-026).
                      const offer = i === 0 && suggested?.collection_id === c.id ? suggested : null;
                      const why = offer
                        ? t("triage.suggestedWhy", { domain: current.domain, name: c.name, count: offer.count, filed: offer.filed })
                        : "";
                      const chip = (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => void file(c)}
                          aria-pressed={current.collection_id === c.id}
                          aria-describedby={offer ? whyId : undefined}
                          data-suggested={offer ? true : undefined}
                          className={`sort-chip ${offer ? "sug" : ""}`}
                          style={{ "--sugc": collectionTint(c) } as CSSProperties}
                        >
                          <span className="num">{i + 1}</span>
                          <span className="dot" style={{ background: collectionTint(c) }} />
                          <span data-user-text>
                            {/* Inside another, its path first, muted (2.19.0). */}
                            {pathPrefix(tree, c.id) && <span className="opacity-60">{pathPrefix(tree, c.id)}</span>}
                            {c.name}
                          </span>
                          {offer && (
                            <span className="why">
                              <Icon icon={Sparkle} size={12} />
                              {t("triage.suggested")}
                            </span>
                          )}
                        </button>
                      );
                      return offer ? (
                        <Hint key={c.id} label={why}>
                          {chip}
                          <span id={whyId} hidden>
                            {why}
                          </span>
                        </Hint>
                      ) : (
                        chip
                      );
                    })}
                  {tagging ? (
                    <TagField
                      label={t("triage.tagLabel")}
                      placeholder={t("triage.tagPlaceholder")}
                      inputClassName="field h-[34px] w-[180px] rounded-full px-3.5 text-sm"
                      onAdd={(name) => (setTagging(false), void tag(name))}
                      onClose={() => setTagging(false)}
                    />
                  ) : (
                    <button type="button" onClick={() => setTagging(true)} className="sort-chip ghost">
                      <span className="num">T</span>
                      <Icon icon={Tag} size={14} />
                      {t("triage.tag")}
                    </button>
                  )}
                  {(current.tags ?? []).map((name) => (
                    <span key={name} className="sort-tag" data-user-text>
                      #{name}
                    </span>
                  ))}
                </div>
              </div>

              <p className="sort-keys">
                {(
                  [
                    ["Z", t("triage.keyUndo")],
                    ["Space", t("triage.keyOpen")],
                    ["E", t("triage.keyEdit")],
                    ["F", t("triage.keyFavorite")],
                  ] as const
                ).map(([key, what]) => (
                  <span key={key}>
                    <kbd className="sort-cap font-sans">{key}</kbd>
                    {what}
                  </span>
                ))}
              </p>
            </>
          ) : (
            done && (
              // The end: what was decided, back to the library or undo the last.
              <div className="sort-done">
                <span className="sort-ring" aria-hidden>
                  <svg width={34} height={34} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                </span>
                <h2 className="mt-1.5 text-[26px] leading-8 font-bold tracking-[-0.02em]">{t("triage.done")}</h2>
                <p className="text-md text-muted">{sum.count > 0 ? t("triage.decided", { count: sum.count }) : t("triage.nothingDecided")}</p>
                <div className="sort-stats">
                  {(
                    [
                      [sum.kept, t("triage.statKept")],
                      [sum.filed, t("triage.statFiled")],
                      [sum.trashed, t("triage.statTrashed")],
                    ] as const
                  ).map(([n, what]) => (
                    <div key={what} className="sort-stat">
                      <b>{n}</b>
                      <span>{what}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-2.5 flex flex-wrap justify-center gap-2">
                  <button type="button" onClick={onLibrary} className="sort-btn ink">
                    {t("triage.toLibrary")}
                    <kbd className="sort-cap font-sans">Enter</kbd>
                  </button>
                  {queue.steps.length > 0 && (
                    <button type="button" onClick={() => void undo()} className="sort-btn">
                      <Icon icon={Undo2} />
                      {t("triage.undoLast")}
                      <kbd className="sort-cap font-sans">Z</kbd>
                    </button>
                  )}
                </div>
                <p className="mt-1 text-xs text-subtle">{t("triage.doneHint")}</p>
              </div>
            )
          )}
        </div>
      </div>

      {/* The last decision and «Undo Z»; it steps aside while the app has a notice there. */}
      {last && !done && !noticeUp && (
        <div key={`toast-${queue.steps.length}`} role="status" data-undo-toast className="sort-toast">
          <span className="what">
            <span className="line">
              <span className="shrink-0">{t("triage.toastWhat", { what: lastWhat })}</span>
              {" "}
              <span className="title" data-user-text>
                {queue.items[last.id]?.title || last.title}
              </span>
            </span>
            {last.kind === "trash" && <span className="note">{t("triage.trashNote")}</span>}
          </span>
          <button type="button" onClick={() => void undo()}>
            <Icon icon={Undo2} />
            {t("triage.undo")}
            <kbd className="sort-cap font-sans">Z</kbd>
          </button>
        </div>
      )}
    </section>
  );
}
