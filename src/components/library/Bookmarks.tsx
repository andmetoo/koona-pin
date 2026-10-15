import { CSSProperties, memo, MouseEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, BookCheck, BookOpen, Copy, ExternalLink, MoreHorizontal, Pencil, RefreshCw, RotateCcw, Heart, Tag as TagIcon, Trash2, Folder } from "lucide-react";
import { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Bookmark, Collection } from "../../types";
import { collectionColor } from "../../services/collections";
import { coverOf, monogram, pendingFor, VIEW } from "../../services/cover";
import { daysLeft } from "../../services/library";
import { Icon } from "../icons";
import { Menu, MenuEntry } from "../ui/Menu";

export interface BookmarkActions {
  open: (url: string) => void;
  copy: (url: string) => void;
  edit: (bookmark: Bookmark) => void;
  favorite: (bookmark: Bookmark) => void;
  /** Into Reading or out of it, with an undo in the notice (NP-121). */
  reading: (bookmark: Bookmark) => void;
  /** Marked read or unread by hand. */
  read: (bookmark: Bookmark) => void;
  move: (bookmark: Bookmark, collectionId: number | null) => void;
  /** To the trash, with an undo in the notice (NP-022). */
  trash: (bookmark: Bookmark) => void;
  restore: (bookmark: Bookmark) => void;
  /** From the trash for good, after a dialog (NP-023). */
  deleteForever: (bookmark: Bookmark) => void;
  tag: (name: string) => void;
  /** Show only this site: the filter chip of the search row (NP-013). */
  domain: (domain: string) => void;
  /** «Обновить превью»: the page read again for its picture and icon (NP-087). */
  refresh: (bookmark: Bookmark) => void;
  /**
   * A click selects this one alone, `Ctrl`+click toggles it, `Shift`+click adds
   * the range from the last one clicked (NP-028, NP-123).
   */
  select: (bookmark: Bookmark, how: "only" | "toggle" | "range") => void;
  /** The reading sheet over the list (NP-123): «Read» of the shutter, `Space` on a card. */
  readHere: (bookmark: Bookmark) => void;
  /** Double-click, `Enter` and the links of a row: where «Open links» says (Р-69, point 5). */
  follow: (bookmark: Bookmark) => void;
  /** «Open links» is «In browser»: the links of a row carry ↗. */
  linksToBrowser: boolean;
}

/** The domain under a card or in a row: a click filters the library by that site. */
function DomainButton({ b, actions, className }: { b: Bookmark; actions: BookmarkActions; className: string }) {
  const { t } = useTranslation();
  const label = t("card.filterDomain", { domain: b.domain });
  return (
    <button type="button" title={label} aria-label={label} onClick={() => actions.domain(b.domain)} className={`truncate text-left hover:text-ink hover:underline ${className}`}>
      {b.domain}
    </button>
  );
}

/**
 * «В коллекцию»: collections with their dot and key `1`–`9`, then «Без
 * коллекции». `current` is checked; the selection bar (NP-029) has none.
 */
export function collectionEntries(
  collections: Collection[],
  onMove: (collectionId: number | null) => void,
  t: TFunction,
  current?: number | null,
): MenuEntry[] {
  return [
    ...collections.map((c, index) => ({
      id: `c${c.id}`,
      label: c.name,
      dot: collectionColor(c.id),
      keys: index < 9 ? String(index + 1) : undefined,
      checked: current === c.id,
      onSelect: () => onMove(c.id),
    })),
    ...(collections.length ? ["separator" as const] : []),
    {
      id: "none",
      label: t("card.noCollection"),
      checked: current === null,
      onSelect: () => onMove(null),
    },
  ];
}

const moveEntries = (b: Bookmark, collections: Collection[], actions: BookmarkActions, t: TFunction) =>
  collectionEntries(collections, (collectionId) => actions.move(b, collectionId), t, b.collection_id);

/** Menu «⋯» of a bookmark (frame «15 · Меню карточки»); in the trash, restore, open and delete for good (frame 25). */
function menuEntries(b: Bookmark, collections: Collection[], actions: BookmarkActions, t: TFunction): MenuEntry[] {
  const soon = t("common.soon");
  if (b.deleted_at)
    return [
      { id: "restore", icon: RotateCcw, label: t("trash.restore"), onSelect: () => actions.restore(b) },
      "separator",
      { id: "open", icon: ExternalLink, label: t("card.openInBrowser"), keys: "Enter", onSelect: () => actions.open(b.url) },
      { id: "copy", icon: Copy, label: t("card.copyLink"), keys: "Ctrl C", onSelect: () => actions.copy(b.url) },
      "separator",
      { id: "delete", icon: Trash2, label: t("trash.deleteForever"), keys: "Del", onSelect: () => actions.deleteForever(b) },
    ];
  return [
    { id: "open", icon: ExternalLink, label: t("card.openInBrowser"), keys: "Enter", onSelect: () => actions.open(b.url) },
    { id: "copy", icon: Copy, label: t("card.copyLink"), keys: "Ctrl C", onSelect: () => actions.copy(b.url) },
    { id: "edit", icon: Pencil, label: t("card.edit"), keys: "E", onSelect: () => actions.edit(b) },
    "separator",
    {
      id: "favorite",
      icon: Heart,
      label: b.is_favorite ? t("card.unfavorite") : t("card.favorite"),
      keys: "F",
      onSelect: () => actions.favorite(b),
    },
    {
      id: "reading",
      icon: BookOpen,
      label: b.reading_at ? t("card.fromReading") : t("card.toReading"),
      keys: "R",
      onSelect: () => actions.reading(b),
    },
    // Read or not matters in Reading, and for an article read once.
    ...(b.reading_at || b.read_at
      ? [{ id: "read", icon: BookCheck, label: b.read_at ? t("card.markUnread") : t("card.markRead"), onSelect: () => actions.read(b) }]
      : []),
    { id: "move", icon: Folder, label: t("card.moveTo"), submenu: moveEntries(b, collections, actions, t) },
    { id: "tag", icon: TagIcon, label: t("card.addTag"), keys: "T", disabled: true, disabledHint: soon },
    "separator",
    { id: "refresh", icon: RefreshCw, label: t("card.refresh"), onSelect: () => actions.refresh(b) },
    "separator",
    { id: "delete", icon: Trash2, label: t("card.delete"), keys: "Del", onSelect: () => actions.trash(b) },
  ];
}

function DaysLeft({ deletedAt, className = "" }: { deletedAt: string; className?: string }) {
  const { t } = useTranslation();
  const days = daysLeft(deletedAt);
  return (
    <span className={`shrink-0 text-xs text-subtle ${className}`}>
      {days > 0 ? t("trash.daysLeft", { count: days }) : t("trash.lastDay")}
    </span>
  );
}

/**
 * The heart of a card or row (NP-086): always there, grey until the bookmark
 * is a favorite, accent then; one click toggles it. A 13 px icon in a 24×24
 * target, so `className` pulls the target into the line without making it
 * taller. Ctrl and Shift clicks never reach it: the card selects instead.
 * `t` is the card's own: no translation hook per heart.
 */
function FavoriteButton({ b, actions, t, className = "" }: { b: Bookmark; actions: BookmarkActions; t: TFunction; className?: string }) {
  return (
    <button
      type="button"
      data-favorite
      aria-label={b.is_favorite ? t("card.unfavorite") : t("card.favorite")}
      aria-pressed={b.is_favorite}
      onClick={() => actions.favorite(b)}
      className={`flex size-6 shrink-0 items-center justify-center rounded-md transition-colors duration-150 ${b.is_favorite ? "text-accent" : "text-faint hover:text-icon"} ${className}`}
    >
      <Icon icon={Heart} size={13} className={b.is_favorite ? "fill-accent" : ""} />
    </button>
  );
}

type Anchor = DOMRect | { x: number; y: number };

/** A menu opened from a button, the context menu or `Shift F10`. */
function useAnchoredMenu(label: string, entries: () => MenuEntry[]) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const menu = anchor && <Menu label={label} anchor={anchor} onClose={() => setAnchor(null)} entries={entries()} />;
  return { menu, open: !!anchor, show: setAnchor };
}

function useBookmarkMenu(b: Bookmark, collections: Collection[], actions: BookmarkActions) {
  const { t } = useTranslation();
  const label = t("card.actions", { title: b.title });
  const { menu, open, show } = useAnchoredMenu(label, () => menuEntries(b, collections, actions, t));
  const button = useRef<HTMLButtonElement>(null);
  const trigger = (className: string) => (
    <button
      ref={button}
      type="button"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => show(open ? null : button.current!.getBoundingClientRect())}
      className={className}
    >
      <Icon icon={MoreHorizontal} size={14} />
    </button>
  );
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    show({ x: e.clientX, y: e.clientY });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      show(button.current?.getBoundingClientRect() ?? (e.target as HTMLElement).getBoundingClientRect());
    }
  };
  return { menu, trigger, onContextMenu, onKeyDown, open };
}

/** Favicon, or the first letter when there is none. */
export function SiteMark({ b, size = 14 }: { b: Bookmark; size?: number }) {
  // The address that failed: a cached failure comes before any effect could reset a flag.
  const [failed, setFailed] = useState<string | null>(null);
  return b.favicon_url && failed !== b.favicon_url ? (
    <img src={b.favicon_url} alt="" width={size} height={size} className="shrink-0 rounded-[3px] object-contain" onError={() => setFailed(b.favicon_url)} />
  ) : (
    <span
      style={{ width: size, height: size, fontSize: size * 0.64 }}
      className="flex shrink-0 items-center justify-center rounded-[3px] bg-hover font-semibold text-muted"
    >
      {/* The same letter as the cover above it. */}
      {monogram(b.domain, b.title)}
    </span>
  );
}

/** Where the pointer is over a live cover, −1…1 on each axis, for the tile to lean towards. */
function followPointer(e: React.PointerEvent<HTMLElement>) {
  const box = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--cx", (((e.clientX - box.left) / box.width) * 2 - 1).toFixed(3));
  e.currentTarget.style.setProperty("--cy", (((e.clientY - box.top) / box.height) * 2 - 1).toFixed(3));
}
function releasePointer(e: React.PointerEvent<HTMLElement>) {
  e.currentTarget.style.removeProperty("--cx");
  e.currentTarget.style.removeProperty("--cy");
}

/**
 * The cover of a bookmark without a picture (NP-087, Р-43): the site's
 * gradient, a pattern of the page, the site's icon on a tile and, when there
 * is room, its name. A small icon would blur when enlarged: the tile shows
 * the site's letter and the icon at its own size beside it. `live` covers —
 * grid cards and triage — answer the pointer: a slow drift of the
 * gradient, the tile leaning towards the pointer. Sizes follow the preview
 * (container units in `app.css`), so one cover serves 64×44 and 280 px.
 */
function Cover({ b, live, small }: { b: Bookmark; live: boolean; small: boolean }) {
  const cover = useMemo(() => coverOf(b.domain, b.url), [b.domain, b.url]);
  // Kept with the address it was learnt for: a cached icon loads before any
  // effect would run, so resetting in an effect would lose its answer.
  const [learnt, setLearnt] = useState<{ url: string; icon: "large" | "small" | "none" } | null>(null);
  const icon = !b.favicon_url ? "none" : learnt?.url === b.favicon_url ? learnt.icon : "loading";
  const setIcon = (value: "large" | "small" | "none") => b.favicon_url && setLearnt({ url: b.favicon_url, icon: value });
  return (
    <span
      data-preview-fallback
      data-cover={cover.pattern}
      data-live={live || undefined}
      onPointerMove={live ? followPointer : undefined}
      onPointerLeave={live ? releasePointer : undefined}
      className="cover"
      style={{ "--from": cover.from, "--to": cover.to, "--angle": `${cover.angle}deg` } as CSSProperties}
    >
      {/* A thumbnail would not show it, and a list makes a row each frame while it scrolls. */}
      {!small && (
        <svg aria-hidden viewBox={`0 0 ${VIEW.width} ${VIEW.height}`} preserveAspectRatio="xMidYMid slice" className="cover-pattern">
          {cover.path && <path d={cover.path} />}
          {cover.circles.map(([cx, cy, r], i) => (
            <circle key={i} cx={cx} cy={cy} r={r} />
          ))}
        </svg>
      )}
      <span className="cover-tile" data-icon={icon}>
        {b.favicon_url && icon !== "none" && (
          <img
            src={b.favicon_url}
            alt=""
            decoding="async"
            onLoad={(e) => setIcon(e.currentTarget.naturalWidth >= 32 ? "large" : "small")}
            onError={() => setIcon("none")}
          />
        )}
        {(icon === "small" || icon === "none") && <span className="cover-letter">{monogram(b.domain, b.title)}</span>}
      </span>
      <span className="cover-name">{b.domain}</span>
    </span>
  );
}

/**
 * The page's picture; the cover when there is none or it does not load.
 * While a link just saved waits for its metadata, a neutral shimmer says the
 * picture is on its way rather than missing (NP-087).
 */
export function Preview({ b, live = false, small = false }: { b: Bookmark; live?: boolean; small?: boolean }) {
  // The address that failed, not a flag: a cached failure comes before any effect.
  const [failed, setFailed] = useState<string | null>(null);
  const broken = failed !== null && failed === b.image_url;
  const setBroken = () => setFailed(b.image_url);
  const [, recheck] = useState(0);
  const pending = pendingFor(b);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => recheck((n) => n + 1), pending);
    return () => window.clearTimeout(timer);
  }, [pending > 0, b.id]);
  if (b.image_url && !broken)
    return <img src={b.image_url} alt="" loading="lazy" decoding="async" className="size-full object-cover" onError={setBroken} />;
  return pending ? <span data-preview-pending className="cover-pending" /> : <Cover b={b} live={live} small={small} />;
}

/** What a click inside a card or row acts on by itself, rather than selecting it. */
const OWN_CLICK = "button, a, input, textarea, select, [data-menu]";

/**
 * The card or row as one control (NP-123, Р-69 point 4): a click selects it,
 * `Ctrl`+click and `Shift`+click add to the selection — the last two even on a
 * link or a button, before they see the click. Double-click and `Enter` open it
 * as «Open links» says, `Space` reads it in the sheet. Focus rings it in ink
 * (`app.css`), apart from the accent of the selection; a selected one says so
 * to a screen reader through `aria-describedby`, and App's live region says
 * the change.
 */
function cardControl(b: Bookmark, actions: BookmarkActions, selected: boolean) {
  const own = (e: { target: EventTarget }) => !!(e.target as HTMLElement).closest(OWN_CLICK);
  return {
    tabIndex: 0,
    "aria-label": b.title || b.url,
    "aria-describedby": selected ? SELECTED_NOTE : undefined,
    onClickCapture: (e: MouseEvent) => {
      if (!(e.ctrlKey || e.metaKey || e.shiftKey)) return;
      // The menu lives inside the card but is not part of it.
      if ((e.target as HTMLElement).closest("[data-menu]")) return;
      e.preventDefault();
      e.stopPropagation();
      actions.select(b, e.shiftKey ? "range" : "toggle");
    },
    onClick: (e: MouseEvent) => {
      if (e.defaultPrevented || own(e)) return;
      actions.select(b, "only");
    },
    onDoubleClick: (e: MouseEvent) => {
      if (own(e) || e.ctrlKey || e.metaKey || e.shiftKey) return;
      window.getSelection()?.removeAllRanges();
      actions.follow(b);
    },
    // Shift would otherwise select the text between the two clicks, a double-click a word.
    onMouseDown: (e: MouseEvent) => {
      if (e.shiftKey || e.detail > 1) e.preventDefault();
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Enter") {
        e.preventDefault();
        actions.follow(b);
      } else if (e.key === " ") {
        e.preventDefault();
        // The trash has no reading, as its shutter has no «Read».
        if (!e.repeat && !b.deleted_at) actions.readHere(b);
      }
    },
  };
}

/** The id of the one hidden «Selected» every selected card points at (rendered by `BookmarkList`). */
export const SELECTED_NOTE = "bookmark-selected-note";

/**
 * The link areas of a row (sheet S1): an anchor for what it is — a screen
 * reader names it a link — that never lets the webview follow it.
 */
function RowLink({ b, actions, className, label, children }: { b: Bookmark; actions: BookmarkActions; className: string; label?: string; children: ReactNode }) {
  return (
    <a
      href={b.url}
      aria-label={label}
      draggable={false}
      onClick={(e) => {
        e.preventDefault();
        // The second click of a double-click would open the page twice.
        if (e.detail < 2) actions.follow(b);
      }}
      // A middle click would open the page inside the app's own window.
      onAuxClick={(e) => e.preventDefault()}
      className={`cursor-pointer ${className}`}
    >
      {children}
    </a>
  );
}

/** Shown while the card or row is hovered, focused or has its menu open. */
const revealed = (group: "card" | "row", open: boolean) =>
  `transition-opacity duration-150 ${group === "card" ? "group-hover/card:opacity-100 group-focus-within/card:opacity-100" : "group-hover/row:opacity-100 group-focus-within/row:opacity-100"} ${open ? "opacity-100" : "opacity-0"}`;


/** Height of a card below its preview: 10 + domain 15 + 10 + two title lines 38 (frame 01). */
export const CARD_TEXT_HEIGHT = 73;

/**
 * Grid card: preview 16:10, site and domain, title in two lines (frame 01).
 * Memoized: scrolling re-renders the list, not the cards that stay on screen.
 */
export const BookmarkCard = memo(function BookmarkCard({
  bookmark: b,
  collections,
  actions,
  selected,
}: {
  bookmark: Bookmark;
  collections: Collection[];
  actions: BookmarkActions;
  selected: boolean;
}) {
  const { t } = useTranslation();
  const menu = useBookmarkMenu(b, collections, actions);
  const control = cardControl(b, actions, selected);
  return (
    <article
      data-bookmark-id={b.id}
      data-selected={selected || undefined}
      data-menu-open={menu.open || undefined}
      className="group/card @container/card flex min-w-0 flex-col gap-2.5 rounded-xl"
      onContextMenu={menu.onContextMenu}
      {...control}
      onKeyDown={(e) => {
        menu.onKeyDown(e);
        if (!e.defaultPrevented) control.onKeyDown(e);
      }}
    >
      {/* Selected: a 2.5 px accent ring 4 px around the preview, radius 14 (frame 04, `app.css`); the image is not tinted. */}
      {/* It clips the shutter waiting above the cover; the ring of the selection is its own outline, not clipped. */}
      <div data-ring className="relative overflow-hidden rounded-xl">
        <div data-preview className="block aspect-[16/10] w-full overflow-hidden rounded-xl bg-hover">
          <Preview b={b} live />
        </div>
        {/* Sheet S4: the link of a card is on its shutter; the rest of the card selects. */}
        <div data-shutter className="shutter">
          <button
            type="button"
            aria-label={t("card.openInBrowserOf", { title: b.title || b.url })}
            onClick={(e) => e.detail < 2 && actions.open(b.url)}
            className="shutter-button shutter-open"
          >
            <Icon icon={ArrowUpRight} size={13} />
            {t("card.openShort")}
          </button>
          {b.deleted_at ? (
            // Frame 25: in the trash «Восстановить» instead of reading.
            <button type="button" onClick={() => actions.restore(b)} className="shutter-button shutter-read">
              <Icon icon={RotateCcw} size={13} />
              {t("trash.restore")}
            </button>
          ) : (
            <button
              type="button"
              aria-label={t("card.readOf", { title: b.title || b.url })}
              aria-keyshortcuts="Space"
              onClick={() => actions.readHere(b)}
              className="shutter-button shutter-read"
            >
              {t("card.read")}
              <kbd aria-hidden>Space</kbd>
            </button>
          )}
          {menu.trigger("shutter-button shutter-read w-[30px] flex-none")}
        </div>
      </div>
      <div className="flex h-[15px] items-center gap-1.5 text-xs text-meta">
        <SiteMark b={b} />
        <DomainButton b={b} actions={actions} className="min-w-0 flex-1" />
        {b.deleted_at ? <DaysLeft deletedAt={b.deleted_at} /> : <FavoriteButton b={b} actions={actions} t={t} className="-my-[4.5px] -mr-[5.5px]" />}
      </div>
      {/* Two lines are reserved, so a title arriving with metadata moves nothing. */}
      <h2 className="line-clamp-2 h-[38px] text-md font-medium" title={b.title}>
        {b.title || b.url}
      </h2>
      {menu.menu}
    </article>
  );
});

function shortDate(value: string, language: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(language, { day: "numeric", month: "short", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function RowAction({ label, onClick, children, ...rest }: { label: string; onClick: (e: MouseEvent<HTMLButtonElement>) => void; children: ReactNode } & React.AriaAttributes) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex size-[27px] items-center justify-center rounded-md text-icon transition-colors duration-150 hover:bg-hover hover:text-ink"
      {...rest}
    >
      {children}
    </button>
  );
}

export const ROW_HEIGHT = 60;

/** List row 60 px: checkbox, thumbnail, text, tags, collection, heart, date (frame 02, NP-086). Memoized like the card. */
export const BookmarkRow = memo(function BookmarkRow({
  bookmark: b,
  collections,
  actions,
  compact,
  selected,
}: {
  bookmark: Bookmark;
  collections: Collection[];
  actions: BookmarkActions;
  /** Narrow window or docked editor: tags give way first (frame 16). */
  compact: boolean;
  selected: boolean;
}) {
  const { t, i18n } = useTranslation();
  const menu = useBookmarkMenu(b, collections, actions);
  const move = useAnchoredMenu(t("card.moveTo"), () => moveEntries(b, collections, actions, t));
  const open = menu.open || move.open;
  const collection = collections.find((c) => c.id === b.collection_id);
  const control = cardControl(b, actions, selected);
  // Selected (sheet S2): the accent border and the soft accent background instead of the hover one.
  const background = selected ? "border-accent bg-accent-soft" : `border-transparent hover:bg-panel ${open ? "bg-panel" : ""}`;
  return (
    <article
      data-bookmark-id={b.id}
      data-selected={selected || undefined}
      onContextMenu={menu.onContextMenu}
      {...control}
      onKeyDown={(e) => {
        menu.onKeyDown(e);
        if (!e.defaultPrevented) control.onKeyDown(e);
      }}
      className={`group/row grid h-[60px] items-center gap-3.5 rounded-xl border py-[7px] pr-[11px] pl-[7px] transition-colors duration-150 ${background} ${compact ? "grid-cols-[64px_minmax(0,1fr)_120px_24px_96px]" : "grid-cols-[64px_minmax(0,1fr)_170px_120px_24px_96px]"}`}
    >
      {/* Sheet S1: the thumbnail and the title are the link; the rest of the row selects. */}
      <RowLink b={b} actions={actions} label={t("card.open", { title: b.title || b.url })} className="h-11 w-16 overflow-hidden rounded-sm bg-hover">
        <span data-preview className="block size-full">
          <Preview b={b} small />
        </span>
      </RowLink>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <h2 className="flex min-w-0 items-center text-md font-medium">
          <RowLink b={b} actions={actions} className="group/link flex min-w-0 items-center gap-1 hover:underline hover:underline-offset-2 focus-visible:underline">
            <span className="truncate" title={b.title}>
              {b.title || b.url}
            </span>
            {actions.linksToBrowser && (
              <Icon
                icon={ArrowUpRight}
                size={13}
                aria-hidden
                className="shrink-0 text-subtle opacity-0 transition-opacity duration-150 group-hover/link:opacity-100 group-focus-visible/link:opacity-100"
              />
            )}
          </RowLink>
        </h2>
        <p className="flex min-w-0 items-center gap-1.5 text-xs">
          <SiteMark b={b} size={12} />
          <DomainButton b={b} actions={actions} className="shrink-0 text-meta" />
          {b.description && (
            <>
              <span className="text-faint">·</span>
              <span className="truncate text-subtle">{b.description}</span>
            </>
          )}
        </p>
      </div>
      {!compact && (
        // A chip that does not fit wraps onto a hidden second line: only whole chips show.
        <div className="flex h-[19px] min-w-0 flex-wrap gap-x-1 gap-y-2 overflow-hidden">
          {(b.tags ?? []).slice(0, 3).map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => actions.tag(tag)}
              className="shrink-0 rounded-xs bg-line px-[7px] pt-0.5 pb-[3px] text-2xs text-icon hover:text-ink"
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      <span data-collection className={`flex min-w-0 items-center gap-[7px] text-xs ${collection ? "text-icon" : "text-faint"}`}>
        {collection && <span className="size-[7px] shrink-0 rounded-full" style={{ background: collectionColor(collection.id) }} />}
        <span className="truncate">{collection?.name ?? t("card.noCollection")}</span>
      </span>
      {/* Its own column, so the hearts stand in a line as in the grid (NP-086, variant A); none in the trash. */}
      {b.deleted_at ? <span /> : <FavoriteButton b={b} actions={actions} t={t} />}
      <div className="relative flex h-[27px] items-center justify-end">
        {b.deleted_at ? (
          <DaysLeft deletedAt={b.deleted_at} className={`transition-opacity duration-150 group-focus-within/row:opacity-0 group-hover/row:opacity-0 ${open ? "opacity-0" : ""}`} />
        ) : (
          <time
            dateTime={b.created_at}
            className={`text-xs text-subtle transition-opacity duration-150 group-focus-within/row:opacity-0 group-hover/row:opacity-0 ${open ? "opacity-0" : ""}`}
          >
            {shortDate(b.created_at, i18n.language)}
          </time>
        )}
        {b.deleted_at ? (
          // Frame 25: restore, or delete for good after the dialog.
          <div className={`absolute right-0 flex gap-0.5 ${revealed("row", open)}`}>
            <button
              type="button"
              onClick={() => actions.restore(b)}
              className="flex h-[27px] items-center gap-1.5 rounded-md border border-border bg-card px-2 text-xs font-medium transition-colors duration-150 hover:bg-hover"
            >
              <Icon icon={RotateCcw} size={13} />
              {t("trash.restore")}
            </button>
            <RowAction label={t("trash.deleteForever")} onClick={() => actions.deleteForever(b)}>
              <Icon icon={Trash2} size={15} />
            </RowAction>
          </div>
        ) : (
        <div className={`absolute right-0 flex gap-0.5 ${revealed("row", open)}`}>
          <RowAction
            label={t("card.moveTo")}
            aria-haspopup="menu"
            aria-expanded={move.open}
            onClick={(e) => move.show(move.open ? null : e.currentTarget.getBoundingClientRect())}
          >
            <Icon icon={Folder} size={15} />
          </RowAction>
          <RowAction label={t("card.delete")} onClick={() => actions.trash(b)}>
            <Icon icon={Trash2} size={15} />
          </RowAction>
        </div>
        )}
      </div>
      {menu.menu}
      {move.menu}
    </article>
  );
});
