import { ReactNode, useEffect, useId, useRef, useState } from "react";
import { Check, Folder, Heart, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../services/api";
import { collectionColor } from "../../services/collections";
import { describeError, reasonOf, toCommandError } from "../../services/errors";
import { browserName, collectionKeys, nextWaiting, savedDay, Step, summary, waiting } from "../../services/triage";
import { short, undoNotice } from "../../services/undo";
import { Bookmark, BookmarkPage, Changed, Collection, PageCursor, Suggestion } from "../../types";
import { Icon } from "../icons";
import { Banner } from "../ui/Notices";
import { Button } from "../ui/Button";
import { Hint, Kbd } from "../ui/Hint";
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

/** Collections 1–9: the first nine in sidebar order (frame 19, no suggestion until NP-026). */
const KEYS = 9;
/** «Дальше»: the next four, fading (frame 03). */
const UP_NEXT = [1, 1, 0.6, 0.35];
/** «Только что»: the last decisions. */
const JUST_NOW = 5;

/** A key on a button: `←`, `→`, `F`, the collection number. */
function KeyChip({ children, className = "bg-secondary text-muted" }: { children: ReactNode; className?: string }) {
  return (
    <span aria-hidden className={`flex h-5 min-w-5 items-center justify-center rounded-xs px-1.5 text-xs font-semibold ${className}`}>
      {children}
    </span>
  );
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
}) {
  const { t, i18n } = useTranslation();
  const [queue, setQueue] = useState<Queue | null>(null);
  const [loadError, setLoadError] = useState("");
  const [tagging, setTagging] = useState(false);
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

  const record = (kind: Step["kind"], { bookmark, command }: Changed, advance: boolean, collectionId: number | null = null) =>
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
      if (kind === "tag") notify({ text: t("triage.tagAdded", { tag: changed.bookmark.tags?.at(-1) ?? "" }) });
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
  const tag = (name: string) =>
    decide("tag", (b) => api.updateBookmark(b.id, { tags: [...(b.tags ?? []).filter((t) => t !== name), name] }), false);
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
      <div className="px-8 pt-2">
        <Banner action={<Button variant="onDanger" onClick={() => void load()}>{t("common.retry")}</Button>}>{loadError}</Banner>
      </div>
    );
  if (!queue) return null;

  const total = queue.ids.length;
  const number = Math.min(queue.position + 1, total);
  const waitingNext = queue.ids.slice(queue.position + 1).filter((id) => waiting(queue.items[id]));
  const decided = queue.steps.filter((s) => s.advanced).reverse();
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
    if (browser) return t("triage.savedFrom", { when, browser });
    if (b.source === "app") return t("triage.addedByHand", { when });
    if (b.source === "import") return t("triage.imported", { when });
    if (b.source === "extension") return t("triage.savedFromBrowser", { when });
    return t("triage.saved", { when });
  };

  return (
    <section aria-label={t("triage.title")} className="flex min-h-0 flex-1 flex-col">
      <header className="px-8 pt-2">
        <div className="flex h-9 items-center justify-between gap-4">
          <h1 className="flex min-w-0 items-baseline gap-2 text-2xl font-semibold">
            {t("triage.title")}
            <span className="text-md font-normal text-subtle" aria-live="polite">
              {t("triage.progress", { current: number, total })}
            </span>
            {queue.fresh > 0 && <span className="text-xs font-medium text-accent">{t("triage.fresh", { count: queue.fresh })}</span>}
          </h1>
          <button
            type="button"
            onClick={onFinish}
            className="flex h-[33px] shrink-0 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium transition-colors duration-150 hover:bg-hover"
          >
            {t("triage.finish")}
            <Kbd>Esc</Kbd>
          </button>
        </div>
        <div className="mt-3.5 h-1 overflow-hidden rounded-xs bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done ? total : number} aria-label={t("triage.title")}>
          <div className="h-full rounded-xs bg-accent transition-[width] duration-200" style={{ width: `${total ? ((done ? total : number) / total) * 100 : 100}%` }} />
        </div>
      </header>

      <div className="@container min-h-0 flex-1 overflow-y-auto px-8 pt-8 pb-8">
        <div className="mx-auto flex max-w-[1064px] gap-12">
          <div className="min-w-0 max-w-[672px] flex-1">
            {current ? (
              <>
                <article data-triage-card={current.id} className="overflow-hidden rounded-3xl border border-divider bg-card">
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden
                    onClick={() => onOpen(current.url)}
                    // 280 px as in frame 03; a low window keeps the decisions on screen.
                    className="block h-[clamp(140px,calc(100dvh_-_430px),280px)] w-full overflow-hidden bg-hover"
                  >
                    <Preview b={current} mark={32} />
                  </button>
                  <div className="flex flex-col gap-2 px-6 pt-5 pb-[22px]">
                    <p className="flex min-w-0 items-center gap-1.5 text-xs">
                      <SiteMark b={current} />
                      <span className="shrink-0 font-medium text-icon">{current.domain}</span>
                      <span className="truncate text-subtle">· {saved(current)}</span>
                    </p>
                    <h2 className="line-clamp-2 text-xl leading-[26px] font-semibold" title={current.title}>
                      {current.title || current.url}
                    </h2>
                    {current.description && <p className="line-clamp-2 text-md leading-5 text-muted">{current.description}</p>}
                  </div>
                </article>

                <div className="mt-4 grid h-[52px] grid-cols-[minmax(0,210fr)_minmax(0,342fr)_96px] gap-3 text-md font-semibold">
                  <button
                    type="button"
                    onClick={() => void trash()}
                    className="flex items-center justify-center gap-2.5 rounded-xl border border-border bg-card transition-colors duration-150 hover:bg-hover"
                  >
                    <KeyChip>←</KeyChip>
                    <Icon icon={Trash2} />
                    <span className="truncate">{t("triage.trash")}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void keep()}
                    className="flex items-center justify-center gap-2.5 rounded-xl bg-accent text-on-accent transition-opacity duration-150 hover:opacity-90"
                  >
                    <Icon icon={Check} strokeWidth={2} />
                    {t("triage.keep")}
                    <KeyChip className="bg-white/20">→</KeyChip>
                  </button>
                  <button
                    type="button"
                    aria-label={current.is_favorite ? t("card.unfavorite") : t("card.favorite")}
                    aria-pressed={current.is_favorite}
                    onClick={() => void favorite()}
                    className="flex items-center justify-center gap-2 rounded-xl border border-border bg-card transition-colors duration-150 hover:bg-hover"
                  >
                    <Icon icon={Heart} className={current.is_favorite ? "fill-accent text-accent" : "text-icon"} />
                    <KeyChip>F</KeyChip>
                  </button>
                </div>

                <p className="mt-[22px] text-xs text-subtle">{t("triage.fileHint")}</p>
                <div data-keys className="mt-2 flex min-h-7 flex-wrap gap-2">
                  {keysReady && keys.map((c, i) => {
                    // Frame 03: the suggestion leads under key 1, its reason in the hint (NP-026).
                    const offer = i === 0 && suggested?.collection_id === c.id ? suggested : null;
                    const offered = !!offer;
                    const chip = (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => void file(c)}
                        aria-pressed={current.collection_id === c.id}
                        aria-describedby={offered ? whyId : undefined}
                        data-suggested={offered || undefined}
                        className={`flex h-7 items-center gap-2 rounded-lg pr-2.5 pl-1.5 text-sm transition-colors duration-150 aria-pressed:outline aria-pressed:outline-accent ${offered ? "border border-suggested bg-accent-soft pl-[5px]" : "bg-secondary hover:bg-hover"}`}
                      >
                        <KeyChip className={`h-[18px] min-w-[18px] bg-card text-2xs ${offered ? "text-accent" : "text-muted"}`}>{i + 1}</KeyChip>
                        <span className="size-[7px] rounded-full" style={{ background: collectionColor(c.id) }} />
                        <span className={offered ? "font-medium text-on-accent-soft" : ""}>{c.name}</span>
                        {offered && <span className="text-2xs text-accent-muted">{t("triage.suggested")}</span>}
                      </button>
                    );
                    return offer ? (
                      <Hint key={c.id} label={t("triage.suggestedWhy", { domain: current.domain, name: c.name, count: offer.count, filed: offer.filed })}>
                        {chip}
                        <span id={whyId} hidden>
                          {t("triage.suggestedWhy", { domain: current.domain, name: c.name, count: offer.count, filed: offer.filed })}
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
                      inputClassName="field h-7 w-[180px] rounded-lg px-2.5 text-sm"
                      onAdd={(name) => (setTagging(false), void tag(name))}
                      onClose={() => setTagging(false)}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setTagging(true)}
                      className="flex h-7 items-center gap-2 rounded-lg border border-border pr-2.5 pl-[7px] text-sm text-muted transition-colors duration-150 hover:bg-hover"
                    >
                      <KeyChip className="h-[18px] min-w-[18px] bg-secondary text-2xs text-muted">T</KeyChip>
                      {t("triage.tag")}
                    </button>
                  )}
                  {(current.tags ?? []).map((name) => (
                    <span key={name} className="flex h-7 items-center rounded-lg px-1.5 text-xs text-subtle">
                      #{name}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-xs text-faint">{t("triage.keys")}</p>
              </>
            ) : (
              done && (
                // Frame 23: what was decided, back to the library or undo the last.
                <div className="mx-auto flex max-w-[480px] flex-col items-center pt-[108px] text-center">
                  <span className="flex size-14 items-center justify-center rounded-full bg-secondary text-accent">
                    <Icon icon={Check} size={20} strokeWidth={1.75} />
                  </span>
                  <h2 className="mt-5 text-xl font-semibold">{t("triage.done")}</h2>
                  <p className="mt-2 text-sm text-muted">
                    {sum.count > 0 ? t("triage.summary", { count: sum.count, kept: sum.kept, filed: sum.filed, trashed: sum.trashed }) : t("triage.nothingDecided")}
                  </p>
                  <div className="mt-6 flex flex-wrap justify-center gap-2">
                    <button
                      type="button"
                      onClick={onLibrary}
                      className="flex h-9 w-[184px] items-center justify-center gap-2 rounded-lg bg-accent text-sm font-semibold text-on-accent transition-opacity duration-150 hover:opacity-90"
                    >
                      {t("triage.toLibrary")}
                      <span aria-hidden className="rounded-xs bg-white/20 px-1.5 text-2xs font-normal">
                        Enter
                      </span>
                    </button>
                    {queue.steps.length > 0 && (
                      <button
                        type="button"
                        onClick={() => void undo()}
                        className="flex h-9 w-[184px] items-center justify-center gap-2 rounded-lg bg-secondary text-sm font-medium transition-colors duration-150 hover:bg-hover"
                      >
                        {t("triage.undoLast")}
                        <span aria-hidden className="rounded-xs bg-card px-1.5 text-2xs text-meta">
                          Z
                        </span>
                      </button>
                    )}
                  </div>
                  <p className="mt-5 text-xs text-subtle">{t("triage.doneHint")}</p>
                </div>
              )
            )}
          </div>

          <aside className="hidden w-[344px] shrink-0 flex-col gap-1.5 @min-[816px]:flex">
            {!done && waitingNext.length > 0 && (
              <>
                <h3 className="mb-1.5 flex items-baseline gap-2 px-1 text-xs font-semibold">
                  {t("triage.upNext")}
                  <span className="font-normal text-subtle">{waitingNext.length}</span>
                </h3>
                <ul className="flex flex-col gap-1.5">
                  {waitingNext.slice(0, UP_NEXT.length).map((id, i) => {
                    const b = queue.items[id];
                    return (
                      <li key={id} style={{ opacity: UP_NEXT[i] }} className="flex h-[46px] items-center gap-3 px-1">
                        <span className="h-[34px] w-12 shrink-0 overflow-hidden rounded-[5px] bg-hover">
                          <Preview b={b} mark={14} />
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-sm font-medium">{b.title || b.url}</span>
                          <span className="truncate text-2xs text-subtle">{b.domain}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <div className="my-1.5 h-px bg-line" />
              </>
            )}
            <div className="flex h-[31px] items-center justify-between px-1">
              <h3 className="text-xs font-semibold">{t("triage.justNow")}</h3>
              {queue.steps.length > 0 && (
                <button type="button" onClick={() => void undo()} className="flex items-center gap-1.5 rounded-xs text-xs font-medium text-accent hover:underline">
                  {t("triage.undo")}
                  <span aria-hidden>Z</span>
                </button>
              )}
            </div>
            <ul className="flex flex-col gap-1.5">
              {decided.slice(0, JUST_NOW).map((step, i) => {
                const collection = step.kind === "trash" ? undefined : collections.find((c) => c.id === step.collectionId);
                return (
                  <li key={`${step.id}-${decided.length - i}`} className="flex h-[27px] items-center gap-2.5 px-1.5 text-sm">
                    {step.kind === "trash" ? (
                      <Icon icon={Trash2} size={14} className="shrink-0 text-subtle" />
                    ) : collection ? (
                      <Icon icon={Folder} size={14} className="shrink-0" style={{ color: collectionColor(collection.id) }} />
                    ) : (
                      <Icon icon={Check} size={14} strokeWidth={1.75} className="shrink-0 text-[var(--np-green)]" />
                    )}
                    <span className={`min-w-0 flex-1 truncate text-muted ${step.kind === "trash" ? "line-through" : ""}`}>{step.title}</span>
                    <span
                      className={`shrink-0 text-2xs ${step.kind === "trash" ? "text-meta" : collection ? "" : "text-[var(--np-green)]"}`}
                      style={collection ? { color: collectionColor(collection.id) } : undefined}
                    >
                      {step.kind === "trash" ? t("triage.trashed") : collection ? `→ ${collection.name}` : t("triage.kept")}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="mt-1.5 rounded-xl bg-secondary px-3.5 py-3 text-xs">
              <p className="font-medium text-icon">{t("triage.trashNote")}</p>
              <p className="mt-1 text-subtle">{t("triage.trashNoteHint")}</p>
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}
