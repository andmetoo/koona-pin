import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRight, Heart } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Bookmark } from "../../types";
import { api } from "../../services/api";
import { Icon } from "../icons";
import { Kbd } from "../ui/Hint";
import { ArticleView } from "./ArticleView";

/** Every write of the progress is a change to sync (NP-121): at most this often while scrolling. */
const SAVE_EVERY = 2000;
/** Smaller moves are not worth a write. */
const SAVE_STEP = 0.01;

/**
 * How far the article is read, 0–1, written through `set_reading_progress` at
 * most every two seconds and once more when the bookmark changes or the sheet
 * closes. Only forward: scrolling back to look at something does not unread it.
 */
function useReadingProgress(bookmark: Bookmark, scroller: React.RefObject<HTMLDivElement | null>, ready: boolean) {
  const [progress, setProgress] = useState(bookmark.reading_progress);
  const state = useRef({ id: bookmark.id, saved: bookmark.reading_progress, reached: bookmark.reading_progress, at: 0, timer: 0 });

  const save = useCallback(() => {
    const s = state.current;
    window.clearTimeout(s.timer);
    s.timer = 0;
    if (s.reached - s.saved < SAVE_STEP && !(s.reached >= 1 && s.saved < 1)) return;
    s.saved = s.reached;
    s.at = Date.now();
    void api.setReadingProgress(s.id, s.reached).catch(() => {});
  }, []);

  // Another bookmark: the last one keeps what was read of it.
  useLayoutEffect(() => {
    state.current = { id: bookmark.id, saved: bookmark.reading_progress, reached: bookmark.reading_progress, at: 0, timer: 0 };
    setProgress(bookmark.reading_progress);
    return save;
    // The bookmark's own progress changes with every write; only another id starts anew.
  }, [bookmark.id, save]);

  useEffect(() => {
    const element = scroller.current;
    if (!element || !ready) return;
    const onScroll = () => {
      const room = element.scrollHeight - element.clientHeight;
      if (room <= 0) return;
      // The last pixels count as the end: a rounding scroll position never quite reaches it.
      const now = Math.min(1, element.scrollTop >= room - 2 ? 1 : element.scrollTop / room);
      setProgress(now);
      const s = state.current;
      if (now <= s.reached) return;
      s.reached = now;
      const wait = s.at + SAVE_EVERY - Date.now();
      if (wait <= 0) save();
      else if (!s.timer) s.timer = window.setTimeout(save, wait);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [scroller, ready, save]);

  return progress;
}

/**
 * Reading over the list (Р-69 variant A, frame A): a sheet 760 px wide over
 * the dimmed library with the article of the selected bookmark. `↑`/`↓` go
 * through the selection, `Esc` or a click beside it closes it; focus returns
 * to where it was. «Open in browser» and the heart act on the bookmark shown.
 */
export function ReadingSheet({
  bookmarks,
  index,
  section,
  onIndex,
  onOpen,
  onFavorite,
  onClose,
}: {
  /** What `↑`/`↓` go through: the selected in list order, or the one bookmark. */
  bookmarks: Bookmark[];
  index: number;
  /** The name of the section under the sheet: «Back to …». */
  section: string;
  onIndex: (index: number) => void;
  onOpen: (url: string) => void;
  onFavorite: (bookmark: Bookmark) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const b = bookmarks[index];
  const [ready, setReady] = useState<number | null>(null);
  const progress = useReadingProgress(b, scroller, ready === b.id);
  const latest = useRef({ index, count: bookmarks.length, onIndex, onClose });
  latest.current = { index, count: bookmarks.length, onIndex, onClose };

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
    if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || count < 2 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    e.preventDefault();
    const next = index + (e.key === "ArrowDown" ? 1 : -1);
    if (next >= 0 && next < count) onIndex(next);
  };

  return (
    <dialog
      ref={dialog}
      aria-label={b.title || b.url}
      data-reading-sheet
      className="reading-sheet fixed inset-0 m-0 h-full max-h-none w-full max-w-none bg-transparent p-0"
      onCancel={(e) => {
        e.preventDefault();
        latest.current.onClose();
      }}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) latest.current.onClose();
      }}
    >
      <div
        className="absolute inset-x-0 top-6 bottom-0 mx-auto flex w-[760px] max-w-[calc(100%-32px)] animate-sheet flex-col overflow-hidden rounded-t-[14px] bg-sheet text-sheet-ink shadow-[0_12px_40px_rgb(0_0_0/0.19)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div aria-hidden className="h-[3px] shrink-0 bg-sheet-line">
          <div data-reading-progress className="h-full rounded-r-xs bg-accent" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-sheet-line px-6">
          <button type="button" onClick={onClose} className="flex min-w-0 items-center gap-2.5 text-sm text-muted hover:text-ink">
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
          <button
            type="button"
            onClick={() => onOpen(b.url)}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium transition-colors duration-150 hover:bg-hover"
          >
            {t("reader.openInBrowser")}
            <Icon icon={ArrowUpRight} size={14} />
          </button>
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
        <div ref={scroller} tabIndex={-1} data-reader-scroll className="min-h-0 flex-1 overflow-y-auto px-6 pt-10 pb-24 outline-none">
          <ArticleView key={b.id} url={b.url} title={b.title || b.url} domain={b.domain} onOpen={onOpen} onReady={restore} />
        </div>
      </div>
    </dialog>
  );
}
