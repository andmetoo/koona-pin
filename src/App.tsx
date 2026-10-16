import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, BookOpen, ChevronDown, CircleArrowDown, ChevronRight, Heart, Import, Link, Plus, RefreshCw, Search, Trash2, TriangleAlert, WifiOff, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, isTauri } from "./services/api";
import { describeError, reasonOf } from "./services/errors";
import { composing } from "./services/ime";
import { isArrow, isDeleteKey, shortcut } from "./services/keys";
import { undoNotice } from "./services/undo";
import { carriesLink, destinationOf, linkFrom } from "./services/addLink";
import { bulkFailure, bulkNotice, readingNotice } from "./services/bulk";
import { collectionColor, suggestedName } from "./services/collections";
import { applyTheme, isDark, preference, savePreference, storedOpenLinks, storedTheme, storedValue, Theme } from "./services/preferences";
import { AppSettings, BackupCopy, Bookmark, BookmarkSort, BulkChange, CaptureStatus, Collection, CsvColumns, ExportFormat, FilterState, LibraryStatus, OfflineCopy, Plan, SupporterStatus, SyncStatus, UpdateStatus, ViewMode } from "./types";
import { Article, saveOffline } from "./services/reader";
import { byTime, SORTS } from "./services/library";
import { useLibrary } from "./hooks/useLibrary";
import { useSelection } from "./hooks/useSelection";
import { useSelectionDrag } from "./hooks/useSelectionDrag";
import { useReaderLook } from "./hooks/useReaderLook";
import { usePreviewRefresh } from "./hooks/usePreviewRefresh";
import { ClipIcon, Icon, InboxTray } from "./components/icons";
import { Button } from "./components/ui/Button";
import { Banner, Toast } from "./components/ui/Notices";
import { Kbd } from "./components/ui/Hint";
import { Dialog } from "./components/ui/Dialog";
import { WindowBar } from "./components/ui/WindowBar";
import { Sidebar } from "./components/shell/Sidebar";
import { AppNotification } from "./components/shell/NotificationCenter";
import { Toolbar } from "./components/shell/Toolbar";
import { BookmarkActions, Preview } from "./components/library/Bookmarks";
import { Arrows, BookmarkList } from "./components/library/BookmarkList";
import { DragStack } from "./components/library/DragStack";
import { BookmarkEditor } from "./components/library/BookmarkEditor";
import { SelectionActions, SelectionBar } from "./components/library/SelectionBar";
import { EditHooks, Triage } from "./components/library/Triage";
import { ReadingSheet } from "./components/reader/ReadingSheet";
import { ReadingMode, ReadingSource } from "./components/reader/ReadingMode";
import { failureText } from "./components/reader/ArticleView";
import { AssistantDialog } from "./components/settings/AssistantDialog";
import { AddSheet, NewLink } from "./components/library/AddSheet";
import { BackgroundDialog, CollectionDialog, ConfirmDialog, ConnectDialog, ImportDialog, RestoreDialog } from "./components/library/Dialogs";
import { BackupRestoreDialog, copyTime } from "./components/BackupRestoreDialog";
import { FeedbackDialog } from "./components/FeedbackDialog";
import { UpdateDialog } from "./components/UpdateDialog";
import { PlanDialog, SignInDialog, SupporterDialog } from "./components/SupporterDialog";
import { offer } from "./services/update";
import { emptyDraft, FeedbackDraft } from "./services/feedback";
import { DuplicatesPage } from "./components/library/DuplicatesPage";
import { LinkCheckPage } from "./components/library/LinkCheckPage";
import { mergedNotice } from "./services/duplicates";
import { problemBanner } from "./services/capture";
import { SettingsPage } from "./components/settings/SettingsPage";
import { FeedsPage } from "./components/feeds/FeedsPage";
import { useFeeds } from "./components/feeds/useFeeds";
import { useFeedActions } from "./components/feeds/FeedMenu";
import { feedNotifications } from "./services/feedNotifications";
import { exportOpml, onFollowFailed, unsubscribeFeed } from "./services/feeds";
import { parsePlace } from "./services/feedsView";
import { SyncDialog } from "./components/commercial/SyncDialog";
import { syncPrompt } from "./components/commercial/syncText";

/** `selectionCollection` — «Новая коллекция из выбранного» in a narrow window, where the sidebar is a strip. */
type Surface = "add" | "import" | "importFeeds" | "restore" | "backup" | "connect" | "assistant" | "collection" | "selectionCollection" | "feedback" | "background" | "update" | "supporter" | "signIn" | "plan" | "upgrade" | "sync" | null;
/**
 * `undo` turns the notice into «… · Отменить Ctrl Z» for 8 seconds (frame 12);
 * `retry` adds «Повторить» to an alert (frame 20); `long` keeps a plain notice
 * 8 seconds with a close button (frame 21); `show` is «Показать» after an
 * export, 8 seconds (frame 29).
 */
type Notice = { text: string; alert: boolean; undo?: () => void; retry?: () => void; long?: boolean; show?: () => void; glass?: boolean } | null;
/** Columns of the CSV, titled in the interface's language (NP-032). */
const CSV_COLUMNS = ["title", "url", "domain", "collection", "tags", "notes", "favorite", "inbox", "saved"] as const;
type Section = Partial<Pick<FilterState, "collectionId" | "onlyFavorites" | "onlyInbox" | "onlyTrash" | "onlyReading" | "onlyOffline">>;
/** Every section off: what `navigate` starts from. */
const noSection = { collectionId: null, onlyFavorites: false, onlyInbox: false, onlyTrash: false, onlyReading: false, onlyOffline: false };
const initialFilters: FilterState = {
  search: "",
  tag: null,
  domain: null,
  ...noSection,
};
const NOTICE_MS = 3000;
const UNDO_MS = 8000;
/** Above this many the banner does not promise «about a minute». */
const QUICK_INBOX = 20;
/** Below this width the sidebar becomes a strip of icons (frame 16). */
const NARROW = "(max-width: 999px)";
/** From this width the editor docks on the right instead of covering the content. */
const WIDE = "(min-width: 1150px)";

/** «Нет связи 3 дня» depends on the clock: the status is read again this often. */
const CAPTURE_REFRESH_MS = 5 * 60 * 1000;

function useMedia(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function App() {
  const { t, i18n } = useTranslation();
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const systemDark = useMedia("(prefers-color-scheme: dark)");
  const narrow = useMedia(NARROW);
  const wide = useMedia(WIDE);
  const [view, setView] = useState<ViewMode>(() => preference("view", ["grid", "dense", "list"], "dense"));
  /** The order of every list but the trash, kept like the view (NP-114). */
  const [sort, setSort] = useState<BookmarkSort>(() => preference("sort", SORTS, "newest"));
  const [filters, setFilters] = useState(initialFilters);
  const [page, setPage] = useState<"library" | "settings" | "duplicates" | "links" | "feeds">("library");
  /** The Feeds page (NP-132): the feed shown (null: All feeds) and the open post, remembered. */
  const [feedPlace, setFeedPlace] = useState(() => parsePlace(storedValue("feeds.last")));
  const { feeds, refreshing: feedsRefreshing } = useFeeds();
  const pageRef = useRef(page);
  pageRef.current = page;
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const library = useLibrary(filters, sort, scrollRef);
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const [surface, setSurface] = useState<Surface>(null);
  /** The subscription «Switch to 5 years» was chosen for: the step says when it ends. */
  const [upgradeFrom, setUpgradeFrom] = useState<Plan | null>(null);
  // Kept while the app runs: closing the dialog or a failed send loses nothing (NP-088).
  const [feedbackDraft, setFeedbackDraft] = useState<FeedbackDraft>(emptyDraft);
  /** Inbox triage (NP-025) and the filters to go back to when it ends. */
  const [triage, setTriage] = useState<FilterState | null>(null);
  const triageRef = useRef(triage);
  triageRef.current = triage;
  /** Selected bookmarks (NP-028): cleared by another section, settings or triage. */
  const selection = useSelection(filters, page === "library" && !triage);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  /** The arrows of the grid and the list (#319), filled by `BookmarkList` while it is shown. */
  const arrowsRef = useRef<Arrows | null>(null);
  /** The loaded order, for `Shift`+click ranges. */
  const loadedRef = useRef(library.bookmarks);
  loadedRef.current = library.bookmarks;
  /** «Open links» (Р-69, point 5), set in Settings → General → Reading (NP-124). */
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
  /** What a screen reader hears when a click changes the selection (NP-123). */
  const [announcement, setAnnouncement] = useState("");
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [deletingCollection, setDeletingCollection] = useState<Collection | null>(null);
  /** What the confirmation (frame 26) would delete for good: one bookmark, the selection or the whole trash. */
  const [purging, setPurging] = useState<Bookmark | "all" | { selected: number[] } | null>(null);
  /** A bulk action is running: the bar waits (NP-029). */
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulkBusyRef = useRef(bulkBusy);
  bulkBusyRef.current = bulkBusy;
  /** «Новая коллекция из выбранного»: the name offered in the sidebar field and the colour the collection will get, while it is open. */
  const [naming, setNaming] = useState<{ suggested: string; color: string } | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  /** A link just saved by hand (2026-10-16): its card lands first with a spring. */
  const [fresh, setFresh] = useState<number | null>(null);
  /** A link dragged over the window: the veil, and whether Shift sends it to the inbox. */
  const [veil, setVeil] = useState<{ inbox: boolean } | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [capture, setCapture] = useState<CaptureStatus | null>(null);
  /** The app's own update (NP-038, sheet 42), checked by Rust; the version that runs and the system for the dialog. */
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  /** Supporter (NP-066, sheet 45): the plan as kept; no request behind it. */
  const [supporter, setSupporter] = useState<SupporterStatus | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  /** The Supporter badge's heart in the colour of the season; a perk the dialog turns off. */
  const [badge, setBadge] = useState(() => preference("supporterBadge", ["on", "off"], "on") === "on");
  // A check that finds the plan gone (cancelled, refunded) closes its dialogs for good, so nothing
  // stays blocked behind a dialog that is no longer shown, nor offers to switch a plan that ended.
  const hasPlan = !!supporter?.plan;
  useEffect(() => {
    if (!hasPlan) setSurface((open) => (open === "plan" || open === "upgrade" ? null : open));
  }, [hasPlan]);
  const [appVersion, setAppVersion] = useState("");
  const [linux, setLinux] = useState(false);
  const [damaged, setDamaged] = useState(false);
  /** The newest readable copy, offered by the damage banner (sheet 33). */
  const [latestCopy, setLatestCopy] = useState<BackupCopy | null>(null);
  /** Bumped after a restore: the settings count the copies again. */
  const [dataVersion, setDataVersion] = useState(0);
  const [movedAside, setMovedAside] = useState("");
  const [slowLoading, setSlowLoading] = useState(false);
  /** The newest inbox bookmark when the banner was hidden: it returns for a newer one. */
  const [bannerHidden, setBannerHidden] = useState(() => storedValue("inboxBannerHidden"));
  const editorFocus = useRef<HTMLElement | null>(null);
  /** The editor opened from triage: its save and «В корзину» are triage decisions. */
  const editHooks = useRef<EditHooks | null>(null);
  const dark = isDark(theme, systemDark);
  /** How reading looks (NP-124): the Aa panel's choice, the app's theme and the plan. */
  const readerLook = useReaderLook(supporter, dark);
  const say = (text: string, alert = false, undo?: () => void) => setNotice({ text, alert, undo });
  /** «Refresh previews» for many bookmarks: Settings → Data, the selection bar, the notification centre. */
  const previews = usePreviewRefresh();
  const handingOffRef = useRef(previews.handingOff);
  handingOffRef.current = previews.handingOff;
  const sayAlert = useCallback((text: string) => setNotice({ text, alert: true }), []);
  /**
   * Ctrl Z takes back the last command, «Отменить» in a notice its own
   * (NP-024). What was changed since is not overwritten: the notice says why.
   */
  const undo = (command?: number) => {
    setNotice(null);
    api.undo(command).then(
      (result) => {
        if (result.outcome === "undone" && result.bookmarks.some((b) => b.id === editingRef.current?.id)) closeEditor();
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

  useEffect(() => {
    applyTheme(dark);
    savePreference("theme", theme);
  }, [theme, dark]);
  useEffect(() => savePreference("view", view), [view]);
  useEffect(() => savePreference("feeds.last", JSON.stringify(feedPlace)), [feedPlace]);
  // «New link» closes once the bookmark is saved and follows the site after (NP-133): a follow
  // that fails then has no sheet to say so, so the app's own notice does.
  const surfaceNow = useRef<Surface>(null);
  surfaceNow.current = surface;
  useEffect(() =>
    onFollowFailed((err) => {
      // Once the sheet's own closing has rendered: open, it shows the error itself.
      window.setTimeout(() => surfaceNow.current !== "add" && setNotice({ text: describeError(err), alert: true }), 50);
    }),
  []);
  useEffect(() => savePreference("sort", sort), [sort]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Keys an IME uses to build a character are not shortcuts (NP-090).
      if (composing(e)) return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "k" && !reading) {
        e.preventDefault();
        setPage("library");
        setTriage(null);
        // The toolbar's field mounts with the library: wait a few frames for it when coming from elsewhere.
        const focusSearch = (frames: number) =>
          requestAnimationFrame(() => (searchRef.current ? searchRef.current.focus() : frames > 0 && focusSearch(frames - 1)));
        focusSearch(5);
      }
      // Quits from the window on every system (NP-096): without a tray it is the way out.
      if ((e.ctrlKey || e.metaKey) && (key === "q" || e.code === "KeyQ") && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void api.quitApp().catch(() => {});
      }
      if ((e.ctrlKey || e.metaKey) && key === "n" && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        setSurface("add");
      }
      if (e.key === "Escape" && wide && editing && !document.querySelector("dialog[open], [data-menu]")) {
        setEditing(null);
        editorFocus.current?.focus();
      }
      // Ctrl Z takes back the last action (NP-024). In a text field it stays
      // the field's own undo; under a dialog, a menu or the editor it waits:
      // the bookmark there could change under the form.
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable=true]");
      // Triage takes `Z` and Ctrl Z back for its own decisions.
      const above = editing || triage || document.querySelector("dialog[open], [data-menu]");
      // The reading mode is a layer too: the library under it keeps its selection and keys.
      // Ctrl Z still works there (#319): «Remove from Reading» is taken back from the mode.
      const layer = above || reading;
      if ((e.ctrlKey || e.metaKey) && key === "z" && !e.shiftKey && !typing && !above) {
        e.preventDefault();
        undoRef.current();
      }
      // Selection (NP-028): Ctrl A adds everything the list shows, loaded or
      // not; in a field it selects the field's text. Esc clears; the search
      // field keeps it while it holds a query (the toolbar stops it there).
      if (page === "library" && !layer) {
        if ((e.ctrlKey || e.metaKey) && key === "a" && !e.shiftKey && !typing) {
          e.preventDefault();
          void selectionRef.current.selectAll().catch((err) => say(describeError(err), true));
        }
        if (e.key === "Escape" && selectionRef.current.ids.size) selectionRef.current.clear();
        // Del: the selection to the trash, or, in the trash, the dialog to delete it for good (NP-029).
        // On a Mac ⌫ and ⌘⌫ too (#297).
        if (isDeleteKey(e) && !typing && selectionRef.current.ids.size && !e.repeat && !bulkBusyRef.current) {
          e.preventDefault();
          if (filters.onlyTrash) selectionActionsRef.current.deleteForever();
          else selectionActionsRef.current.trash();
        }
        // R: the selection into Reading, or out of it in Reading itself (NP-121).
        const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
        if (key === "r" && plain && !typing && !filters.onlyTrash && selectionRef.current.ids.size && !e.repeat && !bulkBusyRef.current) {
          e.preventDefault();
          selectionActionsRef.current.reading(!filters.onlyReading);
        }
        // Space: the reading sheet for the last one clicked of the selection (NP-123). A
        // focused card reads itself; a focused button presses itself. Triage keeps Space
        // for the browser: it is a layer, so this never runs there.
        const own = e.target instanceof HTMLElement && e.target.closest("button, a, [data-bookmark-id], [role=menuitem]");
        if (e.key === " " && plain && !e.shiftKey && !typing && !own && !e.repeat && !filters.onlyTrash && selectionRef.current.ids.size) {
          e.preventDefault();
          readSelectionRef.current();
        }
        // Arrows move the selection between cards and rows (#319), Shift adds the range
        // as Shift+click does. Only from the list or from nowhere: the sidebar, the toolbar
        // and fields keep their arrows; the reading sheet and menus are layers.
        const target = e.target instanceof HTMLElement ? e.target : null;
        const fromList = !target || target === document.body || !!target.closest("[data-view]");
        if (isArrow(e.key) && fromList && !e.ctrlKey && !e.metaKey && !e.altKey && !typing && !e.defaultPrevented && arrowsRef.current) {
          e.preventDefault();
          // From the focused card, else the last one clicked of the selection.
          const card = target?.closest<HTMLElement>("[data-bookmark-id]");
          const last = selectionRef.current.last();
          const from = card ? Number(card.dataset.bookmarkId) : last !== null && selectionRef.current.ids.has(last) ? last : null;
          const b = arrowsRef.current(e.key, from);
          if (b) actionsRef.current.select(b, e.shiftKey && from !== null ? "range" : "only");
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [wide, editing, triage, page, filters.onlyTrash, filters.onlyReading, reading]);
  // `⌘V` in the library with a link on the clipboard saves it at once (2026-10-16). The paste
  // event carries the clipboard itself: no permission, nothing read before the person pastes.
  // In a field, under a dialog, the editor or the reading mode the paste is theirs.
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest("input, textarea, select, [contenteditable=true]") || quickBlocked()) return;
      const data = e.clipboardData;
      const url = linkFrom(data?.getData("text/uri-list"), true) ?? linkFrom(data?.getData("text/plain"));
      if (!url) return;
      e.preventDefault();
      quickSaveRef.current(url);
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  }, []);
  // A link dragged from a browser or another app frosts the window; dropped, it is saved, with
  // Shift into the inbox (2026-10-16). Files and the app's own drags are left alone: the
  // selection's drag is a pointer drag and never starts one of these.
  useEffect(() => {
    let depth = 0;
    let accepting = false;
    let own = false;
    const start = () => (own = true);
    const end = () => (own = false);
    const enter = (e: DragEvent) => {
      if (depth === 0) accepting = !own && carriesLink(e.dataTransfer?.types) && !quickBlocked();
      if (!accepting) return;
      depth++;
      e.preventDefault();
      setVeil({ inbox: e.shiftKey });
    };
    const over = (e: DragEvent) => {
      if (!accepting) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      setVeil((current) => (current?.inbox === e.shiftKey ? current : { inbox: e.shiftKey }));
    };
    const leave = () => {
      if (!accepting) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        accepting = false;
        setVeil(null);
      }
    };
    const drop = (e: DragEvent) => {
      if (!accepting) return;
      e.preventDefault();
      depth = 0;
      accepting = false;
      setVeil(null);
      const data = e.dataTransfer;
      const url = linkFrom(data?.getData("text/uri-list"), true) ?? linkFrom(data?.getData("text/plain"));
      if (url) quickSaveRef.current(url, e.shiftKey);
    };
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", end);
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", end);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);
  // The landing plays once; a later render of the card must not play it again.
  useEffect(() => {
    if (fresh === null) return;
    const timer = window.setTimeout(() => setFresh(null), 2200);
    return () => window.clearTimeout(timer);
  }, [fresh]);
  // The first close without a tray explains that the app keeps running (NP-096).
  useEffect(() => api.onCloseToBackground(() => setSurface("background")), []);
  useEffect(() => {
    const off = api.onUpdateStatus(setUpdate);
    void api.getUpdateStatus().then(setUpdate).catch(() => {});
    void api.getVersion().then(setAppVersion).catch(() => {});
    // The password texts of the update dialog are for the .deb and .rpm: an AppImage replaces its own file (NP-116).
    void api.getDesktop().then((desktop) => setLinux(desktop.linux && !desktop.appimage)).catch(() => {});
    return off;
  }, []);
  useEffect(() => {
    void api.getSupporterStatus().then(setSupporter).catch(() => {});
    return api.onSupporterStatus(setSupporter);
  }, []);
  // Sync between a Supporter's computers (commercial/sync, sheet 46).
  useEffect(() => {
    // An event newer than the first answer wins: the answer, late, would put an older state back.
    let heard = false;
    const stop = api.onSyncStatus((status) => {
      heard = true;
      setSync(status);
    });
    void api
      .getSyncStatus()
      .then((status) => heard || setSync(status))
      .catch(() => {});
    return stop;
  }, []);
  // A computer to approve, or a request to hand the main computer over, opens the Sync dialog by
  // itself on the main computer, once per prompt, when no other dialog is in the way.
  const prompt = syncPrompt(sync);
  const promptShown = useRef<string | null>(null);
  useEffect(() => {
    if (!prompt || prompt === promptShown.current) return;
    // Another dialog open (a purchase among them) is finished first.
    if (surface !== null && surface !== "sync") return;
    promptShown.current = prompt;
    setSurface("sync");
  }, [prompt, surface]);
  // The dialog follows the update; when no version is in play any more (cancelled into a recheck,
  // or the preview «restarted»), it goes.
  useEffect(() => {
    if (surface === "update" && !offer(update)) setSurface(null);
  }, [surface, update]);
  useEffect(() => {
    // The app learns about browsers when their extensions write (NP-016).
    const refresh = () => void api.getCaptureStatus().then(setCapture).catch(() => {});
    const off = api.onCaptureStatus(setCapture);
    refresh();
    const timer = window.setInterval(refresh, CAPTURE_REFRESH_MS);
    window.addEventListener("focus", refresh);
    return () => {
      off();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  useEffect(() => {
    // A link check runs in the background (NP-036): written results change the
    // sidebar count; its end is announced when the section is not open.
    let running = false;
    let timer = 0;
    const off = api.onLinkCheck((progress) => {
      // The count follows written results every few seconds, and at once at the end.
      if (progress.written && progress.state === "running" && !timer)
        timer = window.setTimeout(() => {
          timer = 0;
          void libraryRef.current.refreshCatalog();
        }, 2000);
      if (progress.state === "running") running = true;
      else if (running) {
        running = false;
        window.clearTimeout(timer);
        timer = 0;
        void libraryRef.current.refreshCatalog();
        // A check of the pages a refresh of previews could not open reports in the notification centre.
        if (progress.state === "idle" && pageRef.current !== "links" && !handingOffRef.current())
          void api.getCounts().then((counts) => {
            if (counts.links > 0)
              setNotice({ text: t("links.finished", { count: counts.links }), alert: false, long: true, show: () => openLinksRef.current() });
          });
      }
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [t]);
  useEffect(() => {
    if (!isTauri()) return;
    // The background integrity check reports damage after the start.
    const apply = (status: LibraryStatus) => {
      if (status.state !== "ready") return;
      setDamaged(status.damaged);
      if (status.moved_aside) setMovedAside(status.moved_aside);
    };
    const off = api.onLibraryStatus(apply);
    void api.getLibraryStatus().then(apply).catch(() => {});
    return off;
  }, []);
  useEffect(() => {
    if (!damaged) return setLatestCopy(null);
    void api
      .listBackups()
      .then((copies) => setLatestCopy(copies.find((copy) => copy.bookmarks !== null) ?? null))
      .catch(() => {});
  }, [damaged]);
  useEffect(() => {
    if (!notice || notice.alert) return;
    const timer = window.setTimeout(() => setNotice(null), notice.undo || notice.long ? UNDO_MS : NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (page !== "settings") return;
    api
      .getAppSettings()
      .then(setSettings)
      .catch((err) => say(describeError(err), true));
  }, [page]);
  useEffect(() => {
    // Frame 11: a skeleton only when the library takes longer than 300 ms.
    if (!library.loading) return setSlowLoading(false);
    const timer = window.setTimeout(() => setSlowLoading(true), 300);
    return () => window.clearTimeout(timer);
  }, [library.loading]);

  const changeFilters = (partial: Partial<FilterState>) => {
    setPage("library");
    setTriage(null);
    scrollRef.current?.scrollTo({ top: 0 });
    setFilters((prev) => ({ ...prev, ...partial }));
  };
  /** One section at a time: All, Inbox, Favorites, Reading, Trash or a collection. */
  const navigate = (section: Section = {}) => changeFilters({ ...noSection, ...section, tag: null, domain: null });
  const openInbox = () => navigate({ onlyInbox: true });
  /** «Разобрать»: triage over the whole inbox; the sidebar shows «Входящие» meanwhile. */
  const openTriage = () => {
    if (library.counts.inbox === 0) return;
    setPage("library");
    setEditing(null);
    setNotice(null);
    setTriage(filters);
    setFilters({ ...initialFilters, onlyInbox: true });
  };
  /** The section «Дубликаты» (NP-035): from the sidebar or the menu «⋯». */
  const openDuplicates = () => {
    setTriage(null);
    setEditing(null);
    setPage("duplicates");
  };
  /** The Feeds page (NP-132) on a feed, or on All feeds; another feed closes the open post. */
  const openFeeds = (feedUid: string | null) => {
    setTriage(null);
    setEditing(null);
    setPage("feeds");
    setFeedPlace((place) => (place.feed === feedUid ? place : { feed: feedUid, item: null }));
  };
  /** The section «Проверка ссылок» (NP-036): from the sidebar or the menu «⋯». */
  const openLinks = () => {
    setTriage(null);
    setEditing(null);
    setPage("links");
  };
  const openLinksRef = useRef(openLinks);
  openLinksRef.current = openLinks;
  /** «Закончить» `Esc`: back where triage was opened. */
  const finishTriage = () => {
    if (!triage) return;
    setNotice(null);
    setFilters(triage);
    setTriage(null);
  };
  const hideBanner = () => {
    const newest = library.counts.inbox_newest;
    if (!newest) return;
    setBannerHidden(newest);
    savePreference("inboxBannerHidden", newest);
  };
  /**
   * Sheet 43 (NP-117): a new library starts with the starter set, so frame 08
   * with its import button is not the first screen; this banner offers the
   * import instead, until the first import or ×. It never comes back.
   */
  const [importOffer, setImportOffer] = useState(() => storedValue("importBanner") === "show");
  useEffect(() => {
    if (library.firstRun) setImportOffer(true);
  }, [library.firstRun]);
  const endImportOffer = () => {
    setImportOffer(false);
    savePreference("importBanner", "done");
  };
  /** The newest three waiting bookmarks, fanned in the inbox notification. */
  const [inboxThumbs, setInboxThumbs] = useState<Bookmark[]>([]);
  useEffect(() => {
    if (!library.counts.inbox) return setInboxThumbs([]);
    let current = true;
    api
      .getBookmarks({ onlyInbox: true }, { limit: 3 })
      .then((page) => current && setInboxThumbs(page.items))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [library.counts.inbox, library.counts.inbox_newest]);
  /**
   * Menu «⋯» → Export (NP-032, frame 29): the Save dialog, then «… сохранено
   * в … · Показать» for 8 seconds, or an alert with the reason and
   * «Повторить», which opens the dialog again. Cancelling says nothing.
   */
  const exportLibrary = (format: ExportFormat, ids?: number[]) => {
    const columns =
      format === "csv" ? (Object.fromEntries(CSV_COLUMNS.map((key) => [key, t(`export.columns.${key}`)])) as CsvColumns) : undefined;
    const retry = () => exportLibrary(format, ids);
    api.exportLibrary(format, columns, ids).then(
      (result) => {
        if (result.outcome === "cancelled") return;
        if (result.outcome === "saved")
          return setNotice({
            text: t("export.saved", { count: result.count, name: result.file_name }),
            alert: false,
            long: true,
            show: () => void api.revealExport().catch((err) => say(describeError(err), true)),
          });
        const { file_name: name, folder, detail } = result;
        const text =
          result.problem === "disk_full"
            ? t("export.diskFull", { name })
            : result.problem === "no_permission"
              ? t("export.noPermission", { folder })
              : result.problem === "in_use"
                ? t("export.inUse", { name })
                : t("export.other", { name, detail });
        setNotice({ text, alert: true, retry });
      },
      (err) => setNotice({ text: describeError(err), alert: true, retry }),
    );
  };
  /**
   * Settings → «Save a copy…» (NP-034, sheet 33): like an export, «… · Show»
   * for 8 seconds, or an alert with the reason and «Retry».
   */
  /** «Export feeds (OPML)…» (NP-132): the desktop's Save dialog, then the notice of «Save a copy…». */
  const exportFeeds = () =>
    exportOpml().then(
      (result) =>
        result.outcome === "saved" &&
        setNotice({
          text: t("feeds.notice.exported", { count: result.count, name: result.file_name }),
          alert: false,
          long: true,
        }),
      (err) => setNotice({ text: describeError(err), alert: true, retry: () => void exportFeeds() }),
    );
  const saveBackupCopy = () =>
    api.saveBackupCopy().then(
      (result) => {
        if (result.outcome === "cancelled") return;
        if (result.outcome === "saved")
          return setNotice({
            text: t("settings.copySaved", { name: result.file_name }),
            alert: false,
            long: true,
            show: () => void api.revealExport().catch((err) => say(describeError(err), true)),
          });
        setNotice({ text: t("settings.copySaveFailed", { name: result.file_name, detail: result.detail }), alert: true, retry: () => void saveBackupCopy() });
      },
      (err) => setNotice({ text: describeError(err), alert: true, retry: () => void saveBackupCopy() }),
    );
  /**
   * One action on every selected bookmark (NP-029, frame 27): one transaction
   * and one command of the journal. The notice counts them and undoes the
   * whole action; after «В корзину» and «Восстановить» the selected leave the
   * list and the selection clears, after the rest it stays. A failure changed
   * nothing: the alert waits with «Повторить», which repeats the same action
   * on the same bookmarks.
   */
  /** The name «Новая коллекция из выбранного» offers, from the selected the list has loaded. */
  const offeredName = () =>
    suggestedName(library.bookmarks.filter((b) => selection.ids.has(b.id))) ?? t("selection.newCollectionName");
  const runBulk = (change: BulkChange, ids = [...selection.ids]) => {
    const target = change.action === "move" ? library.collections.find((c) => c.id === change.collection_id)?.name : undefined;
    setBulkBusy(true);
    setNotice(null);
    api.bulkUpdate(ids, change).then(
      (result) => {
        setBulkBusy(false);
        if (change.action === "trash" || change.action === "restore") {
          selectionRef.current.clear();
          if (editingRef.current && ids.includes(editingRef.current.id)) closeEditor();
        }
        if (result.collection) void library.refreshCatalog();
        say(bulkNotice(t, change, result.count, target), false, undoing(result.command));
      },
      (err) => {
        setBulkBusy(false);
        setNotice({ text: bulkFailure(t, change, ids.length, err, target), alert: true, retry: () => runBulk(change, ids) });
      },
    );
  };
  const selectionActions: SelectionActions = {
    read: () => readSelection(),
    move: (collectionId) => runBulk({ action: "move", collection_id: collectionId }),
    // The strip of a narrow window has no room for the field: the dialog asks instead.
    newCollection: () => {
      if (narrow) return setSurface("selectionCollection");
      const suggested = offeredName();
      // Colours follow the id (services/collections); the library knows the next one.
      void api.nextCollectionId().then(
        (id) => setNaming({ suggested, color: collectionColor(id) }),
        (err) => say(describeError(err), true),
      );
    },
    tag: (name) => runBulk({ action: "tag", name }),
    favorite: (favorite) => runBulk({ action: "favorite", favorite }),
    reading: (reading) => runBulk({ action: "reading", reading }),
    export: (format) => exportLibrary(format, [...selection.ids]),
    trash: () => runBulk({ action: "trash" }),
    restore: () => runBulk({ action: "restore" }),
    deleteForever: () => setPurging({ selected: [...selection.ids] }),
    refresh: () => {
      const before = previews.run;
      previews.start({ ids: [...selection.ids] }).then(
        (run) =>
          // Only one run at a time: one under way goes on, and says where it is.
          before?.state === "running" && run.started_at === before.started_at
            ? say(t("notice.previewsAlready", { done: run.done, total: run.total }))
            : say(t("notice.previewsStarted")),
        (err) => say(describeError(err), true),
      );
    },
  };
  const selectionActionsRef = useRef(selectionActions);
  selectionActionsRef.current = selectionActions;
  /** The selection dropped on the sidebar (NP-030): the bar's action, one command of the journal. */
  const selectionDrag = useSelectionDrag((target) => {
    const run = selectionActionsRef.current;
    if (target.kind === "collection") run.move(target.id);
    else if (target.kind === "tag") run.tag(target.name);
    else if (target.kind === "trash") run.trash();
    else if (target.kind === "favorites") run.favorite(true);
    else if (target.kind === "reading") run.reading(true);
    else run.newCollection();
  });
  const dragging = selectionDrag.drag;
  const startDrag = (e: PointerEvent, id: number) => {
    const bookmark = library.bookmarks.find((b) => b.id === id);
    if (bookmark) selectionDrag.start(e, bookmark, selection.ids.size);
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      say(t("notice.copied"));
    } catch {
      say(t("notice.copyFailed"), true);
    }
  };
  const readingChange = (b: Bookmark, change: BulkChange) =>
    void api
      .bulkUpdate([b.id], change)
      .then(({ command }) => say(readingNotice(t, change), false, undoing(command)))
      .catch((err) => say(describeError(err), true));
  const open = (url: string) => void api.openUrl(url).catch((err) => say(describeError(err), true));
  /** A feed's row menu in the sidebar and its dialogs (NP-132). */
  const feedMenu = useFeedActions({
    onNotice: (text, alert = false) => setNotice({ text, alert }),
    onOpen: open,
    onCopy: (text) => void copy(text),
    onUnfollowed: (feed) => setFeedPlace((place) => (place.feed === feed.uid ? { feed: null, item: null } : place)),
  });
  const feedActions = feedMenu.actions;
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
  const actions: BookmarkActions = useMemo(
    () => ({
      open,
      copy: (url) => void copy(url),
      edit: (b) => {
        editorFocus.current = document.activeElement as HTMLElement;
        setEditing(b);
      },
      favorite: (b) => void api.updateBookmark(b.id, { is_favorite: !b.is_favorite }).catch((err) => say(describeError(err), true)),
      // Reading (NP-121): one bookmark through the bulk command, undone the same way.
      reading: (b) => readingChange(b, { action: "reading", reading: !b.reading_at }),
      read: (b) => readingChange(b, { action: "read", read: !b.read_at }),
      offline: (b) => void (b.offline_at ? offlineRef.current.remove(b) : offlineRef.current.save(b)),
      move: (b, collectionId) =>
        void api
          .updateBookmark(b.id, { collection_id: collectionId })
          .then(({ command }) =>
            say(
              collectionId === null
                ? t("notice.movedOut")
                : t("notice.moved", { name: library.collections.find((c) => c.id === collectionId)?.name ?? "" }),
              false,
              undoing(command),
            ),
          )
          .catch((err) => say(describeError(err), true)),
      trash: (b) =>
        void api
          .trashBookmark(b.id)
          .then(({ command }) => {
            if (editingRef.current?.id === b.id) closeEditor();
            say(t("notice.trashed"), false, undoing(command));
          })
          .catch((err) => say(describeError(err), true)),
      restore: (b) =>
        void api
          .restoreBookmark(b.id)
          .then(({ command }) => say(t("notice.restored"), false, undoing(command)))
          .catch((err) => say(describeError(err), true)),
      deleteForever: (b) => setPurging(b),
      tag: (name) => changeFilters({ tag: name }),
      domain: (domain) => changeFilters({ domain }),
      refresh: (b) =>
        void api
          .refreshPreview(b.id)
          // Said as it is: a new picture or icon, none at all, or nothing new beside the old one.
          .then((fresh) =>
            say(
              fresh.image_url !== b.image_url || fresh.favicon_url !== b.favicon_url || fresh.site_name !== b.site_name
                ? t("notice.previewRefreshed")
                : fresh.image_url
                  ? t("notice.previewUnchanged")
                  : t("notice.noPicture"),
            ),
          )
          .catch((err) => say(describeError(err), true)),
      select: (b, how) => {
        const selection = selectionRef.current;
        if (how === "only") selection.only(b.id);
        else if (how === "range") selection.range(b.id, loadedRef.current.map((item) => item.id));
        else selection.toggle(b.id);
        // The ids are set at once; the hook's own state follows on the next render.
        const title = b.title || b.url;
        const now = how === "toggle" ? !selection.ids.has(b.id) : true;
        setAnnouncement(t(now ? "selection.announce" : "selection.unannounce", { title }));
      },
      readHere: (b) => readHereRef.current(b),
      follow: (b) => (linkTargetRef.current === "reader" ? openReadingRef.current(b.id) : open(b.url)),
      linksToBrowser: linkTarget === "browser",
    }),
    [library.collections, t, linkTarget],
  );
  /** For the arrows of the key handler, which is set up before `actions`. */
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const closeEditor = () => {
    editHooks.current = null;
    setEditing(null);
    editorFocus.current?.focus();
  };

  const collection = library.collections.find((c) => c.id === filters.collectionId);

  /**
   * A link saved by hand (2026-10-16): the sheet, `⌘V` in the library and a link
   * dropped on the window. Every link arrives in the inbox; «Library» sorts it at
   * once (into the chosen collection, if any), «Reading» sorts it and puts it in
   * Reading. A link already there changes nothing. The card lands first and a
   * glass notice says where it went, with «Undo».
   */
  const saveLink = async ({ url, title, collectionId, tags, destination }: NewLink) => {
    const added = await api.addBookmark({ url, title, collectionId: destination === "inbox" ? null : collectionId, tags });
    if (added.existing) return added;
    const b = added.bookmark;
    if (destination !== "inbox") await api.bulkUpdate([b.id], { action: "move", collection_id: collectionId ?? b.collection_id });
    if (destination === "reading") await api.bulkUpdate([b.id], { action: "reading", reading: true });
    scrollRef.current?.scrollTo({ top: 0 });
    await library.refresh();
    setFresh(b.id);
    const into = destination === "library" ? library.collections.find((c) => c.id === (collectionId ?? b.collection_id)) : undefined;
    const place = destination === "inbox" ? t("nav.inbox") : destination === "reading" ? t("nav.reading") : (into?.name ?? t("import.library"));
    setNotice({
      text: added.restored ? (destination === "inbox" ? t("notice.restoredLink") : t("add.restoredTo", { place })) : t("add.savedTo", { place }),
      alert: false,
      glass: true,
      undo: () => unsave(b.id, added.restored),
    });
    return added;
  };
  /**
   * «Undo» of a saved link: a new one is gone again, for good — it was never
   * there; one that came back from the trash goes back to it.
   */
  const unsave = (id: number, restored: boolean) => {
    setNotice(null);
    setFresh(null);
    void api
      .trashBookmark(id)
      .then(() => (restored ? undefined : api.deleteForever(id)))
      .then(() => library.refresh())
      .then(
        () => setNotice({ text: t("add.removed"), alert: false, glass: true }),
        (err) => say(describeError(err), true),
      );
  };
  /** `⌘V` and a drop save at once, where the person is; `toInbox`: Shift held on the drop. */
  const quickSave = (url: string, toInbox = false) => {
    const destination = toInbox ? "inbox" : destinationOf(filters);
    void saveLink({ url, collectionId: destination === "inbox" ? null : filters.collectionId, tags: [], destination }).then(
      (added) =>
        added.existing &&
        setNotice({
          text: t("notice.linkExisting"),
          alert: false,
          glass: true,
          show: () => {
            setNotice(null);
            editorFocus.current = null;
            setEditing(added.bookmark);
          },
        }),
      (err) => say(describeError(err), true),
    );
  };
  /** Where a drop saves without Shift, as the veil names it. */
  const dropPlace =
    destinationOf(filters) === "reading" ? t("nav.reading") : (library.collections.find((c) => c.id === filters.collectionId)?.name ?? t("import.library"));
  const quickSaveRef = useRef(quickSave);
  quickSaveRef.current = quickSave;
  /** Whether `⌘V` and a drop may save now: the library on screen, nothing over it. */
  const quickBlocked = () =>
    pageRef.current !== "library" || !!triageRef.current || !!readingRef.current || !!editingRef.current || !!document.querySelector("dialog[open], [data-menu]");
  const { counts } = library;
  const section = filters.onlyTrash
    ? t("nav.trash")
    : filters.onlyInbox
      ? t("nav.inbox")
      : filters.onlyFavorites
        ? t("nav.favorites")
        : filters.onlyReading
          ? t("nav.reading")
          : filters.onlyOffline
            ? t("nav.offline")
            : collection
          ? collection.name
          : t("nav.all");
  /** The sheet's bookmarks as the list has them now: a heart set in the sheet shows there too. */
  const sheetBookmarks = sheet ? sheet.ids.flatMap((id) => library.bookmarks.find((b) => b.id === id) ?? []) : [];
  // Every bookmark of the sheet left the list (deleted elsewhere, another section): the sheet goes with them.
  const sheetEmpty = !!sheet && sheetBookmarks.length === 0;
  useEffect(() => {
    if (sheetEmpty) setSheet(null);
  }, [sheetEmpty]);
  const sectionCount = filters.onlyTrash
    ? counts.trash
    : filters.onlyInbox
      ? counts.inbox
      : filters.onlyFavorites
        ? counts.favorites
        : filters.onlyReading
          ? counts.reading
          : filters.onlyOffline
            ? counts.offline
            : collection
          ? (collection.count ?? 0)
          : counts.total;
  // The inbox notification is hidden until a bookmark newer than the remembered one arrives (NP-020).
  const inboxHidden = !!(bannerHidden && counts.inbox_newest && counts.inbox_newest <= bannerHidden);
  // In the inbox itself the banner stays on the page, never hidden: it leads to triage (NP-025).
  const inboxBanner = counts.inbox > 0 && filters.onlyInbox;
  // The notification centre (2026-10-16): the inbox waiting, the import offer and a browser
  // that can't send bookmarks, behind the bell in the sidebar instead of banners over the list.
  const notifications: AppNotification[] = [];
  if (capture?.state === "failing")
    notifications.push({
      key: `capture:${capture.problem ?? "channel"}`,
      kind: "problem",
      icon: TriangleAlert,
      title: t("browser.failing"),
      text: problemBanner(capture, t),
      action: { label: t("browser.details"), run: () => setPage("settings") },
    });
  // What waits in the inbox, said once for the notification centre and the Inbox section's pill.
  const inboxLine = [
    counts.inbox_imported >= counts.inbox
      ? t("notifications.inboxFromImport")
      : counts.inbox_imported > 0
        ? t("notifications.inboxImported", { count: counts.inbox_imported })
        : "",
    counts.inbox > QUICK_INBOX
      ? t("notifications.inboxMany")
      : counts.inbox === 1
        ? t("notifications.inboxTextOne")
        : t("notifications.inboxText"),
  ]
    .filter(Boolean)
    .join(" ");
  if (counts.inbox > 0 && !inboxHidden)
    notifications.push({
      // A newer bookmark makes it a new notification, unread again.
      key: `inbox:${counts.inbox_newest ?? counts.inbox}`,
      kind: "inbox",
      icon: InboxTray,
      title: t("notifications.inboxTitle", { count: counts.inbox }),
      text: inboxLine,
      at: counts.inbox_newest,
      thumbs: inboxThumbs,
      action: { label: t("inbox.sort"), run: openTriage },
      dismiss: { label: t("inbox.hide"), run: hideBanner },
    });
  if (importOffer)
    notifications.push({
      key: "importOffer",
      kind: "offer",
      icon: Import,
      title: t("importOffer.label"),
      text: t("importOffer.text"),
      action: { label: t("importOffer.action"), run: () => setSurface("import") },
      dismiss: { label: t("importOffer.hide"), run: endImportOffer },
    });
  // The feeds' own (NP-133): new posts of feeds that notify, feeds that stopped updating.
  // «Read» opens All feeds: the page shows one feed or all of them, not a few (NP-132).
  notifications.push(
    ...feedNotifications(
      feeds ?? [],
      {
        onRead: (uids) => openFeeds(uids.length === 1 ? uids[0] : null),
        onShow: (uid) => openFeeds(uid),
        onUnfollow: (uid) => void unsubscribeFeed(uid).catch((err) => say(describeError(err), true)),
      },
      t,
    ),
  );
  const refreshRun = previews.run;
  if (refreshRun && previews.running)
    notifications.push({
      key: `previews:${refreshRun.started_at}:running`,
      kind: "task",
      icon: RefreshCw,
      title: t("notifications.refreshRunning", { done: refreshRun.done, total: refreshRun.total }),
      text: t("notifications.refreshRunningText"),
      progress: refreshRun.total ? refreshRun.done / refreshRun.total : 0,
      // Unread once it ends, under the key of its result.
      quiet: true,
      action: { label: t("notifications.refreshStop"), run: () => void previews.stop(), stay: true },
    });
  else if (refreshRun && previews.resultShown)
    notifications.push({
      key: `previews:${refreshRun.started_at}:${refreshRun.state}`,
      kind: "task",
      icon: refreshRun.state === "offline" ? WifiOff : RefreshCw,
      title: t(
        refreshRun.state === "offline"
          ? "notifications.refreshOffline"
          : refreshRun.state === "stopped"
            ? "notifications.refreshStopped"
            : "notifications.refreshDone",
      ),
      text:
        refreshRun.state === "offline"
          ? t("notifications.refreshOfflineText", { done: refreshRun.done, total: refreshRun.total })
          : t(refreshRun.check_ids.length ? "notifications.refreshResultChecking" : "notifications.refreshResult", {
              updated: refreshRun.updated,
              unchanged: refreshRun.unchanged,
              failed: refreshRun.failed,
            }),
      dismiss: { label: t("notifications.refreshHide"), run: previews.dismiss },
    });
  const handedOff = previews.handedOff;
  if (handedOff)
    notifications.push({
      key: `previews:${handedOff.key}:links`,
      kind: "task",
      icon: Link,
      title: handedOff.gone + handedOff.moved ? t("links.finished", { count: handedOff.gone + handedOff.moved }) : t("links.allOpenTitle"),
      text: [
        handedOff.gone ? t("notifications.linksCount", { label: t("links.group_gone"), count: handedOff.gone }) : "",
        handedOff.moved ? t("notifications.linksCount", { label: t("links.group_moved"), count: handedOff.moved }) : "",
      ]
        .filter(Boolean)
        .join(" · "),
      action: handedOff.gone + handedOff.moved ? { label: t("notifications.linksShow"), run: openLinks } : undefined,
      dismiss: { label: t("notifications.refreshHide"), run: previews.dismissHandedOff },
    });
  const clearNotifications = () => {
    if (counts.inbox > 0) hideBanner();
    if (importOffer) endImportOffer();
    if (previews.resultShown) previews.dismiss();
    previews.dismissHandedOff();
  };
  const searching = filters.search.trim() !== "";
  /** Search, tag or site narrow the section: the header shows «N из M». */
  const narrowed = searching || !!filters.tag || !!filters.domain;
  const editor = editing && (
    <BookmarkEditor
      key={editing.id}
      bookmark={editing}
      collections={library.collections}
      onOpen={actions.open}
      onCancel={closeEditor}
      onDelete={(b) => {
        const hooks = editHooks.current;
        if (!hooks) return actions.trash(b);
        closeEditor();
        hooks.trash();
      }}
      onSave={async (data) => {
        const hooks = editHooks.current;
        if (hooks) {
          await hooks.save(data);
          return closeEditor();
        }
        const { command } = await api.updateBookmark(editing.id, data);
        closeEditor();
        say(t("notice.saved"), false, undoing(command));
      }}
    />
  );

  const empty = (() => {
    if (narrowed) {
      // Frame 09: what was searched and where, the whole library one click away.
      const query = filters.search.trim();
      const inSection = !!collection || filters.onlyFavorites || filters.onlyInbox || filters.onlyTrash || filters.onlyReading || filters.onlyOffline;
      const title = query
        ? inSection
          ? t("empty.noResultsInFor", { section, query })
          : t("empty.noResultsFor", { query })
        : inSection
          ? t("empty.noResultsIn", { section })
          : t("empty.noResults");
      return {
        icon: Search,
        title,
        text: query ? t("empty.searchHint") : t("empty.noResultsHint"),
        actions: (
          <>
            {inSection && (
              <Button variant="primary" onClick={() => changeFilters(noSection)}>
                {t("empty.searchEverywhere")}
              </Button>
            )}
            <Button onClick={() => changeFilters({ search: "", tag: null, domain: null })}>
              {query ? t("empty.resetSearch") : t("empty.resetFilters")}
              {query && (
                <span aria-hidden>
                  <Kbd>Esc</Kbd>
                </span>
              )}
            </Button>
          </>
        ),
      };
    }
    if (filters.onlyTrash) return { icon: Trash2, title: t("empty.trash"), text: t("empty.trashHint"), actions: null };
    if (filters.onlyInbox) return { icon: InboxTray, title: t("empty.inbox"), text: t("empty.inboxHint"), actions: null };
    if (filters.onlyFavorites)
      return { icon: Heart, title: t("empty.noFavorites"), text: t("empty.noFavoritesHint"), actions: null };
    if (filters.onlyReading) return { icon: BookOpen, title: t("empty.reading"), text: t("empty.readingHint"), actions: null };
    if (filters.onlyOffline) return { icon: CircleArrowDown, title: t("empty.offline"), text: t("empty.offlineHint"), actions: null };
    if (collection)
      return {
        icon: Plus,
        title: t("empty.emptyCollection", { name: collection.name }),
        text: t("empty.emptyCollectionHint"),
        actions: <Button onClick={() => setSurface("add")}>{t("toolbar.add")}</Button>,
      };
    return {
      icon: null,
      title: t("empty.library"),
      text: t("empty.libraryHint"),
      actions: (
        <>
          <Button variant="primary" size="lg" onClick={() => setSurface("import")}>
            <Icon icon={ArrowDownToLine} size={15} />
            {t("empty.importBrowser")}
          </Button>
          <Button size="lg" onClick={() => setSurface("connect")}>
            <Icon icon={Link} size={15} />
            {t("empty.connect")}
          </Button>
          <Button size="lg" onClick={() => setSurface("add")}>
            {t("toolbar.add")}
          </Button>
        </>
      ),
      note: t("empty.local"),
    };
  })();

  const compact = narrow || (wide && !!editing);
  /** The selection bar is up: notices rise above it (frame 27). */
  const selecting = selection.ids.size > 0 && page === "library" && !triage;
  const content = library.bookmarks.length === 0 ? (
    library.loading ? (
      slowLoading ? (
        <div role="status" aria-label={t("library.loading")} className={view === "list" ? "flex flex-col gap-0.5" : gridClass(narrow, view === "dense")}>
          {Array.from({ length: 8 }, (_, i) =>
            view !== "list" ? (
              <div key={i} className={`flex flex-col ${view === "dense" ? "gap-2" : "gap-2.5"}`}>
                <div className="aspect-[16/10] rounded-xl bg-hover" />
                <div className="h-3 w-1/2 rounded-xs bg-hover" />
                <div className="h-3.5 w-4/5 rounded-xs bg-hover" />
              </div>
            ) : (
              <div key={i} className="h-[60px] rounded-xl bg-hover" />
            ),
          )}
        </div>
      ) : null
    ) : (
      <div className="mx-auto flex max-w-[480px] flex-col items-center gap-3 py-16 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-secondary text-icon">
          {empty.icon ? <Icon icon={empty.icon} size={20} /> : <Icon icon={ClipIcon} size={22} />}
        </span>
        <h2 className="text-xl font-semibold">{empty.title}</h2>
        <p className="text-sm text-muted">{empty.text}</p>
        {empty.actions && <div className="mt-2 flex flex-wrap justify-center gap-2">{empty.actions}</div>}
        {"note" in empty && <p className="mt-4 text-xs text-subtle">{empty.note}</p>}
      </div>
    )
  ) : (
    <BookmarkList
      view={view}
      bookmarks={library.bookmarks}
      collections={library.collections}
      actions={actions}
      narrow={narrow}
      compact={compact}
      scrollRef={scrollRef}
      dateGroups={library.dateGroups}
      grouped={!filters.onlyReading && (filters.onlyTrash || byTime(sort))}
      hasMore={library.hasMore}
      loadingMore={library.loadingMore}
      onMore={library.loadMore}
      selected={selection.ids}
      onSelect={selection.update}
      onClearSelection={selection.clear}
      // In the trash the selection is not dragged; while an action runs, nothing starts.
      onDragStart={filters.onlyTrash || bulkBusy ? undefined : startDrag}
      dragging={!!dragging}
      arrowsRef={arrowsRef}
      fresh={fresh}
    />
  );
  const toast = notice?.glass ? (
    <Toast
      glass
      docked={selecting}
      action={
        notice.undo ? (
          <button type="button" onClick={notice.undo}>
            {t("notice.undo")}
          </button>
        ) : (
          notice.show && (
            <button type="button" onClick={notice.show}>
              {t("add.show")}
            </button>
          )
        )
      }
    >
      {notice.text}
    </Toast>
  ) : notice ? (
    <Toast
      docked={selecting}
      tone={notice.alert ? "alert" : "status"}
      action={
        notice.undo ? (
          <button type="button" onClick={notice.undo} className="flex items-center gap-2 font-semibold text-[#8fd0ae]">
            {t("notice.undo")}
            <kbd className="rounded-xs bg-white/15 px-1.5 font-sans text-2xs font-normal text-white/80">{shortcut("Z")}</kbd>
          </button>
        ) : notice.show ? (
          <button type="button" onClick={notice.show} className="font-semibold text-[#8fd0ae]">
            {t("export.show")}
          </button>
        ) : (
          (notice.alert || notice.long) && (
            <span className="flex items-center gap-3">
              {notice.retry && (
                <button
                  type="button"
                  onClick={() => {
                    setNotice(null);
                    notice.retry?.();
                  }}
                  className="font-semibold text-[#8fd0ae]"
                >
                  {t("common.retry")}
                </button>
              )}
              <button type="button" aria-label={t("common.close")} onClick={() => setNotice(null)} className="text-white/70 hover:text-white">
                <Icon icon={X} size={14} />
              </button>
            </span>
          )
        )
      }
    >
      {notice.text}
    </Toast>
  ) : movedAside ? (
    <Toast
      docked={selecting}
      action={
        <button type="button" onClick={() => setMovedAside("")} className="font-semibold text-[#8fd0ae]">
          {t("common.ok")}
        </button>
      }
    >
      {t("library.movedAside", { path: movedAside })}
    </Toast>
  ) : null;

  const padding = narrow ? "px-6" : "px-8";
  return (
    <div className="flex h-full bg-bg text-ink">
      {/* Under the reading mode the library waits as it was (scroll, selection) and takes no focus;
          once the mode covers the window it is hidden too, or WKWebView paints its scrollbars on top. */}
      <div className={`contents ${reading && readingCovers ? "invisible" : ""}`} inert={!!reading}>
      <Sidebar
        narrow={narrow}
        filters={filters}
        settingsOpen={page === "settings"}
        duplicatesOpen={page === "duplicates"}
        counts={library.counts}
        collections={library.collections}
        tags={library.tags}
        capture={capture}
        update={update}
        onUpdate={() => setSurface("update")}
        plan={supporter?.available ? (supporter.plan ? "supporter" : "free") : null}
        onSupport={() => setSurface("supporter")}
        onPlan={() => setSurface("plan")}
        badge={badge}
        onInbox={openInbox}
        onAll={() => navigate()}
        onFavorites={() => navigate({ onlyFavorites: true })}
        onReading={() => navigate({ onlyReading: true })}
        onOffline={() => navigate({ onlyOffline: true })}
        onTrash={() => navigate({ onlyTrash: true })}
        onCollection={(id) => navigate({ collectionId: id })}
        onTag={(name) => changeFilters({ tag: filters.tag === name ? null : name })}
        onSettings={() => {
          setTriage(null);
          setPage("settings");
        }}
        onDuplicates={openDuplicates}
        linksOpen={page === "links"}
        onLinks={openLinks}
        onConnect={() => setSurface("connect")}
        onNewCollection={() => setSurface("collection")}
        onNewLink={() => setSurface("add")}
        onDeleteCollection={setDeletingCollection}
        onReorderCollections={(ids) => void library.reorderCollections(ids).catch((err) => say(describeError(err), true))}
        naming={
          naming !== null && selecting
            ? {
                suggested: naming.suggested,
                count: selection.ids.size,
                color: naming.color,
                onCreate: (name) => {
                  setNaming(null);
                  runBulk({ action: "new_collection", name });
                },
                onCancel: () => setNaming(null),
              }
            : null
        }
        dropping={dragging && { target: dragging.target }}
        notifications={notifications}
        onClearNotifications={clearNotifications}
        feeds={feeds}
        feedsOpen={page === "feeds"}
        feedUid={feedPlace.feed}
        onFeed={openFeeds}
        feedActions={feedActions}
      />
      {dragging && <DragStack drag={dragging} collections={library.collections} stack={selectionDrag.stack} place={selectionDrag.place} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <WindowBar />
        <div className="flex min-h-0 flex-1">
          <main className="relative flex min-w-0 flex-1 flex-col">
            {page === "settings" ? (
              <>
                <div className={`${padding} pt-2 pb-5`}>
                  <h1 className="flex h-9 items-center text-2xl font-semibold">{t("nav.settings")}</h1>
                </div>
                <div className={`min-h-0 flex-1 overflow-y-auto ${padding}`}>
                  <SettingsPage
                    theme={theme}
                    onTheme={setTheme}
                    settings={settings}
                    capture={capture}
                    onSettings={setSettings}
                    onCapture={setCapture}
                    onConnect={() => setSurface("connect")}
                    onConnectAssistant={() => setSurface("assistant")}
                    onCopy={(text) => void copy(text)}
                    onNotice={say}
                    onSaveCopy={saveBackupCopy}
                    onRestoreBackup={() => setSurface("backup")}
                    onFeedback={() => setSurface("feedback")}
                    update={update}
                    onUpdate={() => setSurface("update")}
                    onCheckUpdates={async () => setUpdate(await api.checkForUpdates())}
                    dataVersion={dataVersion}
                    supporter={supporter}
                    sync={sync}
                    onSync={() => setSurface("sync")}
                    onSupporter={() => setSurface("supporter")}
                    onImportFeeds={() => setSurface("importFeeds")}
                    onExportFeeds={exportFeeds}
                    previews={previews.run}
                    onRefreshPreviews={(scope) => void previews.start({ scope }).catch((err) => say(describeError(err), true))}
                    onStopPreviews={() => void previews.stop()}
                    openLinks={linkTarget}
                    onOpenLinks={(target) => {
                      setLinkTarget(target);
                      savePreference("openLinks", target);
                    }}
                  />
                </div>
              </>
            ) : page === "feeds" ? (
              <FeedsPage
                feeds={feeds ?? []}
                refreshing={feedsRefreshing}
                feedUid={feedPlace.feed}
                itemId={feedPlace.item}
                onFeed={openFeeds}
                onItem={(item) => setFeedPlace((place) => ({ ...place, item }))}
                narrow={narrow}
                blocked={!!editing || surface !== null || !!reading || !!purging || !!deletingCollection}
                look={readerLook.look}
                aa={{
                  choice: readerLook.choice,
                  unlocked: readerLook.unlocked,
                  onChoice: readerLook.setChoice,
                  onLocked: (wish) => {
                    readerLook.wish(wish);
                    setSurface("supporter");
                  },
                  onSupporter: () => setSurface("supporter"),
                }}
                onOpen={open}
                onNotice={({ text, alert = false, undo, glass = false }) => setNotice({ text, alert, undo, glass })}
                onUnsave={(id) => unsave(id, false)}
                onUndo={undoing}
                onNewLink={() => setSurface("add")}
              />
            ) : page === "duplicates" ? (
              <DuplicatesPage
                collections={library.collections}
                padding={padding}
                onMerged={(merged) => setNotice({ text: mergedNotice(t, merged), alert: false, undo: undoing(merged.command) })}
                onHidden={(key, ids) =>
                  setNotice({
                    text: t("duplicates.hidden", { key }),
                    alert: false,
                    undo: () => {
                      setNotice(null);
                      void api.undismissDuplicates(key, ids).catch((err) => say(describeError(err), true));
                    },
                  })
                }
                onFailed={sayAlert}
              />
            ) : page === "links" ? (
              <LinkCheckPage
                collections={library.collections}
                padding={padding}
                onOpen={actions.open}
                onDone={(text, alert, command) => setNotice({ text, alert, undo: alert ? undefined : undoing(command) })}
                onFailed={sayAlert}
              />
            ) : triage ? (
              <Triage
                collections={library.collections}
                blocked={!!editing || surface !== null || !!purging || !!deletingCollection}
                notify={(next) => setNotice(next && { alert: false, ...next })}
                onOpen={actions.open}
                onEdit={(b, hooks) => {
                  editorFocus.current = document.activeElement as HTMLElement;
                  editHooks.current = hooks;
                  setEditing(b);
                }}
                onFinish={finishTriage}
                onLibrary={() => navigate()}
                noticeUp={!!notice || !!movedAside}
              />
            ) : (
              <>
                {/* 13 + 7 px above the list: room for the selection ring of the first row. */}
                <div className={`flex flex-col gap-4 ${padding} pt-2 pb-[13px]`}>
                  <Toolbar
                    ref={searchRef}
                    title={section}
                    count={narrowed ? t("toolbar.found", { count: library.total, total: sectionCount }) : sectionCount}
                    countLive={narrowed}
                    narrow={narrow}
                    search={filters.search}
                    view={view}
                    sort={filters.onlyTrash || filters.onlyReading ? null : sort}
                    onSearch={(search) => changeFilters({ search })}
                    onView={setView}
                    onSort={setSort}
                    onImport={() => setSurface("import")}
                    onImportFeeds={() => setSurface("importFeeds")}
                    onExport={exportLibrary}
                    onRestore={() => setSurface("restore")}
                    duplicates={library.counts.duplicates}
                    onDuplicates={openDuplicates}
                    links={library.counts.links}
                    onLinks={openLinks}
                    onRead={() => openReading()}
                    readRef={readButton}
                  />
                  {damaged && (
                    <Banner
                      action={
                        <span className="flex shrink-0 gap-2">
                          <Button variant="onDanger" onClick={() => setSurface("backup")}>
                            {t("library.restore")}
                          </Button>
                          <Button variant="onDanger" onClick={() => void api.revealLibraryPlace("backups").catch((err) => say(describeError(err), true))}>
                            {t("library.openBackups")}
                          </Button>
                        </span>
                      }
                    >
                      {latestCopy
                        ? t("library.damagedLatest", { when: copyTime(latestCopy.created_at, t, i18n.language, true) })
                        : t("library.damaged")}
                    </Banner>
                  )}
                  {library.error && (
                    <Banner
                      action={
                        <Button
                          variant="onDanger"
                          onClick={() => {
                            void library.refresh();
                            void library.refreshCatalog();
                          }}
                        >
                          {t("common.retry")}
                        </Button>
                      }
                    >
                      {library.error}
                    </Banner>
                  )}
                  {inboxBanner && (
                    // The Inbox section's way into triage (2026-10-16): a raised pill, not a banner across the
                    // page; it cannot be hidden here and goes when the inbox is empty. Elsewhere the bell tells.
                    <section aria-label={t("inbox.bannerLabel")} className="inbox-pill">
                      {inboxThumbs.length > 0 && (
                        <span className="nt-thumbs" aria-hidden>
                          {inboxThumbs.slice(0, 3).map((b) => (
                            <span key={b.id} className="nt-thumb">
                              <Preview b={b} small />
                            </span>
                          ))}
                        </span>
                      )}
                      <p className="inbox-pill-text">
                        <b>{t("notifications.inboxTitle", { count: counts.inbox })}</b>
                        <span>{inboxLine}</span>
                      </p>
                      <button type="button" onClick={openTriage} className="inbox-pill-sort">
                        {t("inbox.sort")}
                        <Icon icon={ChevronRight} size={13} />
                      </button>
                    </section>
                  )}
                  {filters.onlyTrash && counts.trash > 0 && (
                    // Frame 25: how long the trash keeps things, what restoring brings back, and emptying it.
                    <div className="flex items-center gap-3 rounded-xl bg-panel py-1.5 pr-1.5 pl-3 text-sm text-icon">
                      <p className="min-w-0 flex-1 py-1">{t("trash.note")}</p>
                      <button
                        type="button"
                        onClick={() => setPurging("all")}
                        className="flex h-[27px] shrink-0 items-center rounded-md border border-border bg-card px-2.5 text-xs font-medium text-ink transition-colors duration-150 hover:bg-hover"
                      >
                        {t("trash.empty")}
                      </button>
                    </div>
                  )}
                  {(filters.tag || filters.domain || library.pendingCount > 0) && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                      {filters.domain && (
                        <button
                          type="button"
                          onClick={() => changeFilters({ domain: null })}
                          className="flex items-center gap-1 rounded-sm bg-accent-soft px-2 py-0.5 text-on-accent-soft"
                          aria-label={t("toolbar.clearDomain", { domain: filters.domain })}
                        >
                          {t("toolbar.domainChip", { domain: filters.domain })}
                          <Icon icon={X} size={12} />
                        </button>
                      )}
                      {filters.tag && (
                        <button
                          type="button"
                          onClick={() => changeFilters({ tag: null })}
                          className="flex items-center gap-1 rounded-sm bg-accent-soft px-2 py-0.5 text-on-accent-soft"
                          aria-label={t("toolbar.clearTag", { tag: filters.tag })}
                        >
                          #{filters.tag}
                          <Icon icon={X} size={12} />
                        </button>
                      )}
                      {library.pendingCount > 0 && (
                        <button
                          type="button"
                          onClick={library.reveal}
                          className="flex items-center gap-1 rounded-sm bg-accent px-2 py-0.5 font-medium text-on-accent"
                        >
                          {t("library.newBookmarks", { count: library.pendingCount })}
                          <Icon icon={ChevronDown} size={12} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div
                  ref={scrollRef}
                  data-scroll="main"
                  className={`min-h-0 flex-1 overflow-y-auto ${padding} pt-[7px] ${selecting ? "pb-[120px]" : "pb-8"}`}
                >
                  {content}
                </div>
                {selecting && (
                  // Frames 04 and 27: the bar 24 px above the bottom, a message under it when there is one, notices above it.
                  <div
                    className="pointer-events-none absolute inset-x-0 bottom-6 z-30 flex flex-col items-center gap-2 px-4 *:pointer-events-auto"
                  >
                    {!reading && toast}
                    <SelectionBar
                      count={selection.ids.size}
                      hidden={selection.hidden}
                      narrowed={narrowed}
                      trash={filters.onlyTrash}
                      allStarred={selection.allStarred}
                      inReading={filters.onlyReading}
                      busy={bulkBusy}
                      collections={library.collections}
                      tags={library.tags}
                      actions={selectionActions}
                      onClear={selection.clear}
                      dragging={!!dragging}
                    />
                  </div>
                )}
              </>
            )}
          </main>
          {editing && wide && (
            <aside className="w-[380px] shrink-0 animate-appear overflow-y-auto border-l border-border bg-card p-6" aria-label={t("editor.label")}>
              <header className="mb-5 flex items-center justify-between">
                <h2 className="text-lg font-semibold">{t("editor.label")}</h2>
                <span className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-label={t("editor.close")}
                    onClick={closeEditor}
                    className="flex size-[30px] items-center justify-center rounded-md text-icon hover:bg-hover hover:text-ink"
                  >
                    <Icon icon={X} />
                  </button>
                  <span aria-hidden>
                    <Kbd>Esc</Kbd>
                  </span>
                </span>
              </header>
              {editor}
            </aside>
          )}
        </div>
      </div>
      </div>

      {editing && !wide && (
        <Dialog title={t("editor.label")} drawer onClose={closeEditor}>
          {editor}
        </Dialog>
      )}
      {surface === "add" && (
        <AddSheet
          collections={library.collections}
          destination={destinationOf(filters)}
          collectionId={filters.collectionId}
          onClose={() => setSurface(null)}
          onShow={(b) => {
            setSurface(null);
            editorFocus.current = null;
            setEditing(b);
          }}
          onShowFeed={(uid) => {
            setSurface(null);
            openFeeds(uid);
          }}
          onSave={async (link) => {
            const added = await saveLink(link);
            if (added.existing) return added.bookmark;
            setSurface(null);
            return null;
          }}
        />
      )}
      {(surface === "import" || surface === "importFeeds") && (
        <ImportDialog
          kind={surface === "importFeeds" ? "feeds" : "bookmarks"}
          onClose={() => setSurface(null)}
          onImport={async (content, toInbox) => {
            const summary = await api.importHtmlBookmarks(content, toInbox);
            if (importOffer) endImportOffer();
            await Promise.all([library.refresh(), library.refreshCatalog()]);
            return summary;
          }}
          onOpenInbox={() => {
            setSurface(null);
            openInbox();
          }}
        />
      )}
      {surface === "restore" && (
        <RestoreDialog
          onClose={() => setSurface(null)}
          onRestore={async (content, mode) => {
            const outcome = await api.restoreLibrary(content, mode);
            if (outcome.outcome === "restored") {
              // After a replace no open editor or selection points at a bookmark that is gone.
              closeEditor();
              selection.clear();
              if (mode === "replace") library.replaced();
              await Promise.all([library.refresh(), library.refreshCatalog()]);
            }
            return outcome;
          }}
          onShowBackups={() => void api.revealLibraryPlace("backups").catch((err) => say(describeError(err), true))}
        />
      )}
      {surface === "backup" && (
        <BackupRestoreDialog
          current={counts.total}
          onClose={() => setSurface(null)}
          onRestored={async () => {
            // The whole library changed: nothing open may point at what is gone.
            closeEditor();
            selection.clear();
            library.replaced();
            setDataVersion((version) => version + 1);
            await Promise.all([library.refresh(), library.refreshCatalog()]);
          }}
        />
      )}
      {surface === "feedback" && (
        <FeedbackDialog draft={feedbackDraft} onDraft={setFeedbackDraft} onClose={() => setSurface(null)} />
      )}
      {surface === "collection" && (
        <CollectionDialog
          onClose={() => setSurface(null)}
          onCreate={async (name) => {
            await api.createCollection(name);
            await library.refreshCatalog();
            setSurface(null);
          }}
        />
      )}
      {surface === "selectionCollection" && (
        <CollectionDialog
          initial={offeredName()}
          onClose={() => setSurface(null)}
          onCreate={async (name) => {
            const result = await api.bulkUpdate([...selection.ids], { action: "new_collection", name });
            await library.refreshCatalog();
            setSurface(null);
            say(bulkNotice(t, { action: "new_collection", name }, result.count), false, undoing(result.command));
          }}
        />
      )}
      {surface === "background" && <BackgroundDialog onClose={() => setSurface(null)} />}
      {surface === "supporter" && (
        <SupporterDialog
          sandbox={!!supporter?.sandbox}
          email={supporter?.email ?? null}
          awaitingSignIn={!!supporter?.awaiting_sign_in}
          paid={!!supporter?.plan}
          planUnknown={!!supporter?.plan_unknown}
          onClose={() => setSurface(null)}
          onSignIn={() => setSurface("signIn")}
        />
      )}
      {surface === "signIn" && <SignInDialog onClose={() => setSurface(null)} onPlans={() => setSurface("supporter")} />}
      {surface === "plan" && supporter?.plan && (
        <PlanDialog
          supporter={supporter}
          badge={badge}
          onBadge={(shown) => {
            setBadge(shown);
            savePreference("supporterBadge", shown ? "on" : "off");
          }}
          onClose={() => setSurface(null)}
          onUpgrade={() => {
            setUpgradeFrom(supporter.plan);
            setSurface("upgrade");
          }}
          sync={sync}
          onSync={() => setSurface("sync")}
        />
      )}
      {surface === "sync" && sync && (
        <SyncDialog
          status={sync}
          plan={supporter?.plan ?? null}
          onStatus={setSync}
          onClose={() => setSurface(null)}
          onCopy={(text) => void copy(text)}
          onUpdate={() => {
            // No version on offer yet: Settings → Updates, where it is checked for.
            if (offer(update)) return setSurface("update");
            setSurface(null);
            setTriage(null);
            setPage("settings");
          }}
          onRenew={() => setSurface(supporter?.plan ? "plan" : "supporter")}
          onSignIn={() => setSurface("signIn")}
        />
      )}
      {/* Supporter → 5 years from a subscription (sheet 45): the plans dialog with the five years only,
          about the subscription as it was when the switch was chosen. */}
      {surface === "upgrade" && supporter && upgradeFrom && (
        <SupporterDialog
          sandbox={!!supporter.sandbox}
          email={supporter.email ?? null}
          paid
          upgrade={upgradeFrom}
          onClose={() => setSurface(null)}
          onSignIn={() => setSurface("signIn")}
        />
      )}
      {surface === "update" && offer(update) && (
        <UpdateDialog
          update={offer(update)!}
          current={appVersion}
          linux={linux}
          onClose={() => setSurface(null)}
          onInstall={() => void api.installUpdate().catch((err) => say(describeError(err), true))}
          onCancel={() => void api.cancelUpdate().catch((err) => say(describeError(err), true))}
          onOpen={(url) => void api.openUrl(url).catch((err) => say(describeError(err), true))}
        />
      )}
      {surface === "assistant" && (
        <AssistantDialog onCopy={(text) => void copy(text)} onNotice={say} onClose={() => setSurface(null)} />
      )}
      {surface === "connect" && (
        <ConnectDialog capture={capture} onOpen={actions.open} onClose={() => setSurface(null)} />
      )}
      {deletingCollection && (
        <ConfirmDialog
          title={t("confirm.deleteCollection")}
          text={t("confirm.deleteCollectionText", { name: deletingCollection.name })}
          confirm={t("confirm.delete")}
          onClose={() => setDeletingCollection(null)}
          onConfirm={async () => {
            await api.deleteCollection(deletingCollection.id);
            if (filters.collectionId === deletingCollection.id) navigate();
            await Promise.all([library.refresh(), library.refreshCatalog()]);
            setDeletingCollection(null);
            say(t("notice.deleted"));
          }}
        />
      )}

      {purging && (
        // Frame 26: deleting for good is confirmed every time and cannot be undone.
        <ConfirmDialog
          title={purging === "all" ? t("confirm.emptyTrash") : t("confirm.deleteForever")}
          text={
            purging === "all"
              ? t("confirm.emptyTrashText", { count: counts.trash })
              : "selected" in purging
                ? t("confirm.emptyTrashText", { count: purging.selected.length })
                : t("confirm.deleteForeverText", { title: purging.title || purging.url })
          }
          confirm={t("confirm.deleteForeverButton")}
          onClose={() => setPurging(null)}
          onConfirm={async () => {
            if (purging === "all") {
              const count = await api.emptyTrash();
              say(t("notice.emptied", { count }));
            } else if ("selected" in purging) {
              const count = await api.deleteForeverMany(purging.selected);
              selection.clear();
              say(t("bulk.purged", { count }));
            } else {
              await api.deleteForever(purging.id);
              say(t("notice.purged"));
            }
            setPurging(null);
          }}
        />
      )}

      {sheet && page === "library" && !triage && sheetBookmarks.length > 0 && (
        <ReadingSheet
          bookmarks={sheetBookmarks}
          index={Math.min(sheet.index, sheetBookmarks.length - 1)}
          section={section}
          onIndex={(index) => {
            setSheet({ ...sheet, index });
            const b = sheetBookmarks[index];
            if (selectionRef.current.ids.has(b.id)) selectionRef.current.setLast(b.id);
          }}
          onOpen={open}
          onFavorite={actions.favorite}
          onClose={() => setSheet(null)}
          onSaveOffline={saveOfflineCopy}
          onRemoveOffline={removeOfflineCopy}
          look={readerLook.look}
        />
      )}
      {reading && (
        <ReadingMode
          narrow={narrow}
          origin={readingOrigin}
          source={reading.source}
          start={reading.start}
          section={{
            name: section,
            reading: filters.onlyReading,
            available: !filters.onlyTrash,
            items: library.bookmarks,
            hasMore: library.hasMore,
            onMore: library.loadMore,
          }}
          onOpen={open}
          onMarkRead={(b) => readingChange(b, { action: "read", read: true })}
          onRemove={(b) => readingChange(b, { action: "reading", reading: false })}
          onClose={closeReading}
          onCovers={setReadingCovers}
          onSaveOffline={saveOfflineCopy}
          onRemoveOffline={removeOfflineCopy}
          look={readerLook.look}
          aa={{
            choice: readerLook.choice,
            unlocked: readerLook.unlocked,
            onChoice: readerLook.setChoice,
            onLocked: (wish) => {
              readerLook.wish(wish);
              setSurface("supporter");
            },
            onSupporter: () => setSurface("supporter"),
          }}
        />
      )}
      {feedMenu.dialogs}
      {/* NP-123: a click that selects or unselects is said, not only shown; not a status, so notices stay apart. */}
      <p aria-live="polite" data-announcer className="sr-only">
        {announcement}
      </p>
      {(!selecting || reading) && toast}
      {veil && (
        <div className="drop-veil" data-drop-veil={veil.inbox ? "inbox" : "library"} aria-hidden>
          <div>
            <span className="drop-veil-ring">
              <Icon icon={Plus} size={26} strokeWidth={2} />
            </span>
            <b className="block text-lg font-bold tracking-[-0.01em]">{t("add.dropTitle")}</b>
            <span className="mt-1 block text-sm text-muted">
              {veil.inbox || destinationOf(filters) === "inbox" ? t("add.dropHintInbox") : t("add.dropHint", { place: dropPlace })}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function gridClass(narrow: boolean, dense: boolean) {
  if (dense) return `grid gap-x-4 gap-y-[22px] ${narrow ? "grid-cols-[repeat(auto-fill,minmax(136px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(172px,1fr))]"}`;
  return `grid gap-x-6 gap-y-7 ${narrow ? "grid-cols-[repeat(auto-fill,minmax(190px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(240px,1fr))]"}`;
}
