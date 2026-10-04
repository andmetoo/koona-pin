import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ChevronDown, ChevronRight, Inbox, Link, Plus, Search, Star, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, isTauri } from "./services/api";
import { describeError } from "./services/errors";
import { undoNotice } from "./services/undo";
import { applyTheme, isDark, preference, savePreference, storedTheme, storedValue, Theme } from "./services/preferences";
import { AppSettings, Bookmark, CaptureStatus, Collection, FilterState, LibraryStatus, ViewMode } from "./types";
import { useLibrary } from "./hooks/useLibrary";
import { Icon, PinIcon } from "./components/icons";
import { Button } from "./components/ui/Button";
import { Banner, Toast } from "./components/ui/Notices";
import { Hint, Kbd } from "./components/ui/Hint";
import { Dialog } from "./components/ui/Dialog";
import { WindowBar } from "./components/ui/WindowBar";
import { Sidebar } from "./components/shell/Sidebar";
import { Toolbar } from "./components/shell/Toolbar";
import { BookmarkActions } from "./components/library/Bookmarks";
import { BookmarkList } from "./components/library/BookmarkList";
import { BookmarkEditor } from "./components/library/BookmarkEditor";
import { EditHooks, Triage } from "./components/library/Triage";
import { AddLinkDialog, CollectionDialog, ConfirmDialog, ConnectDialog, ImportDialog } from "./components/library/Dialogs";
import { SettingsPage } from "./components/settings/SettingsPage";

type Surface = "add" | "import" | "connect" | "collection" | null;
/**
 * `undo` turns the notice into «… · Отменить Ctrl Z» for 8 seconds (frame 12);
 * `retry` adds «Повторить» to an alert (frame 20); `long` keeps a plain notice
 * 8 seconds with a close button (frame 21).
 */
type Notice = { text: string; alert: boolean; undo?: () => void; retry?: () => void; long?: boolean } | null;
type Section = Partial<Pick<FilterState, "collectionId" | "onlyFavorites" | "onlyInbox" | "onlyTrash">>;
const initialFilters: FilterState = {
  search: "",
  collectionId: null,
  tag: null,
  domain: null,
  onlyFavorites: false,
  onlyInbox: false,
  onlyTrash: false,
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
  const { t } = useTranslation();
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const systemDark = useMedia("(prefers-color-scheme: dark)");
  const narrow = useMedia(NARROW);
  const wide = useMedia(WIDE);
  const [view, setView] = useState<ViewMode>(() => preference("view", ["grid", "list"], "grid"));
  const [filters, setFilters] = useState(initialFilters);
  const [page, setPage] = useState<"library" | "settings">("library");
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const library = useLibrary(filters, scrollRef);
  const [surface, setSurface] = useState<Surface>(null);
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [deletingCollection, setDeletingCollection] = useState<Collection | null>(null);
  /** What the confirmation (frame 26) would delete for good: one bookmark or the whole trash. */
  const [purging, setPurging] = useState<Bookmark | "all" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [capture, setCapture] = useState<CaptureStatus | null>(null);
  const [damaged, setDamaged] = useState(false);
  const [movedAside, setMovedAside] = useState("");
  const [slowLoading, setSlowLoading] = useState(false);
  /** The newest inbox bookmark when the banner was hidden: it returns for a newer one. */
  const [bannerHidden, setBannerHidden] = useState(() => storedValue("inboxBannerHidden"));
  const editorFocus = useRef<HTMLElement | null>(null);
  /** Inbox triage (NP-025) and the filters to go back to when it ends. */
  const [triage, setTriage] = useState<FilterState | null>(null);
  /** The editor opened from triage: its save and «В корзину» are triage decisions. */
  const editHooks = useRef<EditHooks | null>(null);
  const dark = isDark(theme, systemDark);
  const say = (text: string, alert = false, undo?: () => void) => setNotice({ text, alert, undo });
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
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "k") {
        e.preventDefault();
        setPage("library");
        setTriage(null);
        requestAnimationFrame(() => searchRef.current?.focus());
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
      const layer = editing || triage || document.querySelector("dialog[open], [data-menu]");
      if ((e.ctrlKey || e.metaKey) && key === "z" && !e.shiftKey && !typing && !layer) {
        e.preventDefault();
        undoRef.current();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [wide, editing, triage]);
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
  /** One section at a time: All, Inbox, Favorites, Trash or a collection. */
  const navigate = (section: Section = {}) =>
    changeFilters({ collectionId: null, onlyFavorites: false, onlyInbox: false, onlyTrash: false, ...section, tag: null, domain: null });
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
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      say(t("notice.copied"));
    } catch {
      say(t("notice.copyFailed"), true);
    }
  };
  const actions: BookmarkActions = useMemo(
    () => ({
      open: (url) => void api.openUrl(url).catch((err) => say(describeError(err), true)),
      copy: (url) => void copy(url),
      edit: (b) => {
        editorFocus.current = document.activeElement as HTMLElement;
        setEditing(b);
      },
      favorite: (b) => void api.updateBookmark(b.id, { is_favorite: !b.is_favorite }).catch((err) => say(describeError(err), true)),
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
    }),
    [library.collections, t],
  );
  const closeEditor = () => {
    editHooks.current = null;
    setEditing(null);
    editorFocus.current?.focus();
  };

  const collection = library.collections.find((c) => c.id === filters.collectionId);
  const { counts } = library;
  const section = filters.onlyTrash
    ? t("nav.trash")
    : filters.onlyInbox
      ? t("nav.inbox")
      : filters.onlyFavorites
        ? t("nav.favorites")
        : collection
          ? collection.name
          : t("nav.all");
  const sectionCount = filters.onlyTrash
    ? counts.trash
    : filters.onlyInbox
      ? counts.inbox
      : filters.onlyFavorites
        ? counts.favorites
        : collection
          ? (collection.count ?? 0)
          : counts.total;
  // Hidden until a bookmark newer than the remembered one arrives (NP-020).
  // In the inbox itself it always leads to triage (NP-025), there is no other
  // way in; the trash is about what was thrown away (frame 25).
  const inboxBanner =
    counts.inbox > 0 &&
    !filters.onlyTrash &&
    (filters.onlyInbox || !(bannerHidden && counts.inbox_newest && counts.inbox_newest <= bannerHidden));
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
      const inSection = !!collection || filters.onlyFavorites || filters.onlyInbox || filters.onlyTrash;
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
              <Button variant="primary" onClick={() => changeFilters({ collectionId: null, onlyFavorites: false, onlyInbox: false, onlyTrash: false })}>
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
    if (filters.onlyInbox) return { icon: Inbox, title: t("empty.inbox"), text: t("empty.inboxHint"), actions: null };
    if (filters.onlyFavorites)
      return { icon: Star, title: t("empty.noFavorites"), text: t("empty.noFavoritesHint"), actions: null };
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

  const content = library.bookmarks.length === 0 ? (
    library.loading ? (
      slowLoading ? (
        <div role="status" aria-label={t("library.loading")} className={view === "grid" ? gridClass(narrow) : "flex flex-col gap-0.5"}>
          {Array.from({ length: 8 }, (_, i) =>
            view === "grid" ? (
              <div key={i} className="flex flex-col gap-2.5">
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
          {empty.icon ? <Icon icon={empty.icon} size={20} /> : <PinIcon size={22} />}
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
      compact={narrow || (wide && !!editing)}
      scrollRef={scrollRef}
      dateGroups={library.dateGroups}
      hasMore={library.hasMore}
      loadingMore={library.loadingMore}
      onMore={library.loadMore}
    />
  );

  const padding = narrow ? "px-6" : "px-8";
  return (
    <div className="flex h-full bg-bg text-ink">
      <Sidebar
        narrow={narrow}
        filters={filters}
        settingsOpen={page === "settings"}
        counts={library.counts}
        collections={library.collections}
        tags={library.tags}
        capture={capture}
        onInbox={openInbox}
        onAll={() => navigate()}
        onFavorites={() => navigate({ onlyFavorites: true })}
        onTrash={() => navigate({ onlyTrash: true })}
        onCollection={(id) => navigate({ collectionId: id })}
        onTag={(name) => changeFilters({ tag: filters.tag === name ? null : name })}
        onSettings={() => {
          setTriage(null);
          setPage("settings");
        }}
        onConnect={() => setSurface("connect")}
        onNewCollection={() => setSurface("collection")}
        onDeleteCollection={setDeletingCollection}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <WindowBar />
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col">
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
                    onCopy={(text) => void copy(text)}
                    onNotice={say}
                  />
                </div>
              </>
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
              />
            ) : (
              <>
                <div className={`flex flex-col gap-4 ${padding} pt-2 pb-5`}>
                  <Toolbar
                    ref={searchRef}
                    title={section}
                    count={narrowed ? t("toolbar.found", { count: library.total, total: sectionCount }) : sectionCount}
                    countLive={narrowed}
                    narrow={narrow}
                    search={filters.search}
                    view={view}
                    onSearch={(search) => changeFilters({ search })}
                    onView={setView}
                    onImport={() => setSurface("import")}
                    onAdd={() => setSurface("add")}
                  />
                  {capture?.state === "failing" && (
                    <Banner
                      action={
                        <Button variant="onDanger" onClick={() => setPage("settings")}>
                          {t("browser.details")}
                        </Button>
                      }
                    >
                      {t(`browser.banner_${capture.problem ?? "channel"}`)}
                    </Banner>
                  )}
                  {damaged && (
                    <Banner
                      action={
                        <Button variant="onDanger" onClick={() => void api.revealLibraryPlace("backups").catch((err) => say(describeError(err), true))}>
                          {t("library.openBackups")}
                        </Button>
                      }
                    >
                      {t("library.damaged")}
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
                    <Banner
                      tone="accent"
                      label={t("inbox.bannerLabel")}
                      icon={<Icon icon={Inbox} size={18} />}
                      action={
                        <span className="flex shrink-0 items-center gap-3">
                          <Button variant="primary" onClick={openTriage}>
                            {t("inbox.sort")}
                            <Icon icon={ChevronRight} size={13} />
                          </Button>
                          {!filters.onlyInbox && (
                          <Hint label={t("inbox.hide")}>
                            <button
                              type="button"
                              aria-label={t("inbox.hide")}
                              onClick={hideBanner}
                              className="flex size-6 items-center justify-center rounded-md text-accent-muted transition-colors duration-150 hover:text-on-accent-soft"
                            >
                              <Icon icon={X} size={14} />
                            </button>
                          </Hint>
                          )}
                        </span>
                      }
                    >
                      {narrow
                        ? t("inbox.bannerShort", { count: counts.inbox })
                        : counts.inbox > QUICK_INBOX
                          ? t("inbox.bannerMany", { count: counts.inbox })
                          : t("inbox.banner", { count: counts.inbox })}
                    </Banner>
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
                <div ref={scrollRef} data-scroll="main" className={`min-h-0 flex-1 overflow-y-auto ${padding} pb-8`}>
                  {content}
                </div>
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

      {editing && !wide && (
        <Dialog title={t("editor.label")} drawer onClose={closeEditor}>
          {editor}
        </Dialog>
      )}
      {surface === "add" && (
        <AddLinkDialog
          collections={library.collections}
          collectionId={filters.collectionId}
          onClose={() => setSurface(null)}
          onAdd={async (data) => {
            const added = await api.addBookmark(data);
            scrollRef.current?.scrollTo({ top: 0 });
            await library.refresh();
            setSurface(null);
            say(added.restored ? t("notice.restoredLink") : t("notice.linkSaved"));
          }}
        />
      )}
      {surface === "import" && (
        <ImportDialog
          onClose={() => setSurface(null)}
          onImport={async (content) => {
            const { imported, in_trash } = await api.importHtmlBookmarks(content);
            await Promise.all([library.refresh(), library.refreshCatalog()]);
            setSurface(null);
            // A link in the trash stays there: the import does not undo a clean-up.
            say(in_trash > 0 ? t("notice.importedTrash", { count: imported, trash: in_trash }) : t("notice.imported", { count: imported }));
          }}
        />
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
              : t("confirm.deleteForeverText", { title: purging.title || purging.url })
          }
          confirm={t("confirm.deleteForeverButton")}
          onClose={() => setPurging(null)}
          onConfirm={async () => {
            if (purging === "all") {
              const count = await api.emptyTrash();
              say(t("notice.emptied", { count }));
            } else {
              await api.deleteForever(purging.id);
              say(t("notice.purged"));
            }
            setPurging(null);
          }}
        />
      )}

      {notice ? (
        <Toast
          tone={notice.alert ? "alert" : "status"}
          action={
            notice.undo ? (
              <button type="button" onClick={notice.undo} className="flex items-center gap-2 font-semibold text-[#8fd0ae]">
                {t("notice.undo")}
                <kbd className="rounded-xs bg-white/15 px-1.5 font-sans text-2xs font-normal text-white/80">Ctrl Z</kbd>
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
          action={
            <button type="button" onClick={() => setMovedAside("")} className="font-semibold text-[#8fd0ae]">
              {t("common.ok")}
            </button>
          }
        >
          {t("library.movedAside", { path: movedAside })}
        </Toast>
      ) : null}
    </div>
  );
}

function gridClass(narrow: boolean) {
  return `grid gap-x-6 gap-y-7 ${narrow ? "grid-cols-[repeat(auto-fill,minmax(190px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(240px,1fr))]"}`;
}
