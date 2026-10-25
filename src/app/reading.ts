import { MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { failureText } from "../components/reader/ArticleView";
import type { ReadingSource } from "../components/reader/ReadingMode";
import type { useSelection } from "../hooks/useSelection";
import { api } from "../services/api";
import { describeError, reasonOf } from "../services/errors";
import { storedOpenLinks } from "../services/preferences";
import { Article, saveOffline } from "../services/reader";
import type { Bookmark, OfflineCopy } from "../types";
import type { Notices } from "./notices";

type Selection = ReturnType<typeof useSelection>;

/**
 * Reading: the sheet over the list (NP-123), the reading mode (NP-122), offline copies (NP-126) and
 * where a followed link opens (Р-69, point 5).
 */
export function useReading(
  t: TFunction,
  { say }: Pick<Notices, "say">,
  selectionRef: MutableRefObject<Selection>,
  loadedRef: MutableRefObject<Bookmark[]>,
  bookmarks: Bookmark[],
) {
  /** «Open links» (Р-69, point 5), set in Settings → Reading (NP-124). */
  const [linkTarget, setLinkTarget] = useState(storedOpenLinks);
  const linkTargetRef = useRef(linkTarget);
  linkTargetRef.current = linkTarget;
  /** The reading sheet over the list (NP-123): what `↑`/`↓` go through and which one shows. */
  const [sheet, setSheet] = useState<{ ids: number[]; index: number } | null>(null);
  /** The reading mode (NP-122): what its queue reads and which bookmark it starts with. */
  const [reading, setReading] = useState<{ source: ReadingSource; start: number | null } | null>(null);
  const readingRef = useRef(reading);
  /** The reading mode covers the window: the library under it is hidden (its scrollbars with it). */
  const [readingCovers, setReadingCovers] = useState(false);
  readingRef.current = reading;
  /** The toolbar's «Read»: the drop starts there and folds back into it. */
  const readButton = useRef<HTMLButtonElement>(null);
  /** What had focus before the mode: it gets it back. */
  const readingFocus = useRef<HTMLElement | null>(null);

  /**
   * An offline copy (NP-126): of the article on screen, or of the page read now
   * («Save for offline» of the list); a page that cannot be read says why, as the
   * reader does. `quiet`: «Save articles I open in Reading» saves without a notice.
   */
  const saveOfflineCopy = async (b: Bookmark, article?: Article, quiet = false): Promise<OfflineCopy | null> => {
    try {
      const saved = await saveOffline(b, article);
      if (!saved.ok) {
        say(t("offline.failed", { reason: failureText(saved.failure, t) }), true);
        return null;
      }
      if (!quiet) say(t("offline.savedNotice"));
      return saved.copy;
    } catch (err) {
      // A bookmark deleted meanwhile, an article too large to keep: said as the reason.
      say(t("offline.failed", { reason: reasonOf(err, t) }), true);
      return null;
    }
  };
  /** At once, without a dialog: the bookmark stays, only its copy goes. */
  const removeOfflineCopy = (b: Bookmark) =>
    api.removeOfflineCopy(b.id).then(
      () => {
        say(t("offline.removedNotice"));
        return true;
      },
      (err) => {
        say(describeError(err), true);
        return false;
      },
    );
  const offlineRef = useRef({ save: saveOfflineCopy, remove: removeOfflineCopy });
  offlineRef.current = { save: saveOfflineCopy, remove: removeOfflineCopy };
  /**
   * The reading sheet for `b` (NP-123, Р-69 point 6). A selected one opens with
   * the rest of the loaded selection in list order for `↑`/`↓`; another one alone.
   */
  const readHere = (b: Bookmark) => {
    const selected = selectionRef.current.ids;
    const ids = selected.has(b.id) ? loadedRef.current.filter((item) => selected.has(item.id)).map((item) => item.id) : [b.id];
    if (selected.has(b.id)) selectionRef.current.setLast(b.id);
    setSheet({ ids, index: Math.max(0, ids.indexOf(b.id)) });
  };
  const readHereRef = useRef(readHere);
  readHereRef.current = readHere;
  /** `Space` and «Read» of the bar: the last one clicked of the selection, or its first loaded one. */
  const readSelection = () => {
    const ids = selectionRef.current.ids;
    const last = selectionRef.current.last();
    const loaded = loadedRef.current;
    const b = loaded.find((item) => item.id === last && ids.has(item.id)) ?? loaded.find((item) => ids.has(item.id));
    if (b) readHere(b);
  };
  const readSelectionRef = useRef(readSelection);
  readSelectionRef.current = readSelection;
  /**
   * The reading mode (NP-122): «Read» opens Reading at its first unread
   * bookmark; a link followed «in reading mode» (Р-69, point 5) opens the
   * section at that bookmark. The library stays underneath as it was.
   */
  const openReading = (start: number | null = null) => {
    readingFocus.current = document.activeElement as HTMLElement | null;
    setSheet(null);
    setReading({ source: start === null ? "reading" : "section", start });
  };
  const openReadingRef = useRef(openReading);
  openReadingRef.current = openReading;
  const readingOrigin = useCallback(() => {
    const rect = readButton.current?.getBoundingClientRect();
    return rect && rect.width ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  }, []);
  const closeReading = useCallback(() => {
    setReading(null);
    setReadingCovers(false);
    // Back where the person was: the toolbar's «Read» or the card a link was followed from.
    requestAnimationFrame(() => (readingFocus.current?.isConnected ? readingFocus.current : readButton.current)?.focus({ preventScroll: true }));
  }, []);

  /** The sheet's bookmarks as the list has them now: a heart set in the sheet shows there too. */
  const sheetBookmarks = sheet ? sheet.ids.flatMap((id) => bookmarks.find((b) => b.id === id) ?? []) : [];
  // Every bookmark of the sheet left the list (deleted elsewhere, another section): the sheet goes with them.
  const sheetEmpty = !!sheet && sheetBookmarks.length === 0;
  useEffect(() => {
    if (sheetEmpty) setSheet(null);
  }, [sheetEmpty]);

  return {
    linkTarget,
    setLinkTarget,
    linkTargetRef,
    sheet,
    setSheet,
    sheetBookmarks,
    reading,
    readingRef,
    readingCovers,
    setReadingCovers,
    readButton,
    saveOfflineCopy,
    removeOfflineCopy,
    offlineRef,
    readHere,
    readHereRef,
    readSelection,
    readSelectionRef,
    openReading,
    openReadingRef,
    readingOrigin,
    closeReading,
  };
}

export type Reading = ReturnType<typeof useReading>;
