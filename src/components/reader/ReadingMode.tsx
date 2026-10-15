import { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, BookOpen, ChevronDown, Menu as MenuIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Bookmark } from "../../types";
import { composing } from "../../services/ime";
import { cachedArticle, knownMinutes } from "../../services/reader";
import { useReadingList } from "../../hooks/useReadingList";
import { useReadingProgress } from "../../hooks/useReadingProgress";
import { Icon } from "../icons";
import { Button } from "../ui/Button";
import { Hint, Kbd } from "../ui/Hint";
import { Menu } from "../ui/Menu";
import { WindowBar } from "../ui/WindowBar";
import { ArticleStatus, ArticleView, failureText } from "./ArticleView";

/** What the queue reads: Reading (the default) or the section the library shows. */
export type ReadingSource = "reading" | "section";

/** The current section of the library as the queue reads it: its name and loaded bookmarks. */
export interface SectionQueue {
  name: string;
  /** The section is Reading itself: the switch has nothing to offer. */
  reading: boolean;
  /** The trash is never read as a queue. */
  available: boolean;
  items: Bookmark[];
  hasMore: boolean;
  onMore: () => void;
}

/** The drop spreads over ≈ 200 ms (Р-69, point 1); with reduced motion the mode fades in 150 ms. */
const DROP_MS = 200;
const FADE_MS = 150;
/** Close to the end of a section's loaded bookmarks the next page is asked for. */
const MORE_AHEAD = 3;

const keyIs = (e: KeyboardEvent, letter: string) => e.code === `Key${letter.toUpperCase()}` || e.key.toLowerCase() === letter;

/**
 * The reading mode (NP-122, Р-69 point 1, frames B1–B9): the queue on the left,
 * the article in a column of 640 px, «Open in browser ↗» and «Read» on top, a
 * progress line. It drops from the toolbar's «Read» as a circle in the mode's
 * colour and folds back into it. `J`/`K` go through the queue, `O` opens the
 * page in the browser, `Esc` goes to the queue and from there to the library,
 * which waits underneath as it was. An article that cannot be shown leaves a
 * card with the browser, the next one and «Mark as read», never an empty column.
 */
export function ReadingMode({
  narrow,
  origin,
  source: initialSource,
  start,
  section,
  onOpen,
  onMarkRead,
  onClose,
}: {
  narrow: boolean;
  /** Where the drop starts and folds back: the centre of the toolbar's «Read». */
  origin: () => { x: number; y: number } | null;
  source: ReadingSource;
  /** The bookmark to begin with (a link followed into the mode); otherwise the first unread one. */
  start: number | null;
  section: SectionQueue;
  onOpen: (url: string) => void;
  onMarkRead: (bookmark: Bookmark) => void;
  /** The mode folded back: the library takes over. */
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const layer = useRef<HTMLDivElement>(null);
  const queueRef = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<ReadingSource>(section.reading ? "section" : initialSource);
  const reading = useReadingList(source === "reading");
  const live = source === "reading" ? reading.items : section.items;
  /** The order the queue had when it was opened: an article read meanwhile does not jump to the bottom. */
  const [order, setOrder] = useState<number[] | null>(null);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const lastIndex = useRef(0);
  const [status, setStatus] = useState<{ id: number; status: ArticleStatus } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [queueOpen, setQueueOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);

  const items = useMemo(() => {
    if (!live || !order) return null;
    const byId = new Map(live.map((b) => [b.id, b]));
    const known = new Set(order);
    return [...order.flatMap((id) => byId.get(id) ?? []), ...live.filter((b) => !known.has(b.id))];
  }, [live, order]);

  useEffect(() => {
    if (live && order === null) setOrder(live.map((b) => b.id));
  }, [live, order]);

  // The first one to read, and a new current one when the current left the queue (removed elsewhere).
  useEffect(() => {
    if (!items || (currentId !== null && items.some((b) => b.id === currentId))) return;
    if (!items.length) return setCurrentId(null);
    if (currentId === null) {
      const first = items.find((b) => b.id === start) ?? (source === "reading" ? items.find((b) => !b.read_at) : null) ?? items[0];
      setCurrentId(first.id);
    } else setCurrentId(items[Math.min(lastIndex.current, items.length - 1)].id);
  }, [items, currentId, start, source]);

  const index = items && currentId !== null ? items.findIndex((b) => b.id === currentId) : -1;
  if (index >= 0) lastIndex.current = index;
  const current = index >= 0 ? items![index] : null;
  const next = items && index >= 0 ? (items[index + 1] ?? null) : null;
  const previous = items && index > 0 ? items[index - 1] : null;

  // The section's queue reads on as it nears the end of what the library has loaded.
  useEffect(() => {
    if (source === "section" && items && index >= items.length - MORE_AHEAD && section.hasMore) section.onMore();
  }, [source, index, items, section]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const currentStatus = current && status?.id === current.id ? status.status : null;
  const failed = currentStatus?.kind === "failed" ? currentStatus.failure : undefined;
  const offline = failed !== undefined && !online && (failed?.reason === "network" || failed?.reason === "timeout");
  // Back online: the page that could not load is asked for again by itself.
  useEffect(() => {
    if (online && failed && (failed.reason === "network" || failed.reason === "timeout")) setAttempt((n) => n + 1);
    // Only the change of the connection, not every failure.
  }, [online]);

  // The next article is read ahead once the current one has settled, so `J` shows it at once
  // (owner, 2026-10-15): only the next one, never the whole queue, and only while the mode is open.
  const settled = currentStatus !== null && currentStatus.kind !== "loading";
  useEffect(() => {
    if (settled && next && online) void cachedArticle(next.url).catch(() => {});
  }, [settled, next?.url, online]);

  const show = useCallback((id: number, focus: "article" | "queue" = "article") => {
    setCurrentId(id);
    setAttempt(0);
    if (focus === "queue") queueRef.current?.querySelector<HTMLElement>(`[data-queue-item="${id}"]`)?.focus();
    else if (focus === "article") {
      setQueueOpen(false);
      requestAnimationFrame(() => scroller.current?.focus({ preventScroll: true }));
    }
  }, []);

  // The drop: a circle from the toolbar's «Read» to the farthest corner; a fade with reduced motion.
  const drop = useCallback(
    (direction: "in" | "out", done?: () => void) => {
      const element = layer.current;
      if (!element || typeof element.animate !== "function") return done?.();
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      element.dataset.drop = reduce ? "fade" : "circle";
      let frames: Keyframe[];
      if (reduce) frames = [{ opacity: 0 }, { opacity: 1 }];
      else {
        const { innerWidth: w, innerHeight: h } = window;
        const { x, y } = origin() ?? { x: w - 60, y: 40 };
        const radius = Math.ceil(Math.hypot(Math.max(x, w - x), Math.max(y, h - y)));
        frames = [{ clipPath: `circle(0px at ${x}px ${y}px)` }, { clipPath: `circle(${radius}px at ${x}px ${y}px)` }];
      }
      if (direction === "out") frames.reverse();
      const animation = element.animate(frames, {
        duration: reduce ? FADE_MS : DROP_MS,
        easing: reduce ? "linear" : direction === "in" ? "cubic-bezier(0, 0, 0.2, 1)" : "cubic-bezier(0.4, 0, 1, 1)",
        fill: direction === "out" ? "forwards" : "none",
      });
      if (done) animation.onfinish = () => done();
    },
    [origin],
  );
  useLayoutEffect(() => {
    drop("in");
    scroller.current?.focus({ preventScroll: true });
  }, []);
  const leave = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    drop("out", onClose);
  }, [leaving, drop, onClose]);

  // At once when the queue is on screen, so the next key already lands in it; a narrow window opens it first.
  const focusQueue = () => {
    const focus = () => {
      const list = queueRef.current;
      (list?.querySelector<HTMLElement>("[aria-current=true]") ?? list?.querySelector<HTMLElement>("[data-queue-item], button"))?.focus();
    };
    if (queueRef.current) return focus();
    setQueueOpen(true);
    requestAnimationFrame(focus);
  };

  const latest = useRef({ current, next, previous, leave, focusQueue, show, queueOpen, onOpen, leaving });
  latest.current = { current, next, previous, leave, focusQueue, show, queueOpen, onOpen, leaving };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const s = latest.current;
      if (composing(e) || e.defaultPrevented || s.leaving) return;
      // A menu open in the mode (the source switch) or a dialog over it (Ctrl N) takes its own keys.
      if (document.querySelector("[data-menu], dialog[open]")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (target.closest?.("input, textarea, [contenteditable=true]")) return;
      const inQueue = !!queueRef.current?.contains(target);
      if (e.key === "Escape") {
        e.preventDefault();
        if (inQueue || s.queueOpen) s.leave();
        else s.focusQueue();
        return;
      }
      if (e.repeat && !(keyIs(e, "j") || keyIs(e, "k"))) return;
      const focus = inQueue ? "queue" : "article";
      if (keyIs(e, "j") && s.next) {
        e.preventDefault();
        s.show(s.next.id, focus);
      } else if (keyIs(e, "k") && s.previous) {
        e.preventDefault();
        s.show(s.previous.id, focus);
      } else if (keyIs(e, "o") && s.current) {
        e.preventDefault();
        s.onOpen(s.current.url);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const unread = items?.filter((b) => !b.read_at) ?? [];
  const queue = (
    <Queue
      ref={queueRef}
      items={items}
      current={current}
      status={currentStatus}
      offline={offline}
      unread={unread.length}
      source={source}
      section={section}
      onSource={(next) => {
        if (next === source) return;
        setSource(next);
        setOrder(null);
        setCurrentId(null);
        lastIndex.current = 0;
      }}
      onPick={(id) => show(id)}
    />
  );
  const empty = items !== null && items.length === 0;

  return (
    <div
      ref={layer}
      data-reading-mode
      role="region"
      aria-label={t("readingMode.label")}
      className="reading-mode fixed inset-0 z-40 flex bg-read text-read-text"
    >
      {!narrow && queue}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* A frameless window keeps its strip and buttons above the article, as above the library. */}
        <WindowBar />
        <div className="relative flex min-h-0 flex-1 flex-col">
        {current && (
          <ProgressLine key={current.id} bookmark={current} status={currentStatus} scroller={scroller} />
        )}
        <div className={`flex shrink-0 items-start gap-2 ${narrow ? "h-[66px] px-4 pt-4" : "h-[68px] px-[30px] pt-[17px]"}`}>
          {narrow && !empty && (
            <Button
              variant="outline"
              size="lg"
              aria-expanded={queueOpen}
              onClick={() => (queueOpen ? setQueueOpen(false) : focusQueue())}
              className="text-read-text"
            >
              <Icon icon={MenuIcon} size={14} />
              {t("readingMode.queueButton", { count: unread.length })}
            </Button>
          )}
          <span className="flex-1" />
          {/* The Aa panel (themes, size, fonts) comes with NP-124. */}
          <span data-reader-aa hidden />
          {current &&
            (narrow ? (
              <Hint label={t("reader.openInBrowser")}>
                <button
                  type="button"
                  aria-label={t("reader.openInBrowser")}
                  onClick={() => onOpen(current.url)}
                  className="flex size-[34px] items-center justify-center rounded-lg border border-read-border text-read-text transition-colors duration-150 hover:bg-read-track"
                >
                  <Icon icon={ArrowUpRight} size={15} />
                </button>
              </Hint>
            ) : (
              <Button variant="outline" size="lg" onClick={() => onOpen(current.url)} className="rounded-lg text-read-text">
                {t("reader.openInBrowser")}
                <Icon icon={ArrowUpRight} size={13} />
              </Button>
            ))}
          <Button variant="primary" size="lg" aria-pressed onClick={leave} className={`rounded-lg ${narrow ? "min-w-[88px]" : "ml-6"}`}>
            {!narrow && <Icon icon={BookOpen} size={15} />}
            {t("readingMode.read")}
          </Button>
        </div>
        <div ref={scroller} tabIndex={-1} data-reader-scroll className={`min-h-0 flex-1 overflow-y-auto outline-none ${narrow ? "px-6 pt-3.5" : "px-8 pt-7"} pb-24`}>
          {current ? (
            <ArticleView
              key={current.id}
              url={current.url}
              title={current.title || current.url}
              domain={current.domain}
              saved={current.created_at}
              attempt={attempt}
              onOpen={onOpen}
              onStatus={(next) => setStatus({ id: current.id, status: next })}
              onReady={() => restore(scroller, current)}
              failure={(failure) => (
                <Card
                  title={offline ? t("readingMode.offlineTitle") : t("readingMode.failedTitle")}
                  text={
                    offline
                      ? t("readingMode.offlineText", { site: current.domain })
                      : `${failureText(failure, t)} ${t("readingMode.failedTail")}`
                  }
                  offline={offline}
                >
                  {offline ? (
                    <Button variant="primary" size="lg" onClick={() => setAttempt((n) => n + 1)}>
                      {t("common.retry")}
                    </Button>
                  ) : (
                    <>
                      <Button variant="primary" size="lg" onClick={() => onOpen(current.url)}>
                        {t("reader.openInBrowser")}
                        <Icon icon={ArrowUpRight} size={13} />
                      </Button>
                      {next && (
                        <Button variant="outline" size="lg" onClick={() => show(next.id)} className="bg-read text-read-text">
                          {t("readingMode.next")}
                          <Kbd className="bg-transparent text-read-muted">J</Kbd>
                        </Button>
                      )}
                      {!current.read_at && (
                        <Button
                          variant="ghost"
                          size="lg"
                          onClick={() => {
                            onMarkRead(current);
                            if (next) show(next.id);
                          }}
                          className="text-read-text"
                        >
                          {t("readingMode.markRead")}
                        </Button>
                      )}
                    </>
                  )}
                </Card>
              )}
            />
          ) : (
            empty && (
              <div data-reading-empty className="mx-auto flex max-w-[400px] flex-col items-center pt-[calc(18vh)] text-center">
                <Icon icon={BookOpen} size={32} strokeWidth={1.25} className="text-read-muted" />
                <h2 className="read-serif mt-6 text-[30px] leading-[38px] font-semibold text-read-ink">
                  {source === "reading" ? t("readingMode.empty") : t("readingMode.emptySection", { section: section.name })}
                </h2>
                {source === "reading" && <p className="mt-3 text-sm text-read-text/80">{t("readingMode.emptyHint")}</p>}
                <Button variant="outline" size="lg" onClick={leave} className="mt-5 bg-read-card text-read-text">
                  {t("readingMode.back")}
                </Button>
              </div>
            )
          )}
        </div>
        </div>
      </div>
      {narrow && queueOpen && (
        <div className="absolute inset-0 z-10 flex">
          <div className="flex h-full animate-appear shadow-menu">{queue}</div>
          <button type="button" aria-label={t("common.close")} tabIndex={-1} className="flex-1 bg-scrim" onClick={() => setQueueOpen(false)} />
        </div>
      )}
    </div>
  );
}

/** Where reading stopped: the article, once on the page, scrolls there. */
function restore(scroller: RefObject<HTMLDivElement | null>, b: Bookmark) {
  const element = scroller.current;
  if (element && b.reading_progress > 0 && b.reading_progress < 1)
    element.scrollTo({ top: b.reading_progress * (element.scrollHeight - element.clientHeight) });
}

/**
 * The line along the top of the article (frame B3): how far it is read, saved
 * through `useReadingProgress`; a running segment while the page loads (B4).
 */
function ProgressLine({ bookmark, status, scroller }: { bookmark: Bookmark; status: ArticleStatus | null; scroller: RefObject<HTMLDivElement | null> }) {
  const loading = status === null || status.kind === "loading";
  const [ready, setReady] = useState(false);
  // The article is on the page and scrolled where reading stopped: from here on scrolling counts.
  useEffect(() => {
    if (loading) return setReady(false);
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, [loading]);
  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [bookmark.id]);
  const progress = useReadingProgress(bookmark, scroller, ready);
  return (
    <div aria-hidden className="absolute inset-x-0 top-0 z-10 h-[3px] overflow-hidden bg-read-track">
      {status?.kind === "failed" ? null : loading ? (
        <div data-reading-running className="read-running h-full w-1/5 bg-accent/70" />
      ) : (
        <div data-reading-progress className="h-full bg-accent" style={{ width: `${Math.round(progress * 100)}%` }} />
      )}
    </div>
  );
}

/** The card of frames B5 and B6, where the article would be. */
function Card({ title, text, offline, children }: { title: string; text: string; offline: boolean; children: ReactNode }) {
  return (
    <div
      data-reader-failure={offline ? "offline" : "failed"}
      role="alert"
      className="mx-auto mt-[136px] max-w-[560px] rounded-[14px] border border-read-border bg-read-card px-8 pt-7 pb-8"
    >
      <h2 className="read-serif text-[22px] leading-[28px] font-semibold text-read-ink">{title}</h2>
      <p className="mt-2 text-sm leading-[21px] text-read-text/80">{text}</p>
      <div className={`flex flex-wrap items-center gap-2.5 ${offline ? "mt-5" : "mt-8"}`}>{children}</div>
    </div>
  );
}

/**
 * The queue (frame B3): what reads next, a switch between Reading and the
 * library's section, each item with its site, minutes and progress, the read
 * ones dimmed. `↑`/`↓` move between items, `Enter` reads one.
 */
const Queue = function Queue({
  ref,
  items,
  current,
  status,
  offline,
  unread,
  source,
  section,
  onSource,
  onPick,
}: {
  ref: RefObject<HTMLDivElement | null>;
  items: Bookmark[] | null;
  current: Bookmark | null;
  status: ArticleStatus | null;
  offline: boolean;
  unread: number;
  source: ReadingSource;
  section: SectionQueue;
  onSource: (source: ReadingSource) => void;
  onPick: (id: number) => void;
}) {
  const { t } = useTranslation();
  const switcher = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const name = source === "reading" ? t("nav.reading") : section.name;
  const switchable = !section.reading && section.available;
  const read = (items?.length ?? 0) - unread;
  const minutes = items?.filter((b) => !b.read_at).map((b) => knownMinutes(b.url));
  const allKnown = !!minutes?.length && minutes.every((m) => m !== null);
  const summary = !items
    ? ""
    : items.length === 0
      ? t("readingMode.nothing")
      : [
          t("readingMode.toRead", { count: unread }),
          allKnown && t("readingMode.about", { count: minutes!.reduce((sum, m) => sum + m!, 0) }),
          read > 0 && t("readingMode.readCount", { count: read }),
        ]
          .filter(Boolean)
          .join(" · ");

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const buttons = [...(ref.current?.querySelectorAll<HTMLElement>("[data-queue-item]") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    const to = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : at + (e.key === "ArrowDown" ? 1 : -1);
    buttons[Math.max(0, Math.min(buttons.length - 1, to))]?.focus();
  };

  return (
    <div ref={ref} data-reading-queue className="flex h-full w-[320px] shrink-0 flex-col border-r border-read-edge bg-read-queue">
      <div className="shrink-0 px-6 pt-[26px] pb-[17px]">
        <p className="text-2xs font-semibold tracking-[0.02em] text-read-muted uppercase">{t("readingMode.queue")}</p>
        {switchable ? (
          <button
            ref={switcher}
            type="button"
            aria-haspopup="menu"
            aria-expanded={!!menu}
            aria-label={t("readingMode.sourceLabel", { source: name })}
            onClick={() => setMenu(menu ? null : switcher.current!.getBoundingClientRect())}
            className="read-serif mt-[3px] flex max-w-full items-center gap-1.5 rounded-md text-[22px] leading-[30px] font-semibold text-read-ink"
          >
            <span className="truncate">{name}</span>
            <Icon icon={ChevronDown} size={14} className="mt-1 shrink-0" />
          </button>
        ) : (
          <h2 className="read-serif mt-[3px] truncate text-[22px] leading-[30px] font-semibold text-read-ink">{name}</h2>
        )}
        <p data-reading-summary className="h-[15px] text-xs leading-[15px] text-read-muted">
          {summary}
        </p>
      </div>
      {menu && (
        <Menu
          label={t("readingMode.source")}
          anchor={menu}
          width={240}
          trigger={switcher.current}
          onClose={() => setMenu(null)}
          entries={[
            { heading: t("readingMode.source") },
            { id: "source-reading", label: t("nav.reading"), radio: true, checked: source === "reading", onSelect: () => onSource("reading") },
            { id: "source-section", label: section.name, radio: true, checked: source === "section", onSelect: () => onSource("section") },
          ]}
        />
      )}
      <ol className="min-h-0 flex-1 overflow-y-auto" aria-label={name} onKeyDown={onKeyDown}>
        {items?.map((b) => {
          const isCurrent = b.id === current?.id;
          const minutesOf = knownMinutes(b.url);
          const state = isCurrent
            ? status === null || status.kind === "loading"
              ? t("readingMode.opening")
              : status.kind === "failed"
                ? offline
                  ? t("readingMode.waiting")
                  : `↗ ${t("readingMode.opensInBrowser")}`
                : null
            : null;
          const percent = !b.read_at && b.reading_progress > 0 ? Math.round(b.reading_progress * 100) : 0;
          const meta = [
            b.read_at && `✓ ${t("readingMode.done")}`,
            b.domain,
            state ?? (minutesOf !== null && t("readingMode.minutes", { count: minutesOf })),
            !state && percent > 0 && t("readingMode.percent", { percent }),
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <li key={b.id}>
              <button
                type="button"
                data-queue-item={b.id}
                data-read={b.read_at ? "true" : undefined}
                aria-current={isCurrent || undefined}
                onClick={() => onPick(b.id)}
                className={`relative flex w-full flex-col px-6 pt-3.5 text-left outline-offset-[-2px] transition-colors duration-150 ${isCurrent ? "h-20 bg-read-current" : "h-[72px] hover:bg-read-current/60"} ${b.read_at ? "text-read-dim" : ""}`}
              >
                {isCurrent && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent" />}
                <span
                  className={`read-serif w-full truncate text-[15px] leading-[23px] font-semibold ${b.read_at ? "" : isCurrent ? "text-read-ink" : "text-read-text"}`}
                >
                  {b.title || b.url}
                </span>
                <span className={`mt-px w-full truncate text-xs leading-[15px] ${b.read_at ? "" : "text-read-muted"}`}>{meta}</span>
                {isCurrent && (
                  <span aria-hidden className="mt-[9px] h-[3px] w-full overflow-hidden rounded-xs bg-read-edge">
                    <span className="block h-full rounded-xs bg-accent" style={{ width: `${Math.round((b.read_at ? 1 : b.reading_progress) * 100)}%` }} />
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
      {/* Each hint whole: a narrow line breaks between them, never inside one. */}
      <p className="flex shrink-0 flex-wrap gap-x-2.5 px-6 pt-3 pb-[25px] text-xs leading-[15px] text-read-muted">
        <span className="whitespace-nowrap">{t("readingMode.keys")}</span>
        <span aria-hidden>·</span>
        <span className="whitespace-nowrap">{t("readingMode.keysEsc")}</span>
      </p>
    </div>
  );
};
