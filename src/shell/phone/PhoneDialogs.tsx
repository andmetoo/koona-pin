import { BackupRestoreDialog } from "../../components/BackupRestoreDialog";
import { SyncDialog } from "../../components/commercial/SyncDialog";
import { FeedbackDialog } from "../../components/FeedbackDialog";
import { CollectionDialog, ConfirmDialog, ImportDialog, RestoreDialog } from "../../components/library/Dialogs";
import { ListImportDialog } from "../../components/ListImportDialog";
import { SupporterDialog } from "../../components/SupporterDialog";
import { capabilities } from "../../platform/capabilities";
import { api } from "../../services/api";
import { bundle } from "../../services/bundle";
import { openRequests } from "../../services/openRequests";
import { usePhone } from "./PhoneContext";
import { useSupporterSheets } from "./supporter/useSupporterSheets";
import { opener } from "../../services/opener";

/**
 * The shared dialogs a phone still shows (NP-072b), opened by `app.surface` and the app's other
 * dialog state as on the desktop: the 5-year upgrade, sync; import, a `.kpin` list, restore,
 * backups, feedback, a new collection, the confirmations of deleting a collection and deleting for
 * good, and the feeds' own dialogs. Not here: what the phone has instead (`add` → the newLink
 * sheet, the editor → the edit sheet, the reading sheet and mode → the reader route; Supporter,
 * sign-in and the plan → the phone's own sheets in ./supporter, opened from here) and the desktop's
 * own (update, background, assistants, browser capture).
 * The same props as in the desktop's src/shell/desktop/Workspace.tsx; where the desktop opens its Settings
 * page, the phone pushes its settings route.
 */
export function PhoneDialogs() {
  const { app, stack } = usePhone();
  const {
    t,
    i18n,
    surface,
    setSurface,
    droppedFile,
    say,
    library,
    counts,
    importOffer,
    endImportOffer,
    openInbox,
    list,
    listOpen,
    navigate,
    closeEditor,
    selection,
    setDataVersion,
    feedbackDraft,
    setFeedbackDraft,
    supporter,
    upgradeFrom,
    sync,
    setSync,
    copy,
    deletingCollection,
    setDeletingCollection,
    filters,
    purging,
    setPurging,
    feedMenu,
  } = app;
  useSupporterSheets();
  // A parent's children move up a level with everything inside them (2.19.0): the dialog says so, as the desktop's.
  const deleteCollectionText = (collection: { id: number; name: string }) => {
    const kids = library.collections.filter((c) => c.parent_id === collection.id).map((c) => c.name);
    const text = t("confirm.deleteCollectionText", { name: collection.name });
    if (!kids.length) return text;
    // Intl.ListFormat is in the browsers and webviews we ship, not in the project's TypeScript lib.
    const list = new (Intl as unknown as { ListFormat: new (lang: string, o: object) => { format: (items: string[]) => string } }).ListFormat(i18n.language, { type: "conjunction" });
    const more = kids.length === 1 ? t("confirm.deleteCollectionChild", { name: kids[0] }) : t("confirm.deleteCollectionChildren", { names: list.format(kids) });
    return `${text} ${more}`;
  };
  const openSettings = () => {
    setSurface(null);
    stack.push({ name: "settings" });
  };
  return (
    <>
      {(surface === "import" || surface === "importFeeds") && (
        <ImportDialog
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
            stack.selectTab("inbox");
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
            stack.selectTab("all");
            navigate({ collectionId: id });
          }}
          onCheckUpdates={() => {
            // A phone is updated by its store: Settings says how.
            openRequests.done();
            stack.push({ name: "settings" });
          }}
          onOpen={opener(say)}
        />
      )}
      {surface === "restore" && (
        <RestoreDialog
          key={droppedFile?.surface === "restore" ? droppedFile.name : ""}
          file={droppedFile?.surface === "restore" ? droppedFile : undefined}
          onClose={() => setSurface(null)}
          onRestore={async (content, mode) => {
            const outcome = await api.restoreLibrary(content, mode);
            if (outcome.outcome === "restored") {
              closeEditor();
              selection.clear();
              if (mode === "replace") {
                library.replaced();
                bundle.clear();
              }
              await Promise.all([library.refresh(), library.refreshCatalog()]);
            }
            return outcome;
          }}
        />
      )}
      {surface === "backup" && (
        <BackupRestoreDialog
          current={counts.total}
          onClose={() => setSurface(null)}
          onRestored={async () => {
            closeEditor();
            selection.clear();
            library.replaced();
            bundle.clear();
            setDataVersion((version) => version + 1);
            await Promise.all([library.refresh(), library.refreshCatalog()]);
          }}
        />
      )}
      {surface === "feedback" && <FeedbackDialog draft={feedbackDraft} onDraft={setFeedbackDraft} onClose={() => setSurface(null)} />}
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
      {surface === "sync" && sync && (
        <SyncDialog
          status={sync}
          plan={supporter?.plan ?? null}
          onStatus={setSync}
          onClose={() => setSurface(null)}
          onCopy={(text) => void copy(text)}
          onOpen={opener(say)}
          onUpdate={openSettings}
          onRenew={() => setSurface(supporter?.plan ? "plan" : "supporter")}
          onSignIn={() => setSurface("signIn")}
        />
      )}
      {/* A sale: only where the build sells (the plan sheet offers it only there). */}
      {surface === "upgrade" && capabilities.purchase === "paddle" && supporter && upgradeFrom && (
        <SupporterDialog
          sandbox={!!supporter.sandbox}
          email={supporter.email ?? null}
          paid
          upgrade={upgradeFrom}
          onClose={() => setSurface(null)}
          onSignIn={() => setSurface("signIn")}
        />
      )}
      {deletingCollection && (
        <ConfirmDialog
          title={t("confirm.deleteCollection")}
          text={deleteCollectionText(deletingCollection)}
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
      {feedMenu.dialogs}
    </>
  );
}
