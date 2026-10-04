import { memo, MouseEvent, ReactNode, useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, MoreHorizontal, Pencil, RefreshCw, RotateCcw, Star, Tag as TagIcon, Trash2, Folder } from "lucide-react";
import { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Bookmark, Collection } from "../../types";
import { collectionColor } from "../../services/collections";
import { daysLeft } from "../../services/library";
import { Icon } from "../icons";
import { Hint } from "../ui/Hint";
import { Menu, MenuEntry } from "../ui/Menu";

export interface BookmarkActions {
  open: (url: string) => void;
  copy: (url: string) => void;
  edit: (bookmark: Bookmark) => void;
  favorite: (bookmark: Bookmark) => void;
  move: (bookmark: Bookmark, collectionId: number | null) => void;
  /** To the trash, with an undo in the notice (NP-022). */
  trash: (bookmark: Bookmark) => void;
  restore: (bookmark: Bookmark) => void;
  tag: (name: string) => void;
  /** Show only this site: the filter chip of the search row (NP-013). */
  domain: (domain: string) => void;
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

/** «В коллекцию»: collections with their dot and key, then «Без коллекции». */
function moveEntries(b: Bookmark, collections: Collection[], actions: BookmarkActions, t: TFunction): MenuEntry[] {
  return [
    ...collections.map((c, index) => ({
      id: `c${c.id}`,
      label: c.name,
      dot: collectionColor(c.id),
      keys: index < 9 ? String(index + 1) : undefined,
      checked: b.collection_id === c.id,
      onSelect: () => actions.move(b, c.id),
    })),
    "separator" as const,
    {
      id: "none",
      label: t("card.noCollection"),
      checked: b.collection_id === null,
      onSelect: () => actions.move(b, null),
    },
  ];
}

/** Menu «⋯» of a bookmark (frame «15 · Меню карточки»); in the trash, restore and open (frame 25). */
function menuEntries(b: Bookmark, collections: Collection[], actions: BookmarkActions, t: TFunction): MenuEntry[] {
  const soon = t("common.soon");
  if (b.deleted_at)
    return [
      { id: "restore", icon: RotateCcw, label: t("trash.restore"), onSelect: () => actions.restore(b) },
      "separator",
      { id: "open", icon: ExternalLink, label: t("card.openInBrowser"), keys: "Enter", onSelect: () => actions.open(b.url) },
      { id: "copy", icon: Copy, label: t("card.copyLink"), keys: "Ctrl C", onSelect: () => actions.copy(b.url) },
    ];
  return [
    { id: "open", icon: ExternalLink, label: t("card.openInBrowser"), keys: "Enter", onSelect: () => actions.open(b.url) },
    { id: "copy", icon: Copy, label: t("card.copyLink"), keys: "Ctrl C", onSelect: () => actions.copy(b.url) },
    { id: "edit", icon: Pencil, label: t("card.edit"), keys: "E", onSelect: () => actions.edit(b) },
    "separator",
    {
      id: "favorite",
      icon: Star,
      label: b.is_favorite ? t("card.unfavorite") : t("card.favorite"),
      keys: "F",
      onSelect: () => actions.favorite(b),
    },
    { id: "move", icon: Folder, label: t("card.moveTo"), submenu: moveEntries(b, collections, actions, t) },
    { id: "tag", icon: TagIcon, label: t("card.addTag"), keys: "T", disabled: true, disabledHint: soon },
    "separator",
    { id: "refresh", icon: RefreshCw, label: t("card.refresh"), disabled: true, disabledHint: soon },
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
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [b.favicon_url]);
  return b.favicon_url && !broken ? (
    <img src={b.favicon_url} alt="" width={size} height={size} className="shrink-0 rounded-[3px] object-contain" onError={() => setBroken(true)} />
  ) : (
    <span
      style={{ width: size, height: size, fontSize: size * 0.64 }}
      className="flex shrink-0 items-center justify-center rounded-[3px] bg-hover font-semibold text-muted"
    >
      {b.domain[0]?.toUpperCase()}
    </span>
  );
}

/** OpenGraph image; a plate of the same size with the site mark when there is none. */
export function Preview({ b }: { b: Bookmark }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [b.image_url]);
  return b.image_url && !broken ? (
    <img src={b.image_url} alt="" loading="lazy" decoding="async" className="size-full object-cover" onError={() => setBroken(true)} />
  ) : (
    <span data-preview-fallback className="flex size-full items-center justify-center bg-hover">
      <SiteMark b={b} size={20} />
    </span>
  );
}

/**
 * The selection checkbox of frames 01 and 02. Selection itself comes with
 * NP-028; until then it is shown inactive with «Появится в следующих версиях».
 */
function SelectBox({ className, title }: { className: string; title: string }) {
  const { t } = useTranslation();
  return (
    <Hint label={t("common.soon")}>
      <span role="checkbox" aria-checked="false" aria-disabled="true" aria-label={t("card.select", { title })} className={className} />
    </Hint>
  );
}

/** Shown while the card or row is hovered, focused or has its menu open. */
const revealed = (group: "card" | "row", open: boolean) =>
  `transition-opacity duration-150 ${group === "card" ? "group-hover/card:opacity-100 group-focus-within/card:opacity-100" : "group-hover/row:opacity-100 group-focus-within/row:opacity-100"} ${open ? "opacity-100" : "opacity-0"}`;

const previewButton = "flex size-7 items-center justify-center bg-card/95 text-ink transition-colors duration-150 hover:bg-card";

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
}: {
  bookmark: Bookmark;
  collections: Collection[];
  actions: BookmarkActions;
}) {
  const { t } = useTranslation();
  const menu = useBookmarkMenu(b, collections, actions);
  return (
    <article
      data-bookmark-id={b.id}
      className="group/card flex min-w-0 flex-col gap-2.5"
      onContextMenu={menu.onContextMenu}
      onKeyDown={menu.onKeyDown}
    >
      <div className="relative">
        <button
          type="button"
          data-preview
          onClick={() => actions.open(b.url)}
          aria-label={t("card.open", { title: b.title })}
          className="block aspect-[16/10] w-full overflow-hidden rounded-xl bg-hover"
        >
          <Preview b={b} />
        </button>
        <div className={`absolute top-2.5 left-2.5 ${revealed("card", menu.open)}`}>
          <SelectBox title={b.title} className="block size-[22px] rounded-sm border border-subtle bg-card/90" />
        </div>
        <div className={`absolute top-2.5 right-2 flex gap-1 ${revealed("card", menu.open)}`}>
          {b.deleted_at ? (
            // Frame 25: in the trash the star gives way to «Восстановить».
            <button
              type="button"
              onClick={() => actions.restore(b)}
              className={`${previewButton} w-auto gap-1.5 rounded-lg px-2 text-xs font-medium`}
            >
              <Icon icon={RotateCcw} size={13} />
              {t("trash.restore")}
            </button>
          ) : (
            <button
              type="button"
              aria-label={b.is_favorite ? t("card.unfavorite") : t("card.favorite")}
              aria-pressed={b.is_favorite}
              onClick={() => actions.favorite(b)}
              className={`${previewButton} rounded-full`}
            >
              <Icon icon={Star} size={14} className={b.is_favorite ? "fill-accent text-accent" : ""} />
            </button>
          )}
          {menu.trigger(`${previewButton} rounded-xl`)}
        </div>
      </div>
      <div className="flex h-[15px] items-center gap-1.5 text-xs text-meta">
        <SiteMark b={b} />
        <DomainButton b={b} actions={actions} className="min-w-0 flex-1" />
        {b.deleted_at ? (
          <DaysLeft deletedAt={b.deleted_at} />
        ) : (
          b.is_favorite && <Icon icon={Star} size={13} className="fill-accent text-accent" aria-label={t("card.isFavorite")} />
        )}
      </div>
      {/* Two lines are reserved, so a title arriving with metadata moves nothing. */}
      <h2 className="line-clamp-2 h-[38px] text-md font-medium">
        <button type="button" onClick={() => actions.open(b.url)} title={b.title} className="text-left hover:text-accent">
          {b.title || b.url}
        </button>
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

/** List row 60 px: checkbox, thumbnail, text, tags, collection, date (frame 02). Memoized like the card. */
export const BookmarkRow = memo(function BookmarkRow({
  bookmark: b,
  collections,
  actions,
  compact,
}: {
  bookmark: Bookmark;
  collections: Collection[];
  actions: BookmarkActions;
  /** Narrow window or docked editor: tags give way first (frame 16). */
  compact: boolean;
}) {
  const { t, i18n } = useTranslation();
  const menu = useBookmarkMenu(b, collections, actions);
  const move = useAnchoredMenu(t("card.moveTo"), () => moveEntries(b, collections, actions, t));
  const open = menu.open || move.open;
  const collection = collections.find((c) => c.id === b.collection_id);
  return (
    <article
      data-bookmark-id={b.id}
      onContextMenu={menu.onContextMenu}
      onKeyDown={menu.onKeyDown}
      className={`group/row grid h-[60px] items-center gap-3.5 rounded-xl py-2 pr-3 pl-2 transition-colors duration-150 hover:bg-panel ${open ? "bg-panel" : ""} ${compact ? "grid-cols-[18px_64px_minmax(0,1fr)_120px_96px]" : "grid-cols-[18px_64px_minmax(0,1fr)_170px_120px_96px]"}`}
    >
      <div className={revealed("row", open)}>
        <SelectBox title={b.title} className="block size-[18px] rounded-xs border border-faint bg-card" />
      </div>
      <button
        type="button"
        data-preview
        onClick={() => actions.open(b.url)}
        aria-label={t("card.open", { title: b.title })}
        className="h-11 w-16 overflow-hidden rounded-sm bg-hover"
      >
        <Preview b={b} />
      </button>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <h2 className="flex min-w-0 items-center gap-1.5 text-md font-medium">
          <button type="button" onClick={() => actions.open(b.url)} title={b.title} className="truncate text-left hover:text-accent">
            {b.title || b.url}
          </button>
          {b.is_favorite && <Icon icon={Star} size={12} className="shrink-0 fill-accent text-accent" aria-label={t("card.isFavorite")} />}
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
          // Frame 25: one action in the trash.
          <div className={`absolute right-0 ${revealed("row", open)}`}>
            <button
              type="button"
              onClick={() => actions.restore(b)}
              className="flex h-[27px] items-center gap-1.5 rounded-md border border-border bg-card px-2 text-xs font-medium transition-colors duration-150 hover:bg-hover"
            >
              <Icon icon={RotateCcw} size={13} />
              {t("trash.restore")}
            </button>
          </div>
        ) : (
        <div className={`absolute right-0 flex gap-0.5 ${revealed("row", open)}`}>
          <RowAction label={b.is_favorite ? t("card.unfavorite") : t("card.favorite")} aria-pressed={b.is_favorite} onClick={() => actions.favorite(b)}>
            <Icon icon={Star} size={15} className={b.is_favorite ? "fill-accent text-accent" : ""} />
          </RowAction>
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
