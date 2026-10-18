import type { ReactNode } from "react";
import { ArrowDown, ArrowDownToLine, BookOpen, ChevronDown, ChevronRight, CircleArrowDown, Heart, Link, Plus, Search, Trash2, X } from "lucide-react";
import type { AppState } from "../../app/appState";
import { inboxLine } from "../../app/notifications";
import { noSection } from "../../app/sections";
import { capabilities } from "../../platform/capabilities";
import { destinationOf } from "../../services/addLink";
import { api, desktopApi, desktopOnly } from "../../services/api";
import { bulkNotice } from "../../services/bulk";
import { mergedNotice } from "../../services/duplicates";
import { describeError } from "../../services/errors";
import { shortcut } from "../../services/keys";
import { byTime } from "../../services/library";
import { openRequests, refusedByName } from "../../services/openRequests";
import { savePreference } from "../../services/preferences";
import { offer } from "../../services/update";
import { BackupRestoreDialog, copyTime } from "../BackupRestoreDialog";
import { SyncDialog } from "../commercial/SyncDialog";
import { FeedbackDialog } from "../FeedbackDialog";
import { FeedsPage } from "../feeds/FeedsPage";
import { ClipIcon, Icon, InboxTray } from "../icons";
import { AddSheet } from "../library/AddSheet";
import { BookmarkEditor } from "../library/BookmarkEditor";
import { BookmarkList } from "../library/BookmarkList";
import { Preview } from "../library/Bookmarks";
import { CollectionDialog, ConfirmDialog, ConnectDialog, ImportDialog, RestoreDialog } from "../library/Dialogs";
import { DragStack } from "../library/DragStack";
import { DuplicatesPage } from "../library/DuplicatesPage";
import { LinkCheckPage } from "../library/LinkCheckPage";
import { SelectionBar } from "../library/SelectionBar";
import { ShareListDialog } from "../library/ShareListDialog";
import { Triage } from "../library/Triage";
import { ListImportDialog } from "../ListImportDialog";
import { ReadingMode } from "../reader/ReadingMode";
import { ReadingSheet } from "../reader/ReadingSheet";
import { SettingsPage } from "../settings/SettingsPage";
import { PlanDialog, SignInDialog, SupporterDialog } from "../SupporterDialog";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Kbd } from "../ui/Hint";
import { Banner, Toast } from "../ui/Notices";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";

/**
 * Today's library window (NP-072a): the sidebar, the toolbar over the list, the pages, the editor,
 * the reading sheet and mode, the notices and the dialogs, over the state of `useAppState`.
 *
 * Both shells render it for now: the desktop shell with its window bar and its own dialogs in
 * `windowBar` and `overlays`, the phone shell as it was after NP-151. NP-072b gives the phone its own
 * screens; this then belongs to the desktop shell alone.
 */
export function Workspace({ app, windowBar, overlays }: { app: AppState; windowBar?: ReactNode; overlays?: ReactNode }) {
  const {
    actions,
    announcement,
    arrowsRef,
    badge,
    bulkBusy,
    capture,
    changeFilters,
    clearNotifications,
    closeEditor,
    closeReading,
    collection,
    compact,
    copy,
    counts,
    damaged,
    dataVersion,
    deleteEdit,
    deletingCollection,
    desktop,
    dragging,
    droppedFile,
    dropPlace,
    editHooks,
    editing,
    editorFocus,
    endImportOffer,
    exportFeeds,
    exportLibrary,
    feedActions,
    feedbackDraft,
    feedMenu,
    feedPlace,
    feeds,
    feedsRefreshing,
    filters,
    finishTriage,
    fresh,
    headHeight,
    headRef,
    i18n,
    importOffer,
    inboxBanner,
    inboxThumbs,
    latestCopy,
    library,
    linkTarget,
    list,
    listOpen,
    movedAside,
    naming,
    narrow,
    narrowed,
    navigate,
    notice,
    notifications,
    offeredName,
    open,
    openDuplicates,
    openFeeds,
    openInbox,
    openLinks,
    openReading,
    openTriage,
    page,
    previews,
    purging,
    readButton,
    readerLook,
    reading,
    readingChange,
    readingCovers,
    readingOrigin,
    removeOfflineCopy,
    runBulk,
    saveBackupCopy,
    saveEdit,
    saveLink,
    saveOfflineCopy,
    say,
    sayAlert,
    scrollRef,
    searchRef,
    section,
    sectionCount,
    selecting,
    selection,
    selectionActions,
    selectionDrag,
    selectionRef,
    setBadge,
    setDataVersion,
    setDeletingCollection,
    setEditing,
    setFeedbackDraft,
    setFeedPlace,
    setLinkTarget,
    setMovedAside,
    setNaming,
    setNotice,
    setPage,
    setPurging,
    setReadingCovers,
    setSettings,
    setSheet,
    setSort,
    setSurface,
    setSync,
    setTheme,
    settings,
    setTriage,
    setUpgradeFrom,
    setView,
    shareFrom,
    shareList,
    sheet,
    sheetBookmarks,
    slowLoading,
    sort,
    startDrag,
    supporter,
    surface,
    sync,
    t,
    theme,
    triage,
    undoing,
    unsave,
    update,
    upgradeFrom,
    veil,
    view,
    wide,
  } = app;
  const editor = editing && (
    <BookmarkEditor
      key={editing.id}
      bookmark={editing}
      collections={library.collections}
      onOpen={actions.open}
      onCancel={closeEditor}
      onDelete={deleteEdit}
      onSave={saveEdit}
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
        onShareList={shareList}
      />
      {dragging && <DragStack drag={dragging} collections={library.collections} stack={selectionDrag.stack} place={selectionDrag.place} />}
      <div className="flex min-w-0 flex-1 flex-col">
        {windowBar}
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
                    onCapture={(status) => desktop?.setCapture(status)}
                    onConnect={() => setSurface("connect")}
                    onConnectAssistant={() => setSurface("assistant")}
                    onCopy={(text) => void copy(text)}
                    onNotice={say}
                    onSaveCopy={saveBackupCopy}
                    onRestoreBackup={() => setSurface("backup")}
                    onFeedback={() => setSurface("feedback")}
                    update={update}
                    onUpdate={() => setSurface("update")}
                    onCheckUpdates={async () => desktop?.setUpdate(await desktopOnly().checkForUpdates())}
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
                {/* The toolbar is glass over the list (2026-10-16); 13 + 7 px under it: room for the selection ring of the first row. */}
                <div ref={headRef} className={`toolbar-glass absolute inset-x-0 top-0 z-20 flex flex-col gap-4 ${padding} pt-2 pb-[13px]`}>
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
                          {capabilities.file_manager && (
                            <Button variant="onDanger" onClick={() => void desktopApi?.revealLibraryPlace("backups").catch((err) => say(describeError(err), true))}>
                              {t("library.openBackups")}
                            </Button>
                          )}
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
                        <span>{inboxLine(counts, t)}</span>
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
                  style={{ paddingTop: headHeight + 7, scrollPaddingTop: headHeight + 8 }}
                  className={`min-h-0 flex-1 overflow-y-auto ${padding} ${selecting ? "pb-[120px]" : "pb-8"}`}
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
        <Dialog title={t("editor.label")} drawer back={false} onClose={closeEditor}>
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
          // A new surface or a new dropped file is a new dialog: its first state is the file.
          key={`${surface}:${droppedFile?.surface === surface ? droppedFile.name : ""}`}
          kind={surface === "importFeeds" ? "feeds" : "bookmarks"}
          file={droppedFile?.surface === surface ? droppedFile : undefined}
          onClose={() => setSurface(null)}
          onList={(file) => {
            setSurface(null);
            if (!openRequests.push({ kind: "kpin", ...file })) say(t("add.dropImportBusy"), true);
          }}
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
      {listOpen && list.request && (
        <ListImportDialog
          key={list.id}
          request={list.request}
          onBusy={openRequests.setBusy}
          collections={library.collections}
          onClose={() => openRequests.done()}
          onImported={async () => {
            await Promise.all([library.refresh(), library.refreshCatalog()]);
          }}
          onShowCollection={(id) => {
            openRequests.done();
            setTriage(null);
            setPage("library");
            navigate({ collectionId: id });
          }}
          onCheckUpdates={() => {
            // As «Update» of the sync dialog: the version on offer, or Settings → Updates.
            if (offer(update)) return setSurface("update");
            setTriage(null);
            setPage("settings");
          }}
          onOpen={(url) => void api.openUrl(url).catch((err) => say(describeError(err), true))}
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
          onShowBackups={!capabilities.file_manager ? undefined : () => void desktopApi?.revealLibraryPlace("backups").catch((err) => say(describeError(err), true))}
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
      {surface === "shareList" && (
        <ShareListDialog start={shareFrom} collections={library.collections} feeds={feeds} onClose={() => setSurface(null)} onNotice={setNotice} />
      )}
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
      {overlays}
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
          windowBar={windowBar}
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
      {veil?.file && (
        <div className="drop-veil" data-drop-veil="import" aria-hidden>
          <div className="max-w-[min(420px,80vw)]">
            <span className="drop-veil-ring">
              <Icon icon={ArrowDown} size={26} strokeWidth={2} />
            </span>
            {/* The name shows only where the webview tells it before the drop; the kind, where its type is known. */}
            <b className="block text-lg font-bold tracking-[-0.01em]">{t(refusedByName(veil.file) ? "add.dropImportNot" : "add.dropImport")}</b>
            <span className="mt-1 block text-sm text-muted [overflow-wrap:anywhere]">
              {!veil.file.kind
                ? t("add.dropImportOther")
                : veil.file.name
                  ? t(`add.dropImportNamed_${veil.file.kind}`, { name: veil.file.name })
                  : t(`add.dropImport_${veil.file.kind}`)}
            </span>
            {veil.file.kind === "kpin" && <span className="mt-4 block text-xs text-muted">{t("add.dropImportAlso")}</span>}
          </div>
        </div>
      )}
      {veil && !veil.file && (
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
