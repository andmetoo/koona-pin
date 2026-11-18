import { CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { panelScrollInset } from "../shell/PageTitle";
import { ArrowUpRight, Heart } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Bookmark, OfflineCopy } from "../../types";
import { Article } from "../../services/reader";
import { useReadingProgress } from "../../hooks/useReadingProgress";
import { Icon } from "../icons";
import { Kbd } from "../ui/Hint";
import { ReaderLook, readerStyle } from "../../services/readerLook";
import { ArticleStatus, ArticleView, OfflineBanner } from "./ArticleView";
import { OfflineButton, useOfflineCopies } from "./OfflineButton";
import { useBack } from "../../platform/useBack";
import { reducedMotion } from "../../platform/motion";

/** The fall of the sheet as it closes: a little quicker than its rise (`--animate-sheet`, 200 ms). */
const SHEET_OUT_MS = 160;

/**
 * Reading over the list (Р-69 variant A, frame A): a sheet 760 px wide over
 * the dimmed library with the article of the selected bookmark. `↑`/`↓` go
 * through the selection, `Esc` or a click beside it closes it; focus returns
 * to where it was. «Open in browser» and the heart act on the bookmark shown;
 * «Save offline» keeps its article on this computer (NP-126).
 */
export function ReadingSheet({
  bookmarks,
  index,
  section,
  onIndex,
  onOpen,
  onFavorite,
  onClose,
  onSaveOffline,
  onRemoveOffline,
  look,
}: {
  /** The theme, font and size of the Aa panel (NP-124): the sheet reads as the mode does. */
  look: ReaderLook;
  /** What `↑`/`↓` go through: the selected in list order, or the one bookmark. */
  bookmarks: Bookmark[];
  index: number;
  /** The name of the section under the sheet: «Back to …». */
  section: string;
  onIndex: (index: number) => void;
  onOpen: (url: string) => void;
  onFavorite: (bookmark: Bookmark) => void;
  onClose: () => void;
  /** As the reading mode's (NP-126). */
  onSaveOffline: (bookmark: Bookmark, article?: Article, quiet?: boolean) => Promise<OfflineCopy | null>;
  onRemoveOffline: (bookmark: Bookmark) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const b = bookmarks[index];
  const [ready, setReady] = useState<number | null>(null);
  const progress = useReadingProgress(b, scroller, ready === b.id);
  const [status, setStatus] = useState<{ id: number; status: ArticleStatus } | null>(null);
  const shownStatus = status?.id === b.id ? status.status : null;
  /**
   * The page could not be read: the sheet becomes a card around the reason and «Open in browser».
   * It stays a card while ↑/↓ load the next one, and becomes the sheet again only for an article,
   * so going through pages that cannot be read does not grow and shrink it at each step.
   */
  const [compact, setCompact] = useState(false);
  if (shownStatus?.kind === "failed" && !compact) setCompact(true);
  else if (shownStatus?.kind === "article" && compact) setCompact(false);
  const panel = useRef<HTMLDivElement>(null);
  /** The card's height kept while the next one loads, so its shorter «Loading» does not shrink it. */
  const [hold, setHold] = useState<number | null>(null);
  if (hold !== null && shownStatus && shownStatus.kind !== "loading") setHold(null);
  // Card ⇄ sheet: from the size it had to the one it has, in pixels, so every engine eases it
  // (WebKit cannot ease `height` to `auto`). The size of each render is kept for the next. Only a
  // real change of shape moves it: not the opening, nor StrictMode running the effect twice.
  const lastBox = useRef<{ top: number; width: number; height: number } | null>(null);
  const shape = useRef(compact);
  useLayoutEffect(() => {
    const element = panel.current;
    const before = lastBox.current;
    if (shape.current === compact) return;
    shape.current = compact;
    if (!element || !before || leaving || reducedMotion()) return;
    const now = { top: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight };
    if (now.top === before.top && now.width === before.width && now.height === before.height) return;
    element.animate(
      [
        { top: `${before.top}px`, width: `${before.width}px`, height: `${before.height}px` },
        { top: `${now.top}px`, width: `${now.width}px`, height: `${now.height}px` },
      ],
      { duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    );
  }, [compact]);
  useLayoutEffect(() => {
    const element = panel.current;
    if (element) lastBox.current = { top: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight };
  });
  const [attempt, setAttempt] = useState(0);
  /** «Try live page»: the page itself, not the offline copy, until another bookmark shows. */
  const [livePage, setLivePage] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const offline = useOfflineCopies({
    onSave: onSaveOffline,
    onRemove: onRemoveOffline,
    // The list makes a new array each time: what counts is the copies it carries.
    reset: bookmarks.map((item) => `${item.id}:${item.offline_at}`).join(),
    onUpdated: () => {
      setLivePage(false);
      setAttempt((n) => n + 1);
    },
  });
  const latest = useRef({ index, count: bookmarks.length, onIndex, onClose, close: () => {} });
  /** The sheet goes as it came: it falls and fades with its scrim, then leaves the list's state. */
  const [leaving, setLeaving] = useState(false);
  const closing = useRef(false);
  const leaveTimer = useRef(0);
  const close = () => {
    if (closing.current) return;
    closing.current = true;
    if (reducedMotion()) return latest.current.onClose();
    // The fall starts where the rise is now: closed mid-rise, it does not jump up first.
    const element = dialog.current;
    const panel = element?.firstElementChild;
    if (element && panel) {
      const style = getComputedStyle(panel);
      element.style.setProperty("--sheet-from-opacity", style.opacity);
      element.style.setProperty("--sheet-from-y", `${style.transform === "none" ? 0 : new DOMMatrixReadOnly(style.transform).m42}px`);
      element.style.setProperty("--scrim-from-opacity", getComputedStyle(element, "::backdrop").opacity);
    }
    setLeaving(true);
    // The end of the fall closes it; the timer when the animation never ends (a hidden window).
    leaveTimer.current = window.setTimeout(() => latest.current.onClose(), SHEET_OUT_MS + 80);
  };
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
  latest.current = { index, count: bookmarks.length, onIndex, onClose, close };
  // A phone's Back closes it as Escape does (NP-151).
  useBack(() => latest.current.close());

  const shown = useRef(b.id);
  shown.current = b.id;
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = shown.current;
    const element = dialog.current!;
    element.showModal();
    scroller.current?.focus({ preventScroll: true });
    return () => {
      element.close();
      // After ↑/↓ the list continues from the one read last, as Space does; otherwise focus goes back.
      const last = shown.current !== first && document.querySelector<HTMLElement>(`[data-bookmark-id="${shown.current}"]`);
      if (last) last.focus();
      else previous?.focus({ preventScroll: true });
    };
  }, []);

  // Each bookmark starts at its top; the article, once loaded, where reading stopped.
  useLayoutEffect(() => {
    setReady(null);
    setLivePage(false);
    scroller.current?.scrollTo({ top: 0 });
  }, [b.id]);

  const restore = () => {
    const element = scroller.current;
    if (element && b.reading_progress > 0 && b.reading_progress < 1)
      element.scrollTo({ top: b.reading_progress * (element.scrollHeight - element.clientHeight) });
    setReady(b.id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const { index, count, onIndex } = latest.current;
    // Esc is taken here, not from `cancel`: Chromium skips the `cancel` of a second Esc after a
    // prevented one and closes the dialog itself, which would cut the fall. A menu or a picture
    // viewer inside keeps its own Esc.
    if (e.key === "Escape" && !e.defaultPrevented && (e.target as Element).closest("dialog") === e.currentTarget) {
      e.preventDefault();
      return latest.current.close();
    }
    // Falling, it is no longer the sheet: Enter or Space on its buttons and ↑/↓ do nothing. The
    // focus stays inside, so a second Esc still comes here and not to the browser's own close.
    if (leaving) return e.preventDefault();
    if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || count < 2 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    e.preventDefault();
    const next = index + (e.key === "ArrowDown" ? 1 : -1);
    if (next < 0 || next >= count) return;
    if (compact && panel.current) setHold(panel.current.offsetHeight);
    onIndex(next);
  };

  return (
    <dialog
      ref={dialog}
      aria-label={b.title || b.url}
      data-reading-sheet
      data-reader-look={look.theme}
      data-reader-font={look.font}
      data-leaving={leaving || undefined}
      style={{ ...readerStyle(look), "--sheet-out": `${SHEET_OUT_MS}ms` } as CSSProperties}
      // `overflow-hidden`: the sheet rising from 24 px below (and falling back) reaches past the
      // dialog's bottom; with the browser's `overflow: auto` the dialog grew a scrollbar for those
      // 200 ms and the centred sheet stood 4 px to the left, then jumped right as the rise ended.
      className="reading-sheet reading-look fixed inset-0 m-0 h-full max-h-none w-full max-w-none overflow-hidden bg-transparent p-0"
      onCancel={(e) => {
        e.preventDefault();
        latest.current.close();
      }}
      // Closed by the browser after all (a close request that skipped `cancel`): gone at once. A
      // `close` that comes late, the dialog open again (StrictMode's second mount), is not that.
      onClose={(e) => {
        if (!e.currentTarget.open) latest.current.onClose();
      }}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) latest.current.close();
      }}
    >
      <div
        // A page that cannot be read leaves a card, not a whole sheet of empty paper.
        ref={panel}
        data-compact={compact || undefined}
        style={hold !== null ? { minHeight: hold } : undefined}
        className={`reading-sheet-panel absolute inset-x-0 mx-auto flex max-w-[calc(100%-32px)] ${leaving ? "reading-sheet-out pointer-events-none" : "animate-sheet"} flex-col overflow-hidden bg-sheet text-sheet-ink shadow-[0_12px_40px_rgb(0_0_0/0.19)]`}
        // Falling, its heart, buttons and links take no late click (`pointer-events-none`); not
        // `inert`, which would push the focus out of the dialog and Esc to the browser.
        onClick={(e) => e.stopPropagation()}
        onAnimationEnd={(e) => {
          if (e.target !== e.currentTarget || e.animationName !== "reading-sheet-out") return;
          window.clearTimeout(leaveTimer.current);
          latest.current.onClose();
        }}
      >
        <div aria-hidden className="h-[3px] shrink-0 bg-sheet-line">
          <div data-reading-progress className="h-full rounded-r-xs bg-accent" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-sheet-line px-6">
          <button type="button" onClick={close} className="flex min-w-0 items-center gap-2.5 text-sm text-muted hover:text-ink">
            <Kbd className="shrink-0 border border-border bg-secondary px-2 text-2xs font-medium text-muted">Esc</Kbd>
            <span className="truncate">{t("reader.back", { section })}</span>
          </button>
          {bookmarks.length > 1 && (
            <span data-reader-position className="flex shrink-0 items-center gap-1.5 text-xs text-subtle">
              <span aria-hidden className="font-medium">↑ ↓</span>
              {t("reader.position", { current: index + 1, total: bookmarks.length })}
            </span>
          )}
          <span className="flex-1" />
          {/* The card has its own «Open in browser», and there is nothing to keep offline. */}
          {!compact && (
          <>
          <OfflineButton
            saved={!!offline.offlineAt(b)}
            busy={offline.saving === b.id}
            narrow
            disabled={shownStatus?.kind !== "article"}
            onSave={() => shownStatus?.kind === "article" && void offline.save(b, shownStatus.article)}
            onUpdate={() => void offline.save(b)}
            onRemove={() => void offline.remove(b)}
            className="!size-8 border-border"
          />
          <button
            type="button"
            onClick={() => onOpen(b.url)}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium transition-colors duration-150 hover:bg-hover"
          >
            {t("reader.openInBrowser")}
            <Icon icon={ArrowUpRight} size={14} />
          </button>
          </>
          )}
          <button
            type="button"
            aria-label={b.is_favorite ? t("card.unfavorite") : t("card.favorite")}
            aria-pressed={b.is_favorite}
            onClick={() => onFavorite(b)}
            className={`flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-150 hover:bg-hover ${b.is_favorite ? "text-accent" : "text-icon"}`}
          >
            <Icon icon={Heart} size={16} className={b.is_favorite ? "fill-accent" : ""} />
          </button>
        </header>
        {!online && shownStatus?.kind === "article" && shownStatus.offlineAt && (
          <OfflineBanner
            savedAt={offline.offlineAt(b) ?? shownStatus.offlineAt}
            onLive={() => {
              setLivePage(true);
              setAttempt((n) => n + 1);
            }}
          />
        )}
        <div ref={scroller} tabIndex={-1} data-reader-scroll className={`min-h-0 flex-1 overflow-y-auto outline-none ${compact ? "px-6 py-2" : `pane-scroll ${panelScrollInset} pt-10 pb-24`}`}>
          <ArticleView
            key={b.id}
            compact={compact}
            url={b.url}
            title={b.title || b.url}
            domain={b.domain}
            saved={b.created_at}
            bookmarkId={b.id}
            offlineAt={offline.offlineAt(b)}
            live={livePage}
            attempt={attempt}
            onOpen={onOpen}
            onReady={restore}
            onStatus={(next) => setStatus({ id: b.id, status: next })}
          />
        </div>
      </div>
    </dialog>
  );
}
