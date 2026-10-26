import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useHeight } from "../hooks/useHeight";
import { usePreviewRefresh } from "../hooks/usePreviewRefresh";
import { useSelection } from "../hooks/useSelection";
import { describeError } from "../services/errors";
import { unsubscribeFeed } from "../services/feeds";
import { linkActions, useBookmarkActions } from "./actions";
import type { DesktopStatus } from "./desktopStatus";
import { useEditing } from "./editing";
import { useFeedsView } from "./feedsView";
import { useImportExport } from "./importExport";
import { useInbox } from "./inbox";
import { NARROW, useMedia, WIDE } from "./layout";
import { useLibraryView } from "./library";
import { useLook } from "./look";
import { useNavigation } from "./navigation";
import { notificationsOf } from "./notifications";
import { type NoticeTiming, useNotices, useUndo } from "./notices";
import { useReading } from "./reading";
import { isNarrowed, sectionCount, sectionName } from "./sections";
import { findNode, treeOf } from "../services/collectionTree";
import { useAppSettings, useLibraryHealth, useSupporter } from "./status";
import { useSurfaces } from "./surfaces";

/**
 * The app's state and what changes it, by concern (NP-072a): what both shells show of the library.
 * `desktop` is what only the desktop shell reads (the update, the browsers' capture); a phone's
 * shell passes null. `noticeTiming` replaces how long a notice stays (the phone's snackbar).
 */
export function useAppState(desktop: DesktopStatus | null, { noticeTiming }: { noticeTiming?: NoticeTiming } = {}) {
  const { t, i18n } = useTranslation();
  const narrow = useMedia(NARROW);
  const wide = useMedia(WIDE);
  const notices = useNotices(noticeTiming);
  const editing = useEditing();
  /** How many bookmarks wait in the inbox, for triage: known once the library below is read. */
  const inboxCount = useRef<() => number>(() => 0);
  const nav = useNavigation(editing, notices, () => inboxCount.current());
  /** The toolbar lies over the list as glass (2026-10-16): the list starts below it and scrolls under it. */
  const [headRef, headHeight] = useHeight<HTMLDivElement>(60);
  const searchRef = useRef<HTMLInputElement>(null);
  const supporter = useSupporter();
  const look = useLook(supporter.supporter);
  const update = desktop?.update ?? null;
  const capture = desktop?.capture ?? null;
  const surfaces = useSurfaces({ supporter: supporter.supporter, sync: supporter.sync, update });
  /** «Refresh previews» for many bookmarks: Settings → Storage, the selection bar, the notification centre. */
  const previews = usePreviewRefresh();
  const lib = useLibraryView(t, nav, notices, previews.handingOff);
  const { library } = lib;
  inboxCount.current = () => library.counts.inbox;
  /** Selected bookmarks (NP-028): cleared by another section, settings or triage. */
  const selection = useSelection(nav.filters, nav.page === "library" && !nav.triage);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const reading = useReading(t, notices, selectionRef, lib.loadedRef, library.bookmarks);
  const undo = useUndo(t, notices, (ids) => {
    const open = editing.editingRef.current;
    if (open && ids.includes(open.id)) editing.closeEditor();
  });
  const health = useLibraryHealth();
  const appSettings = useAppSettings(nav.page, notices.say);
  const io = useImportExport(t, notices, editing, nav, surfaces, lib, reading.readingRef);
  const links = linkActions(t, notices);
  const feeds = useFeedsView(notices, links, nav);
  const bookmarks = useBookmarkActions({
    t,
    narrow,
    notices,
    undoing: undo.undoing,
    editing,
    nav,
    surfaces,
    view: lib,
    selection,
    selectionRef,
    previews,
    reading,
    io,
    links,
  });
  const inbox = useInbox(lib, nav.filters);

  const { filters } = nav;
  const { counts } = library;
  const collection = library.collections.find((c) => c.id === filters.collectionId);
  // One tree per change of the collections, shared with the menus (2.19.0).
  const collectionTree = treeOf(library.collections);
  const section = sectionName(filters, collection, t);
  const notifications = notificationsOf(
    {
      capture,
      counts,
      inboxHidden: inbox.inboxHidden,
      inboxThumbs: inbox.inboxThumbs,
      importOffer: inbox.importOffer,
      feeds: feeds.feeds,
      previews,
    },
    {
      browserDetails: () => nav.setPage("settings"),
      sortInbox: nav.openTriage,
      hideInbox: inbox.hideBanner,
      importOffer: () => surfaces.setSurface("import"),
      hideImportOffer: inbox.endImportOffer,
      openFeeds: nav.openFeeds,
      unfollow: (uid) => void unsubscribeFeed(uid).catch((err) => notices.say(describeError(err), true)),
      openLinks: nav.openLinks,
    },
    t,
  );
  const clearNotifications = () => {
    if (counts.inbox > 0) inbox.hideBanner();
    if (inbox.importOffer) inbox.endImportOffer();
    if (previews.resultShown) previews.dismiss();
    previews.dismissHandedOff();
  };

  return {
    t,
    i18n,
    narrow,
    wide,
    /** The editor docks beside a list that keeps less room, or the window is narrow. */
    compact: narrow || (wide && !!editing.editing),
    /** The selection bar is up: notices rise above it (frame 27). */
    selecting: selection.ids.size > 0 && nav.page === "library" && !nav.triage,
    desktop,
    update,
    capture,
    ...notices,
    ...editing,
    ...undo,
    ...nav,
    headRef,
    headHeight,
    searchRef,
    ...supporter,
    ...look,
    ...surfaces,
    previews,
    ...lib,
    selection,
    selectionRef,
    ...reading,
    ...health,
    ...appSettings,
    ...io,
    ...links,
    ...feeds,
    ...bookmarks,
    ...inbox,
    counts,
    collection,
    collectionTree,
    section,
    // A collection counts what is inside it too, unless «Only this collection» (2.19.0).
    sectionCount: sectionCount(filters, counts, collection && { count: filters.onlyCollection ? collection.count : (findNode(collectionTree, collection.id)?.total ?? collection.count) }),
    narrowed: isNarrowed(filters),
    notifications,
    clearNotifications,
  };
}

export type AppState = ReturnType<typeof useAppState>;
