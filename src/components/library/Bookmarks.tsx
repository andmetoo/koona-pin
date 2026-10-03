import { MouseEvent, useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, MoreHorizontal, Pencil, RefreshCw, Star, Tag as TagIcon, Trash2, Folder } from "lucide-react";
import { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Bookmark, Collection } from "../../types";
import { collectionColor } from "../../services/collections";
import { Icon } from "../icons";
import { Dot } from "../ui/Controls";
import { Menu, MenuEntry } from "../ui/Menu";

export interface BookmarkActions {
  open: (url: string) => void;
  copy: (url: string) => void;
  edit: (bookmark: Bookmark) => void;
  favorite: (bookmark: Bookmark) => void;
  move: (bookmark: Bookmark, collectionId: number | null) => void;
  remove: (bookmark: Bookmark) => void;
  tag: (name: string) => void;
}

/** Menu «⋯» of a bookmark (frame «15 · Меню карточки»). */
function menuEntries(b: Bookmark, collections: Collection[], actions: BookmarkActions, t: TFunction): MenuEntry[] {
  const soon = t("common.soon");
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
    {
      id: "move",
      icon: Folder,
      label: t("card.moveTo"),
      submenu: [
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
      ],
    },
    { id: "tag", icon: TagIcon, label: t("card.addTag"), keys: "T", disabled: true, disabledHint: soon },
    "separator",
    { id: "refresh", icon: RefreshCw, label: t("card.refresh"), disabled: true, disabledHint: soon },
    "separator",
    { id: "delete", icon: Trash2, label: t("card.delete"), keys: "Del", onSelect: () => actions.remove(b) },
  ];
}

function useBookmarkMenu(b: Bookmark, collections: Collection[], actions: BookmarkActions) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<DOMRect | { x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = anchor && (
    <Menu
      label={t("card.actions", { title: b.title })}
      anchor={anchor}
      onClose={() => setAnchor(null)}
      entries={menuEntries(b, collections, actions, t)}
    />
  );
  const trigger = (className: string) => (
    <button
      ref={button}
      type="button"
      aria-label={t("card.actions", { title: b.title })}
      aria-haspopup="menu"
      aria-expanded={!!anchor}
      onClick={() => setAnchor(anchor ? null : button.current!.getBoundingClientRect())}
      className={className}
    >
      <Icon icon={MoreHorizontal} />
    </button>
  );
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setAnchor({ x: e.clientX, y: e.clientY });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      setAnchor(button.current?.getBoundingClientRect() ?? null);
    }
  };
  return { menu, trigger, onContextMenu, onKeyDown, open: !!anchor };
}

/** Favicon 14 px, or the first letter when there is none. */
function SiteMark({ b, size = 14 }: { b: Bookmark; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [b.favicon_url]);
  return b.favicon_url && !broken ? (
    <img src={b.favicon_url} alt="" width={size} height={size} className="shrink-0 rounded-xs object-contain" onError={() => setBroken(true)} />
  ) : (
    <span
      style={{ width: size, height: size, fontSize: size * 0.64 }}
      className="flex shrink-0 items-center justify-center rounded-xs bg-hover font-semibold text-muted"
    >
      {b.domain[0]?.toUpperCase()}
    </span>
  );
}

/** OpenGraph image; a plate of the same size with the site mark when there is none. */
function Preview({ b }: { b: Bookmark }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [b.image_url]);
  return b.image_url && !broken ? (
    <img src={b.image_url} alt="" loading="lazy" className="size-full object-cover" onError={() => setBroken(true)} />
  ) : (
    <span data-preview-fallback className="flex size-full items-center justify-center bg-hover">
      <SiteMark b={b} size={20} />
    </span>
  );
}

const overlayButton =
  "flex size-7 items-center justify-center rounded-md bg-card/95 text-icon shadow-active transition-colors duration-150 hover:text-ink";

/** Grid card: preview 16:10, site and domain, title in two lines (frame 01). */
export function BookmarkCard({ bookmark: b, collections, actions }: { bookmark: Bookmark; collections: Collection[]; actions: BookmarkActions }) {
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
        <div
          className={`absolute top-2 right-2 flex gap-1.5 transition-opacity duration-150 group-focus-within/card:opacity-100 group-hover/card:opacity-100 ${menu.open ? "opacity-100" : "opacity-0"}`}
        >
          <button
            type="button"
            aria-label={b.is_favorite ? t("card.unfavorite") : t("card.favorite")}
            aria-pressed={b.is_favorite}
            onClick={() => actions.favorite(b)}
            className={overlayButton}
          >
            <Icon icon={Star} size={14} className={b.is_favorite ? "fill-accent text-accent" : ""} />
          </button>
          {menu.trigger(overlayButton)}
        </div>
      </div>
      <div className="flex h-[15px] items-center gap-1.5 text-xs text-meta">
        <SiteMark b={b} />
        <span className="min-w-0 flex-1 truncate">{b.domain}</span>
        {b.is_favorite && <Icon icon={Star} size={12} className="fill-accent text-accent" aria-label={t("card.isFavorite")} />}
      </div>
      <h2 className="line-clamp-2 text-md font-medium">
        <button type="button" onClick={() => actions.open(b.url)} title={b.title} className="text-left hover:text-accent">
          {b.title || b.url}
        </button>
      </h2>
      {menu.menu}
    </article>
  );
}

function shortDate(value: string, language: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(language, { day: "numeric", month: "short", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

/** List row ≈60 px: thumbnail, text, tags, collection, date (frame 02). */
export function BookmarkRow({
  bookmark: b,
  collections,
  actions,
  compact,
}: {
  bookmark: Bookmark;
  collections: Collection[];
  actions: BookmarkActions;
  /** Narrow window: no tag and collection columns. */
  compact: boolean;
}) {
  const { t, i18n } = useTranslation();
  const menu = useBookmarkMenu(b, collections, actions);
  const collection = collections.find((c) => c.id === b.collection_id);
  return (
    <article
      data-bookmark-id={b.id}
      onContextMenu={menu.onContextMenu}
      onKeyDown={menu.onKeyDown}
      className={`group/row grid min-h-[60px] items-center gap-4 rounded-xl px-2 py-2 transition-colors duration-150 hover:bg-panel ${compact ? "grid-cols-[64px_minmax(0,1fr)_96px]" : "grid-cols-[64px_minmax(0,1fr)_170px_120px_96px]"}`}
    >
      <button
        type="button"
        data-preview
        onClick={() => actions.open(b.url)}
        aria-label={t("card.open", { title: b.title })}
        className="h-11 w-16 overflow-hidden rounded-sm bg-hover"
      >
        <Preview b={b} />
      </button>
      <div className="min-w-0">
        <h2 className="truncate text-md font-medium">
          <button type="button" onClick={() => actions.open(b.url)} title={b.title} className="max-w-full truncate text-left hover:text-accent">
            {b.title || b.url}
          </button>
        </h2>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-meta">
          <SiteMark b={b} />
          <span className="truncate">
            {b.domain}
            {b.description && <span className="text-faint"> · </span>}
            {b.description}
          </span>
        </p>
      </div>
      {!compact && (
        <div className="flex min-w-0 flex-wrap gap-1.5 overflow-hidden">
          {(b.tags ?? []).slice(0, 3).map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => actions.tag(tag)}
              className="rounded-sm bg-line px-1.5 py-0.5 text-2xs text-muted hover:text-ink"
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      {!compact && (
        <span data-collection className={`flex min-w-0 items-center gap-2 text-xs ${collection ? "text-muted" : "text-faint"}`}>
          {collection && <Dot color={collectionColor(collection.id)} />}
          <span className="truncate">{collection?.name ?? t("card.noCollection")}</span>
        </span>
      )}
      <div className="relative flex h-7 items-center justify-end">
        <time
          dateTime={b.created_at}
          className={`text-xs text-subtle transition-opacity duration-150 group-focus-within/row:opacity-0 group-hover/row:opacity-0 ${menu.open ? "opacity-0" : ""}`}
        >
          {shortDate(b.created_at, i18n.language)}
        </time>
        <div
          className={`absolute right-0 flex gap-1 transition-opacity duration-150 group-focus-within/row:opacity-100 group-hover/row:opacity-100 ${menu.open ? "opacity-100" : "opacity-0"}`}
        >
          <button
            type="button"
            aria-label={b.is_favorite ? t("card.unfavorite") : t("card.favorite")}
            aria-pressed={b.is_favorite}
            onClick={() => actions.favorite(b)}
            className={overlayButton}
          >
            <Icon icon={Star} size={14} className={b.is_favorite ? "fill-accent text-accent" : ""} />
          </button>
          {menu.trigger(overlayButton)}
        </div>
      </div>
      {menu.menu}
    </article>
  );
}
