import { KeyboardEvent, PointerEvent, ReactNode, TransitionEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { BookOpen, ChevronDown, CircleArrowDown, CircleArrowUp, Copy, Heart, Link, ListPlus, MoreHorizontal, Plus, Rss, Settings, Trash2, TriangleAlert, Unlink, X } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { CaptureStatus, Collection, Feed, FilterState, LibraryCounts, Tag, UpdateStatus } from "../../types";
import { Offer, offer, percent } from "../../services/update";
import { collectionColor } from "../../services/collections";
import { DropTarget, dropAttribute, sameDrop } from "../../services/drag";
import { moveCollection } from "../../services/library";
import { useCollectionReorder } from "../../hooks/useCollectionReorder";
import { statusColor, statusLabel } from "../../services/capture";
import { isMobile } from "../../platform/platform";
import { shortcut } from "../../services/keys";
import { savePreference, storedValue } from "../../services/preferences";
import { ClipIcon, Icon, InboxTray, Mascot } from "../icons";
import { Dot } from "../ui/Controls";
import { Hint } from "../ui/Hint";
import { AppNotification, NotificationCenter } from "./NotificationCenter";
import { Menu, MenuEntry } from "../ui/Menu";
import type { ListSource } from "../../services/shareList";
import { feedName } from "../../services/feeds";
import { healthLine } from "../../services/feedsView";
import { FeedIcon } from "../feeds/FeedIcon";
import { FeedActions, feedMenu } from "../feeds/FeedMenu";

export interface SidebarProps {
  narrow: boolean;
  filters: FilterState;
  settingsOpen: boolean;
  /** The section «Дубликаты» is open (NP-035, sheet 34). */
  duplicatesOpen: boolean;
  /** The section «Проверка ссылок» is open (NP-036, sheet 35). */
  linksOpen: boolean;
  counts: LibraryCounts;
  collections: Collection[];
  tags: Tag[];
  capture: CaptureStatus | null;
  /** The app's own update (NP-038, sheet 42): a row above the browser status while one is in play. */
  update: UpdateStatus | null;
  onUpdate: () => void;
  /**
   * Above the browser status (NP-066, sheet 45), in a build that sells Supporter: «Support Koona
   * Pin», or the Supporter badge, a filled heart in the colour of the season. Null: no row.
   */
  plan: "free" | "supporter" | null;
  onSupport: () => void;
  /** The Supporter badge opens the dialog of the plan and its perks. */
  onPlan: () => void;
  /** The badge's heart in the colour of the season; off, the row stays with a plain heart. */
  badge: boolean;
  onInbox: () => void;
  onTrash: () => void;
  onAll: () => void;
  onFavorites: () => void;
  /** The Reading list (NP-121, sheet R0). */
  onReading: () => void;
  /** Bookmarks with an offline copy (NP-126, frame O1): under Reading. */
  onOffline: () => void;
  onCollection: (id: number) => void;
  onTag: (name: string) => void;
  onSettings: () => void;
  onDuplicates: () => void;
  onLinks: () => void;
  onConnect: () => void;
  onNewCollection: () => void;
  /** «New link» (2026-10-16): the ink button under the logo, a round «+» in the strip; `⌘N` too. */
  onNewLink: () => void;
  onDeleteCollection: (collection: Collection) => void;
  /** Every collection's id in the new order, after a drag or `Alt ↑` / `Alt ↓` (NP-114, sheet 41). */
  onReorderCollections: (ids: number[]) => void;
  /** «Новая коллекция из выбранного» (Р-27): the name field at the end of the collections. */
  naming?: NewCollectionField | null;
  /**
   * The selection is being dragged (NP-030, frame 05, sheet 32): collections,
   * every tag, «Корзина» and «Новая коллекция из выбранного» become targets;
   * `target` is the one under the pointer.
   */
  dropping?: { target: DropTarget | null } | null;
  /** The notification centre's bell (2026-10-16): right of the wordmark, under the spirit in the strip. */
  notifications: AppNotification[];
  onClearNotifications: () => void;
  /** The subscriptions (NP-132): the Feeds section above Collections; null until known. */
  feeds: Feed[] | null;
  /** The Feeds page is open, on `feedUid` (null: All feeds). */
  feedsOpen: boolean;
  feedUid: string | null;
  onFeed: (uid: string | null) => void;
  /** A feed's row menu: Rename, Where new posts go, Mark all read, Copy, Open site, Unfollow. */
  feedActions: FeedActions;
  /** «Share as list…» (NP-140) from a collection's, a feed's or All feeds' menu. */
  onShareList: (sources: ListSource[]) => void;
}

export interface NewCollectionField {
  /** The offered name, selected so typing replaces it. */
  suggested: string;
  /** Selected bookmarks that will move there: the count on the right (sheet 27). */
  count: number;
  /** The colour the new collection will get. */
  color: string;
  /** Enter: create the collection and move the selection into it, one action. */
  onCreate: (name: string) => void;
  /** Esc or leaving the field: nothing is created. */
  onCancel: () => void;
}

const VISIBLE_TAGS = 6;
/** Hovering a folded section's header this long while dragging the selection opens it. */
const DRAG_OPEN_MS = 600;

type Fold = "feeds" | "collections" | "tags";
const FOLDS: Fold[] = ["feeds", "collections", "tags"];
const storedFolds = () => new Set(FOLDS.filter((name) => storedValue(`sidebar.${name}`) === "folded"));

/**
 * The folded sections of the sidebar (2026-10-16), each remembered. While the
 * selection is dragged, hovering a folded header opens it for that drag.
 */
function useFolds(dragging: boolean) {
  const [folded, setFolded] = useState(storedFolds);
  const [opened, setOpened] = useState<Set<Fold>>(new Set());
  const headers = useRef<Partial<Record<Fold, HTMLElement | null>>>({});
  const set = (name: Fold, fold: boolean) => {
    savePreference(`sidebar.${name}`, fold ? "folded" : "open");
    setFolded((current) => {
      const next = new Set(current);
      if (fold) next.add(name);
      else next.delete(name);
      return next;
    });
  };
  useEffect(() => {
    if (!dragging) return setOpened(new Set());
    let over: Fold | null = null;
    let timer = 0;
    const move = (e: globalThis.PointerEvent) => {
      const under = FOLDS.find((name) => {
        const box = headers.current[name]?.getBoundingClientRect();
        return box && e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
      }) ?? null;
      if (under === over) return;
      over = under;
      window.clearTimeout(timer);
      if (under) timer = window.setTimeout(() => setOpened((current) => new Set(current).add(under)), DRAG_OPEN_MS);
    };
    window.addEventListener("pointermove", move);
    return () => {
      window.removeEventListener("pointermove", move);
      window.clearTimeout(timer);
    };
  }, [dragging]);
  const isFolded = (name: Fold) => folded.has(name) && !opened.has(name);
  return {
    isFolded,
    toggle: (name: Fold) => {
      const fold = !isFolded(name);
      if (fold)
        setOpened((current) => {
          const next = new Set(current);
          next.delete(name);
          return next;
        });
      set(name, fold);
    },
    open: (name: Fold) => set(name, false),
    header: (name: Fold) => (element: HTMLElement | null) => {
      headers.current[name] = element;
    },
  };
}

/** Sidebar 232 px (frame 01); a 56 px strip of icons in a narrow window (frame 16). */
export function Sidebar(props: SidebarProps) {
  const { t, i18n } = useTranslation();
  const { filters, settingsOpen, counts, collections, tags, capture, narrow } = props;
  const [allTags, setAllTags] = useState(false);
  const duplicatesOpen = props.duplicatesOpen;
  const linksOpen = props.linksOpen;
  const feedsOpen = props.feedsOpen;
  const library = !settingsOpen && !duplicatesOpen && !linksOpen && !feedsOpen;
  /** Shown while there are groups, or while the section is open. */
  const duplicates = counts.duplicates > 0 || duplicatesOpen;
  /** Shown while a check found links to decide on, or while the section is open. */
  const links = counts.links > 0 || linksOpen;
  const inbox = library && filters.onlyInbox;
  const trash = library && filters.onlyTrash;
  const all =
    library && !filters.collectionId && !filters.onlyFavorites && !filters.onlyInbox && !filters.onlyTrash && !filters.onlyReading && !filters.onlyOffline;
  const favorites = library && filters.onlyFavorites;
  const reading = library && filters.onlyReading;
  const offlineOpen = library && filters.onlyOffline;
  /** Shown while there are copies, or while the section is open. */
  const offline = counts.offline > 0 || offlineOpen;
  const status = { color: statusColor(capture), label: statusLabel(capture, t) };
  const update = offer(props.update);
  const { dropping } = props;
  /** While dragging: the element's `data-drop` and whether the pointer is over it. */
  const drop = (target: DropTarget): Drop | undefined =>
    dropping ? { attr: dropAttribute(target), hot: sameDrop(dropping.target, target) } : undefined;
  const trashDrop = drop({ kind: "trash" });
  const favoritesDrop = drop({ kind: "favorites" });
  const readingDrop = drop({ kind: "reading" });
  const folds = useFolds(!!dropping);
  const collectionsId = useId();
  const tagsId = useId();
  // The name field of «New collection from selection» is never hidden in a folded section.
  const collectionsFolded = folds.isFolded("collections") && !props.naming;
  const tagsFolded = folds.isFolded("tags");
  const feedsId = useId();
  const feedsFolded = folds.isFolded("feeds");
  const feeds = props.feeds ?? [];
  const unread = feeds.reduce((sum, f) => sum + f.unread, 0);
  /** A feed's row menu, from its «…» or a right click. */
  const [feedMenuAt, setFeedMenuAt] = useState<{ feed: Feed; anchor: DOMRect | { x: number; y: number }; trigger: Element | null } | null>(null);
  /** The menu of a collection or of All feeds (NP-140): a right click, or the menu key on the row. */
  const [rowMenu, setRowMenu] = useState<{ label: string; entries: MenuEntry[]; anchor: DOMRect | { x: number; y: number } } | null>(null);
  const shareEntry = (sources: ListSource[]): MenuEntry => ({ id: "share", icon: ListPlus, label: t("shareList.menu"), onSelect: () => props.onShareList(sources) });
  const collectionMenu = (c: Collection, anchor: DOMRect | { x: number; y: number }) =>
    setRowMenu({
      label: t("shareList.collectionMenu", { name: c.name }),
      entries: [shareEntry([{ kind: "collection", id: c.id }]), "separator", { id: "delete", icon: X, label: t("sidebar.deleteCollection", { name: c.name }), onSelect: () => props.onDeleteCollection(c) }],
      anchor,
    });
  const allFeedsMenu = (anchor: DOMRect | { x: number; y: number }) =>
    setRowMenu({ label: t("shareList.allFeedsMenu"), entries: [shareEntry([{ kind: "feeds", uids: null }])], anchor });
  /** The menu key, or Shift+F10, on a row opens its menu under it. */
  const menuKey = (e: KeyboardEvent) => e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");

  // The collections' order (NP-114, sheet 41): a drag of a row or of a dot,
  // or `Alt ↑` / `Alt ↓` on the focused one. A screen reader hears the place.
  const list = useRef<HTMLDivElement>(null);
  const [moved, setMoved] = useState("");
  const moveTo = (from: number, to: number) => {
    const collection = collections[from];
    props.onReorderCollections(moveCollection(collections, from, to));
    setMoved(t("sidebar.collectionMoved", { name: collection.name, position: to + 1, count: collections.length }));
  };
  const reorder = useCollectionReorder(moveTo);
  const moving = reorder.move;
  const press = (index: number) => (e: PointerEvent) => {
    if (e.button !== 0 || dropping || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    reorder.start(e, index, list.current);
  };
  const keys = (index: number, id: number) => (e: KeyboardEvent) => {
    // The strip of a narrow window has no menus.
    if (menuKey(e) && !props.narrow) {
      e.preventDefault();
      return collectionMenu(collections[index], e.currentTarget.getBoundingClientRect());
    }
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const to = index + (e.key === "ArrowUp" ? -1 : 1);
    if (to < 0 || to >= collections.length) return;
    moveTo(index, to);
    // The row keeps the focus at its new place.
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-collection-row="${id}"] [data-collection]`)?.focus());
  };
  /** The line where the moved collection would land: above the row, or below the last one. */
  const landing = (index: number) =>
    moving && moving.over !== null && moving.over !== moving.from && moving.over !== moving.from + 1
      ? moving.over === index
        ? "top"
        : moving.over === collections.length && index === collections.length - 1
          ? "bottom"
          : null
      : null;
  const movedCollection = moving && collections[moving.from];
  const ghost = movedCollection && (
    <div
      ref={(element) => {
        reorder.ghost.current = element;
        reorder.place();
      }}
      aria-hidden
      className="pointer-events-none fixed top-0 left-0 z-50 flex max-w-[200px] items-center gap-2 rounded-md bg-card px-2.5 py-1.5 text-sm text-ink shadow-menu"
    >
      <Dot color={collectionColor(movedCollection.id)} />
      <span className="truncate">{movedCollection.name}</span>
    </div>
  );
  const announcement = (
    <span aria-live="polite" className="sr-only">
      {moved}
    </span>
  );

  if (narrow)
    return (
      <aside className="sidebar-strip flex w-14 shrink-0 flex-col items-center gap-0.5 bg-panel py-3.5" aria-label={t("sidebar.label")}>
        <div className="mac-lights self-stretch" data-tauri-drag-region />
        <div className="mb-2 text-accent" data-tauri-drag-region>
          <button type="button" tabIndex={-1} aria-label="koona pin" onClick={props.onAll} className="block">
            <Mascot size={30} className="pointer-events-none" />
          </button>
        </div>
        <div className="mb-2">
          <NotificationCenter items={props.notifications} place="right" onClearAll={props.onClearNotifications} />
        </div>
        <div className="mb-2">
          <Hint label={t("sidebar.newLink")} keys={shortcut("N")} side="right">
            <button
              type="button"
              aria-label={t("sidebar.newLink")}
              aria-keyshortcuts="Control+N Meta+N"
              data-new-link
              onClick={props.onNewLink}
              className="flex size-9 items-center justify-center rounded-full bg-ink-btn text-on-ink-btn shadow-[0_1px_2px_rgb(0_0_0/0.2),inset_0_1px_0_rgb(255_255_255/0.12)] transition-colors duration-150 hover:bg-ink-btn-hover"
            >
              <Icon icon={Plus} size={17} strokeWidth={2} />
            </button>
          </Hint>
        </div>
        <StripButton
          label={counts.inbox > 0 ? t("nav.inboxWaiting", { count: counts.inbox }) : t("nav.inbox")}
          active={inbox}
          onClick={props.onInbox}
        >
          <span className="relative">
            <Icon icon={InboxTray} />
            {counts.inbox > 0 && <span className="absolute -top-0.5 -right-1 size-1.5 rounded-full bg-accent" />}
          </span>
        </StripButton>
        <StripButton label={t("nav.all")} active={all} onClick={props.onAll}>
          <Icon icon={ClipIcon} />
        </StripButton>
        <StripButton label={t("nav.favorites")} active={favorites} onClick={props.onFavorites} drop={favoritesDrop}>
          <Icon icon={Heart} />
        </StripButton>
        <StripButton label={t("nav.reading")} active={reading} onClick={props.onReading} drop={readingDrop}>
          <Icon icon={BookOpen} />
        </StripButton>
        {offline && (
          <StripButton label={t("nav.offline")} active={offlineOpen} onClick={props.onOffline}>
            <Icon icon={CircleArrowDown} />
          </StripButton>
        )}
        <StripButton label={t("nav.trash")} active={trash} onClick={props.onTrash} drop={trashDrop && { ...trashDrop, danger: true }}>
          <Icon icon={Trash2} />
        </StripButton>
        {duplicates && (
          <StripButton label={`${t("nav.duplicates")} ${counts.duplicates}`} active={duplicatesOpen} onClick={props.onDuplicates}>
            <span className="relative">
              <Icon icon={Copy} />
              {counts.duplicates > 0 && <span className="absolute -top-0.5 -right-1 size-1.5 rounded-full bg-subtle" />}
            </span>
          </StripButton>
        )}
        {links && (
          <StripButton label={`${t("nav.links")} ${counts.links}`} active={linksOpen} onClick={props.onLinks}>
            <span className="relative">
              <Icon icon={Unlink} />
              {counts.links > 0 && <span className="absolute -top-0.5 -right-1 size-1.5 rounded-full bg-subtle" />}
            </span>
          </StripButton>
        )}
        {/* Feeds (NP-132): one button, a dot while there is something new. */}
        <StripButton label={unread > 0 ? `${t("feeds.title")}: ${t("feeds.newCount", { count: unread })}` : t("feeds.title")} active={feedsOpen} onClick={() => props.onFeed(props.feedUid)}>
          <span className="relative" data-strip-feeds>
            <Icon icon={Rss} />
            {unread > 0 && <span className="absolute -top-0.5 -right-1 size-1.5 rounded-full bg-ink" />}
          </span>
        </StripButton>
        <div className="my-2.5 h-px w-6 bg-line" />
        <div ref={list} className="flex flex-col items-center gap-0.5">
          {collections.map((c, i) => (
            <div key={c.id} data-collection-row={c.id} className={`relative ${moving?.from === i ? "opacity-45" : ""}`}>
              {landing(i) && <LandingLine at={landing(i)!} />}
              <StripButton
                label={c.name}
                active={library && filters.collectionId === c.id}
                onClick={() => props.onCollection(c.id)}
                drop={drop({ kind: "collection", id: c.id })}
                onPointerDown={press(i)}
                onKeyDown={keys(i, c.id)}
                collection
              >
                <Dot color={collectionColor(c.id)} />
              </StripButton>
            </div>
          ))}
        </div>
        {ghost}
        {announcement}
        <div className="flex-1" />
        {update && (
          <StripButton label={updateLabel(t, update)} onClick={props.onUpdate}>
            <span className={`relative ${update.state === "failed" ? "text-amber" : "text-update"}`}>
              <Icon icon={update.state === "failed" ? TriangleAlert : CircleArrowUp} />
              <span className={`absolute -top-0.5 -right-1 size-1.5 rounded-full ${update.state === "failed" ? "bg-amber" : "bg-update"}`} />
            </span>
          </StripButton>
        )}
        {props.plan && (
          <StripButton
            label={props.plan === "free" ? t("supporter.rowHint") : t("supporter.badge")}
            onClick={props.plan === "free" ? props.onSupport : props.onPlan}
          >
            <span className={props.plan === "supporter" && !props.badge ? "" : "text-season"}>
              <Heart size={16} strokeWidth={1.5} fill={props.plan === "supporter" && props.badge ? "currentColor" : "none"} aria-hidden />
            </span>
          </StripButton>
        )}
        {/* The browsers' status: a phone has no browser extension (NP-151). */}
        {!isMobile && (
          <StripButton label={status.label} onClick={props.onConnect}>
            <span className="relative">
              <Icon icon={Link} />
              <span className="absolute -top-0.5 -right-1 size-1.5 rounded-full" style={{ background: status.color }} />
            </span>
          </StripButton>
        )}
        <StripButton label={t("nav.settings")} active={settingsOpen} onClick={props.onSettings}>
          <Icon icon={Settings} />
        </StripButton>
      </aside>
    );

  // The logo, «New link» and the sections stay put; Feeds, Collections and Tags scroll under the
  // footer's glass (2026-10-16). No scrollbar: one that came and went cut long labels in WebKitGTK
  // (NP-132), and WKWebView flashed it over the reading mode as the mode opened.
  return (
    <aside className="flex w-[232px] shrink-0 flex-col gap-0.5 bg-panel pt-3.5 pr-3 pl-3" aria-label={t("sidebar.label")}>
      <div className="mac-lights" data-tauri-drag-region />
      <div className="flex items-center gap-2.5 pt-1.5 pr-0 pb-2.5 pl-2 text-accent" data-tauri-drag-region>
        {/* The logo goes home, to All bookmarks (2026-10-16); the keyboard has the row below. */}
        <button type="button" tabIndex={-1} aria-label="koona pin" onClick={props.onAll} className="flex min-w-0 items-center gap-2.5">
          <Mascot className="pointer-events-none" />
          <span className="truncate text-lg font-semibold">koona pin</span>
        </button>
        <span className="flex-1 self-stretch" data-tauri-drag-region />
        <NotificationCenter items={props.notifications} place="below" onClearAll={props.onClearNotifications} />
      </div>
      <button
        type="button"
        aria-keyshortcuts="Control+N Meta+N"
        data-new-link
        onClick={props.onNewLink}
        className="mb-2.5 flex h-9 w-full shrink-0 items-center justify-between gap-2 rounded-[10px] bg-ink-btn pr-2 pl-3 text-left text-sm font-semibold text-on-ink-btn shadow-[0_1px_2px_rgb(0_0_0/0.18),inset_0_1px_0_rgb(255_255_255/0.1)] transition-colors duration-150 hover:bg-ink-btn-hover"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Icon icon={Plus} size={15} strokeWidth={2} className="shrink-0" />
          <span className="truncate">{t("sidebar.newLink")}</span>
        </span>
        <kbd aria-hidden className="shrink-0 font-sans text-2xs font-semibold opacity-60">
          {shortcut("N")}
        </kbd>
      </button>
      <nav aria-label={t("sidebar.sections")} className="flex flex-col gap-0.5">
        <NavRow
          icon={<Icon icon={InboxTray} />}
          label={t("nav.inbox")}
          badge={counts.inbox}
          active={inbox}
          onClick={props.onInbox}
        />
        <NavRow icon={<Icon icon={ClipIcon} />} label={t("nav.all")} count={counts.total} active={all} onClick={props.onAll} />
        <NavRow
          icon={<Icon icon={Heart} />}
          label={t("nav.favorites")}
          count={counts.favorites}
          active={favorites}
          onClick={props.onFavorites}
          drop={favoritesDrop}
        />
        <NavRow
          icon={<Icon icon={BookOpen} />}
          label={t("nav.reading")}
          count={counts.reading_unread}
          active={reading}
          onClick={props.onReading}
          drop={readingDrop}
        />
        {offline && (
          <NavRow icon={<Icon icon={CircleArrowDown} />} label={t("nav.offline")} count={counts.offline} active={offlineOpen} onClick={props.onOffline} />
        )}
        <NavRow
          icon={<Icon icon={Trash2} />}
          label={t("nav.trash")}
          count={counts.trash}
          active={trash}
          onClick={props.onTrash}
          drop={trashDrop && { ...trashDrop, danger: true }}
        />
        {duplicates && (
          <NavRow icon={<Icon icon={Copy} />} label={t("nav.duplicates")} count={counts.duplicates} active={duplicatesOpen} onClick={props.onDuplicates} />
        )}
        {links && <NavRow icon={<Icon icon={Unlink} />} label={t("nav.links")} count={counts.links} active={linksOpen} onClick={props.onLinks} />}
      </nav>

      <div className="sidebar-scroll -mx-3 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3" data-drop-scroll>
      {/* Feeds (NP-132): above Collections, folding like them; folded, the unread count. */}
      <div ref={folds.header("feeds")} className="flex items-center pt-[22px] pr-2 pb-1.5 pl-2.5">
        <SectionHeader label={t("feeds.title")} count={unread} folded={feedsFolded} controls={feedsId} onToggle={() => folds.toggle("feeds")} />
        <button
          type="button"
          aria-label={t("feeds.followSite")}
          title={t("feeds.followSite")}
          onClick={props.onNewLink}
          className="flex size-5 items-center justify-center rounded-sm text-subtle hover:bg-hover hover:text-ink"
        >
          <Icon icon={Plus} size={14} />
        </button>
      </div>
      <Folding id={feedsId} folded={feedsFolded}>
        <nav aria-label={t("feeds.title")} data-sidebar-feeds className="flex flex-col gap-0.5">
          {props.feeds && feeds.length === 0 ? (
            <button
              type="button"
              onClick={props.onNewLink}
              className="flex h-8 items-center gap-2.5 rounded-[9px] px-2.5 text-left text-sm text-subtle transition-colors duration-150 hover:bg-hover hover:text-ink"
            >
              <Icon icon={Plus} size={14} className="mx-px shrink-0" />
              <span className="truncate">{t("feeds.follow")}</span>
            </button>
          ) : (
            props.feeds && (
              <>
                <div
                  className="contents"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    allFeedsMenu({ x: e.clientX, y: e.clientY });
                  }}
                >
                  <NavRow
                    icon={
                      <span className="flex size-4 items-center justify-center rounded-[4.5px] bg-ink-btn text-on-ink-btn">
                        <Icon icon={Rss} size={10} strokeWidth={2.5} />
                      </span>
                    }
                    label={t("feeds.all")}
                    active={feedsOpen && props.feedUid === null}
                    onClick={() => props.onFeed(null)}
                    onKeyDown={(e) => {
                      if (!menuKey(e)) return;
                      e.preventDefault();
                      allFeedsMenu(e.currentTarget.getBoundingClientRect());
                    }}
                    trailing={<CountPill count={unread} current={feedsOpen && props.feedUid === null} />}
                  />
                </div>
                {feeds.map((feed) => {
                  const problem = healthLine(feed, t, i18n.language);
                  const current = feedsOpen && props.feedUid === feed.uid;
                  return (
                    <div
                      key={feed.uid}
                      data-feed-row={feed.uid}
                      className="group relative"
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setFeedMenuAt({ feed, anchor: { x: e.clientX, y: e.clientY }, trigger: null });
                      }}
                    >
                      <NavRow
                        icon={<FeedIcon feed={feed} size={16} />}
                        label={feedName(feed)}
                        title={problem ?? undefined}
                        active={current}
                        plain
                        onClick={() => props.onFeed(feed.uid)}
                        trailing={
                          <>
                            {problem && <span data-feed-problem role="img" aria-label={problem} className="size-1.5 shrink-0 rounded-full bg-amber" />}
                            <CountPill count={feed.unread} current={current} />
                          </>
                        }
                      />
                      <button
                        type="button"
                        aria-label={t("feeds.menu.label", { name: feedName(feed) })}
                        aria-haspopup="menu"
                        onClick={(e) => setFeedMenuAt({ feed, anchor: e.currentTarget.getBoundingClientRect(), trigger: e.currentTarget })}
                        className="absolute top-1.5 right-9 flex size-5 items-center justify-center rounded-xs text-faint opacity-0 group-hover:opacity-100 hover:text-ink focus-visible:opacity-100"
                      >
                        <Icon icon={MoreHorizontal} size={14} />
                      </button>
                    </div>
                  );
                })}
              </>
            )
          )}
        </nav>
      </Folding>
      {rowMenu && (
        <Menu entries={rowMenu.entries} anchor={rowMenu.anchor} align="start" label={rowMenu.label} width={232} onClose={() => setRowMenu(null)} />
      )}
      {feedMenuAt && (
        <Menu
          entries={[...feedMenu(feedMenuAt.feed, t, props.feedActions), "separator", shareEntry([{ kind: "feeds", uids: [feedMenuAt.feed.uid] }])]}
          anchor={feedMenuAt.anchor}
          align="start"
          label={t("feeds.menu.label", { name: feedName(feedMenuAt.feed) })}
          trigger={feedMenuAt.trigger}
          width={232}
          onClose={() => setFeedMenuAt(null)}
        />
      )}

      <div ref={folds.header("collections")} className="flex items-center pt-[22px] pr-2 pb-1.5 pl-2.5">
        <SectionHeader
          label={t("sidebar.collections")}
          count={collections.length}
          folded={collectionsFolded}
          controls={collectionsId}
          onToggle={() => folds.toggle("collections")}
        />
        <button
          type="button"
          aria-label={t("sidebar.newCollection")}
          title={t("sidebar.newCollection")}
          onClick={() => {
            // A new collection's place is in the open section.
            if (collectionsFolded) folds.open("collections");
            props.onNewCollection();
          }}
          className="flex size-5 items-center justify-center rounded-sm text-subtle hover:bg-hover hover:text-ink"
        >
          <Icon icon={Plus} size={14} />
        </button>
      </div>
      <Folding id={collectionsId} folded={collectionsFolded}>
      <nav aria-label={t("sidebar.collections")} className="flex flex-col gap-0.5">
        {collections.length === 0 && !props.naming && <p className="px-2.5 py-1 text-xs text-subtle">{t("sidebar.noCollections")}</p>}
        <div ref={list} className="flex flex-col gap-0.5">
        {collections.map((c, i) => (
          <div
            key={c.id}
            data-collection-row={c.id}
            className={`group relative ${moving?.from === i ? "opacity-45" : ""}`}
            onContextMenu={(e) => {
              if (dropping || moving) return;
              e.preventDefault();
              collectionMenu(c, { x: e.clientX, y: e.clientY });
            }}
          >
            {landing(i) && <LandingLine at={landing(i)!} />}
            <NavRow
              icon={
                <span className="flex size-4 items-center justify-center">
                  <Dot color={collectionColor(c.id)} />
                </span>
              }
              label={c.name}
              count={c.count ?? 0}
              active={library && filters.collectionId === c.id}
              onClick={() => props.onCollection(c.id)}
              plain
              drop={drop({ kind: "collection", id: c.id })}
              onPointerDown={press(i)}
              onKeyDown={keys(i, c.id)}
              collection
            />
            {/* `Alt ↑` / `Alt ↓` on keyboard focus only: with the mouse the rows are dragged (sheet 41). */}
            {!dropping && !moving && collections.length > 1 && (
              <span
                role="tooltip"
                className="pointer-events-none absolute top-full left-1/2 z-50 mt-1.5 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-md bg-toast px-2 py-1 text-xs text-white opacity-0 transition-opacity duration-150 group-has-[[data-collection]:focus-visible]:opacity-100"
              >
                {t("sidebar.moveCollection")}
                <kbd className="rounded-xs bg-white/15 px-1.5 font-sans text-2xs">Alt ↑</kbd>
                <kbd className="rounded-xs bg-white/15 px-1.5 font-sans text-2xs">Alt ↓</kbd>
              </span>
            )}
            {!dropping && !moving && (
              <button
                type="button"
                aria-label={t("sidebar.deleteCollection", { name: c.name })}
                title={t("sidebar.deleteCollection", { name: c.name })}
                onClick={() => props.onDeleteCollection(c)}
                className="absolute top-2 right-8 flex size-4 items-center justify-center rounded-xs text-faint opacity-0 group-hover:opacity-100 hover:text-ink focus-visible:opacity-100"
              >
                <Icon icon={X} size={12} />
              </button>
            )}
          </div>
        ))}
        </div>
        {ghost}
        {announcement}
        {dropping && <NewCollectionTarget hot={sameDrop(dropping.target, { kind: "new" })} />}
        {props.naming && <NameField key={props.naming.suggested} {...props.naming} />}
      </nav>
      </Folding>

      {tags.length > 0 && (
        <>
          <div ref={folds.header("tags")} className="flex items-center pt-[22px] pr-2 pb-1.5 pl-2.5">
            <SectionHeader
              label={dropping && !tagsFolded ? t("sidebar.tagsDrop") : t("sidebar.tags")}
              plain={!!dropping && !tagsFolded}
              count={tags.length}
              folded={tagsFolded}
              controls={tagsId}
              onToggle={() => folds.toggle("tags")}
            />
          </div>
          <Folding id={tagsId} folded={tagsFolded}>
          <div className="flex flex-wrap gap-1.5 px-2 py-2">
            {/* While dragging every tag is a target, not only the first six (sheet 32). */}
            {(allTags || dropping ? tags : tags.slice(0, VISIBLE_TAGS)).map((tag) => {
              const target = drop({ kind: "tag", name: tag.name });
              const look = target
                ? target.hot
                  ? `bg-accent-soft text-on-accent-soft ${hotOutline}`
                  : "text-muted outline-1 -outline-offset-1 outline-faint outline-dashed"
                : filters.tag === tag.name
                  ? "bg-accent-soft text-on-accent-soft"
                  : "text-muted shadow-[inset_0_0_0_1px_var(--np-line)] hover:bg-hover hover:text-ink";
              return (
                <button
                  key={tag.id}
                  type="button"
                  aria-pressed={filters.tag === tag.name}
                  data-drop={target?.attr}
                  onClick={() => props.onTag(tag.name)}
                  className={`max-w-full truncate rounded-sm px-1.5 py-0.5 text-2xs transition-colors duration-150 ${look}`}
                >
                  {tag.name}
                </button>
              );
            })}
            {tags.length > VISIBLE_TAGS && !dropping && (
              <button
                type="button"
                onClick={() => setAllTags(!allTags)}
                className="px-1 py-0.5 text-2xs text-subtle hover:text-ink"
              >
                {allTags ? t("sidebar.fewerTags") : t("sidebar.moreTags", { count: tags.length - VISIBLE_TAGS })}
              </button>
            )}
          </div>
          </Folding>
        </>
      )}

      <div className="sidebar-foot mt-auto flex flex-col gap-0.5 pb-3.5">
      {update && <UpdateRow update={update} percent={percent(props.update)} onClick={props.onUpdate} />}
      {props.plan && <PlanRow plan={props.plan} badge={props.badge} onClick={props.plan === "free" ? props.onSupport : props.onPlan} />}
      {!isMobile && (
        <NavRow
          icon={<Icon icon={Link} />}
          label={status.label}
          title={status.label}
          onClick={props.onConnect}
          trailing={<Dot color={status.color} className="size-1.5" />}
          plain
          danger={capture?.state === "failing"}
        />
      )}
      <NavRow icon={<Icon icon={Settings} />} label={t("nav.settings")} active={settingsOpen} onClick={props.onSettings} plain />
      </div>
      </div>
    </aside>
  );
}

/**
 * The header of a section that folds (2026-10-16): a button with the section's
 * name, its count while folded, and a chevron that turns.
 */
function SectionHeader({
  label,
  count,
  folded,
  controls,
  onToggle,
  plain = false,
}: {
  label: string;
  count: number;
  folded: boolean;
  controls: string;
  onToggle: () => void;
  /** «Tags — drop on a tag to add it» while dragging: a sentence, not a capitalised label. */
  plain?: boolean;
}) {
  return (
    <h2 className="flex min-w-0 flex-1">
      <button
        type="button"
        aria-expanded={!folded}
        aria-controls={controls}
        onClick={onToggle}
        className={`-my-1 -ml-1.5 flex min-w-0 items-center gap-1 rounded-sm py-1 pr-1 pl-1.5 text-left text-2xs font-semibold text-subtle transition-colors duration-150 hover:text-ink ${plain ? "" : "tracking-[0.08em] uppercase"}`}
      >
        <span>{label}</span>
        {folded && <span className="font-medium tracking-normal text-faint tabular-nums">{count}</span>}
        <Icon icon={ChevronDown} size={12} strokeWidth={2} className="side-fold-chevron shrink-0 text-faint" />
      </button>
    </h2>
  );
}

/** A section's content that folds to nothing; folded, it takes no focus. */
function Folding({ id, folded, children }: { id: string; folded: boolean; children: ReactNode }) {
  // Open and still, the content may draw outside its box (rings, hints); while it moves it is clipped.
  const [settled, setSettled] = useState(!folded);
  useEffect(() => {
    if (folded) return setSettled(false);
    // Without motion no transition ends.
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) setSettled(true);
  }, [folded]);
  return (
    <div
      id={id}
      className="side-fold"
      data-folded={folded || undefined}
      data-settled={settled || undefined}
      inert={folded}
      onTransitionEnd={(e: TransitionEvent) => e.target === e.currentTarget && !folded && setSettled(true)}
    >
      <div>{children}</div>
    </div>
  );
}

/** A feed's unread count (NP-132): a small well pill, ink on the current row, a quiet 0 when nothing is new. */
function CountPill({ count, current }: { count: number; current: boolean }) {
  if (count === 0) return <span className="w-[18px] text-right text-xs text-subtle">0</span>;
  return (
    <span
      className={`flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-[5px] text-2xs font-semibold tabular-nums ${current ? "bg-ink-btn text-on-ink-btn" : "bg-well text-ink"}`}
    >
      {count}
    </span>
  );
}

/** What the update row and its strip icon say (sheet 42); the hint of the strip carries all of it. */
function updateLabel(t: TFunction, update: Offer, short = false): string {
  switch (update.state) {
    case "available":
      return short ? t("update.available") : t("update.title", { version: update.version });
    case "downloading":
      return t("update.downloading");
    case "installing":
      return t("update.restarting");
    case "failed":
      return t("update.failed");
  }
}

/**
 * «Update available» above the browser status (NP-038, sheet 42): collection blue with a glow that
 * breathes twice when it appears; the download draws a bar along the bottom; a failure is ochre.
 */
function UpdateRow({ update, percent, onClick }: { update: Offer; percent: number | null; onClick: () => void }) {
  const { t } = useTranslation();
  const failed = update.state === "failed";
  const right = update.state === "available" ? update.version : update.state === "downloading" && percent !== null ? `${percent}%` : failed ? t("update.retry") : "";
  return (
    <button
      // A new version breathes again.
      key={update.state === "available" ? update.version : update.state}
      type="button"
      onClick={onClick}
      title={updateLabel(t, update)}
      data-update={update.state}
      className={`relative flex h-8 w-full shrink-0 items-center gap-2.5 overflow-hidden rounded-[9px] px-2.5 text-left text-sm font-semibold ${
        failed
          ? "bg-amber-soft text-on-amber-soft hover:brightness-[0.97]"
          : `bg-update-soft text-on-update-soft hover:brightness-[0.97] ${update.state === "available" ? "animate-update-pulse shadow-[0_0_8px_var(--np-update-glow)]" : ""}`
      }`}
    >
      <span className={`flex shrink-0 ${failed ? "text-amber" : "text-update"}`}>
        <Icon icon={failed ? TriangleAlert : CircleArrowUp} />
      </span>
      <span className="min-w-0 flex-1 truncate">{updateLabel(t, update, true)}</span>
      {right && <span className={`text-xs font-medium ${failed ? "text-amber" : "text-update"}`}>{right}</span>}
      {update.state === "downloading" && (
        <span aria-hidden className="absolute right-2.5 bottom-[3px] left-2.5 h-0.5 overflow-hidden rounded-full bg-update-track">
          <span className="block h-full rounded-full bg-update" style={{ width: `${percent ?? 0}%` }} />
        </span>
      )}
    </button>
  );
}

/**
 * The plan above the browser status (NP-066, sheet 45), quiet and without a fill. Free: an outlined
 * heart in the colour of the season and «Support Koona Pin» in the accent, the title of the dialog it
 * opens; «Free version» is left to the hint, since next to «Support» it did not fit the sidebar in
 * most languages. Supporter: the badge — a filled heart and «Supporter»;
 * it opens the dialog of the plan and its perks. With the badge turned off there, the heart stays
 * plain: the row is still the way to that dialog.
 */
function PlanRow({ plan, badge, onClick }: { plan: "free" | "supporter"; badge: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  const free = plan === "free";
  const filled = !free && badge;
  return (
    <button
      type="button"
      onClick={onClick}
      title={free ? t("supporter.rowHint") : t("supporter.badge")}
      data-plan-row={plan}
      {...(free ? { "data-free-version": true } : {})}
      className="flex h-8 w-full shrink-0 items-center gap-2.5 rounded-[9px] px-2.5 text-left text-sm text-icon transition-colors duration-150 hover:bg-hover"
    >
      <span className={`flex shrink-0 ${free || filled ? "text-season" : ""}`}>
        <Heart size={16} strokeWidth={1.5} fill={filled ? "currentColor" : "none"} aria-hidden />
      </span>
      {free ? (
        <span className="min-w-0 flex-1 truncate font-medium text-accent">{t("supporter.title")}</span>
      ) : (
        <span className="min-w-0 flex-1 truncate">Supporter</span>
      )}
    </button>
  );
}
/** A drop target and whether the pointer is over it; «Корзина» is lit in the danger tint (sheet 32). */
type Drop = { attr: string; hot: boolean; danger?: boolean };

/**
 * The ring of a target under the pointer: 1.5 px inside, so nothing around it
 * moves. A shadow, not an outline: Chromium rounds an outline to whole pixels.
 */
const hotOutline = "shadow-[inset_0_0_0_1.5px_var(--np-accent)]";
const dropLook = (drop: Drop) =>
  drop.danger
    ? "bg-danger-soft text-on-danger-soft shadow-[inset_0_0_0_1.5px_var(--np-danger)]"
    : `bg-accent-soft text-on-accent-soft ${hotOutline}`;

/**
 * Where a moved collection would land (sheet 41): a 2 px accent line in the
 * gap above a row, or below the last one, with a ring at its start.
 */
function LandingLine({ at }: { at: "top" | "bottom" }) {
  return (
    <span
      aria-hidden
      data-landing
      className={`pointer-events-none absolute right-1 left-1.5 z-10 h-0.5 rounded-full bg-accent ${at === "top" ? "-top-[2px]" : "-bottom-[2px]"}`}
    >
      <span className="absolute -top-[3px] -left-1.5 size-2 rounded-full border-2 border-accent bg-panel" />
    </span>
  );
}

/** «Новая коллекция из выбранного» as a target (frame 05): a dashed row under the collections. */
function NewCollectionTarget({ hot }: { hot: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      data-drop="new"
      className={`flex min-h-[43px] items-center gap-2.5 rounded-[10px] py-1.5 pr-2.5 pl-[11px] text-xs ${hot ? dropLook({ attr: "new", hot }) : "text-subtle outline-1 -outline-offset-1 outline-faint outline-dashed"}`}
    >
      <Icon icon={Plus} size={12} className="shrink-0" />
      <span>{t("sidebar.dropNewCollection")}</span>
    </div>
  );
}

/** The new collection's row (sheet 27): its dot, the name field in focus with the name selected, the count, keys under it. */
function NameField({ suggested, count, color, onCreate, onCancel }: NewCollectionField) {
  const { t } = useTranslation();
  const [name, setName] = useState(suggested);
  const done = useRef(false);
  const finish = (create: boolean) => {
    if (done.current) return;
    done.current = true;
    if (create && name.trim()) onCreate(name.trim());
    else onCancel();
  };
  return (
    <div className="flex flex-col gap-1 pb-1">
      <form
        className="flex h-8 items-center gap-2.5 rounded-[9px] border-[1.5px] border-accent bg-card pr-2.5 pl-1.5 shadow-[0_0_0_3px_color-mix(in_srgb,var(--np-accent)_25%,transparent)]"
        onSubmit={(e) => {
          e.preventDefault();
          finish(true);
        }}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          <Dot color={color} />
        </span>
        <input
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          aria-label={t("sidebar.newCollectionName")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => finish(false)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          }}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none selection:bg-accent/20"
        />
        <span className="text-xs text-subtle">{count}</span>
      </form>
      {/* Two keys, each whole: the sidebar is narrower than the line of frame 27 in Russian. */}
      <p className="flex flex-wrap gap-x-1.5 px-2.5 text-2xs text-subtle">
        <span className="whitespace-nowrap">{t("sidebar.newCollectionCreate")}</span>
        <span aria-hidden>·</span>
        <span className="whitespace-nowrap">{t("sidebar.newCollectionCancel")}</span>
      </p>
    </div>
  );
}

/** A row's name: one longer than the row fades out at its end (2.1.2); one that fits is left whole. */
function FadeLabel({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => setClipped(el.scrollWidth > el.clientWidth);
    measure();
    // Inter arrives after the first paint, and a folded section opens to its width later.
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    document.fonts.ready.then(measure);
    return () => watch.disconnect();
  }, [text]);
  return (
    <span ref={ref} className="fade-end min-w-0 flex-1" data-clipped={clipped || undefined}>
      {text}
    </span>
  );
}

function NavRow({
  icon,
  label,
  count,
  badge,
  active = false,
  onClick,
  title,
  plain = false,
  trailing,
  danger = false,
  drop,
  onPointerDown,
  onKeyDown,
  collection = false,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  /** An accent counter, shown when above zero: bookmarks waiting in the inbox. */
  badge?: number;
  active?: boolean;
  onClick?: () => void;
  title?: string;
  /** Regular weight: collections and the bottom items. */
  plain?: boolean;
  trailing?: ReactNode;
  danger?: boolean;
  /** A drop target while the selection is dragged (NP-030). */
  drop?: Drop;
  onPointerDown?: (e: PointerEvent) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  /** A collection, moved by a drag and `Alt ↑` / `Alt ↓` (NP-114). */
  collection?: boolean;
}) {
  const hot = drop?.hot;
  const look = hot
    ? `${dropLook(drop)} ${plain ? "" : "font-medium"}`
    : `${active ? "bg-raised font-semibold shadow-raised" : `${plain ? "" : "font-medium"} hover:bg-hover`} ${danger ? "text-danger" : "text-ink"}`;
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      aria-current={active ? "page" : undefined}
      aria-keyshortcuts={collection ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
      data-collection={collection || undefined}
      title={title}
      data-drop={drop?.attr}
      className={`flex h-8 w-full shrink-0 items-center gap-2.5 rounded-[9px] px-2.5 text-left text-sm transition-[background-color,color,box-shadow] duration-150 ${look}`}
    >
      <span className={`flex shrink-0 ${hot ? (drop.danger ? "text-danger" : "") : active ? "text-accent" : "text-icon"}`}>{icon}</span>
      <FadeLabel text={label} />
      {count !== undefined && (
        <span className={`text-xs font-normal ${hot ? (drop.danger ? "text-danger" : "text-accent-muted") : "text-subtle"}`}>{count}</span>
      )}
      {!!badge && (
        <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-[7px] text-2xs font-semibold text-on-accent">
          {badge}
        </span>
      )}
      {trailing}
    </button>
  );
}

function StripButton({
  label,
  children,
  active = false,
  onClick,
  drop,
  onPointerDown,
  onKeyDown,
  collection = false,
}: {
  label: string;
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  /** Collections and «Корзина» are drop targets in the strip too (sheet 32). */
  drop?: Drop;
  onPointerDown?: (e: PointerEvent) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  /** A collection's dot, moved by a drag and `Alt ↑` / `Alt ↓` (NP-114). */
  collection?: boolean;
}) {
  const look = drop?.hot
    ? `${dropLook(drop)} ${drop.danger ? "text-danger" : "text-icon"}`
    : active
      ? "bg-raised text-accent shadow-raised"
      : "text-icon hover:bg-hover";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-current={active ? "page" : undefined}
      aria-keyshortcuts={collection ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
      data-collection={collection || undefined}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      data-drop={drop?.attr}
      className={`flex h-8 w-9 items-center justify-center rounded-[9px] transition-[background-color,color,box-shadow] duration-150 ${look}`}
    >
      {children}
    </button>
  );
}
