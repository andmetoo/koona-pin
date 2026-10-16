import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
      data-reader-look={look.theme}
      style={readerStyle(look)}
      className="reading-sheet reading-look fixed inset-0 m-0 h-full max-h-none w-full max-w-none bg-transparent p-0"
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
        <div ref={scroller} tabIndex={-1} data-reader-scroll className="min-h-0 flex-1 overflow-y-auto px-6 pt-10 pb-24 outline-none">
          <ArticleView
            key={b.id}
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
