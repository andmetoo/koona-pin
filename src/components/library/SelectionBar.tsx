import { useRef, useState } from "react";
import { ArrowUpFromLine, BookOpen, BookOpenText, FileSpreadsheet, FileText, Folder, Layers, LucideIcon, Plus, RefreshCw, RotateCcw, Heart, Tag as TagIcon, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Collection, ExportFormat, Tag } from "../../types";
import { Icon } from "../icons";
import { Hint } from "../ui/Hint";
import { Menu, MenuEntry } from "../ui/Menu";
import { deleteKey, deleteKeyshortcuts } from "../../services/keys";
import { collectionEntries } from "./Bookmarks";
import { TagField } from "./Fields";

/** What the bar asks App to do with the selection (NP-029). */
export interface SelectionActions {
  /** The reading sheet for the last one clicked (NP-123): «Read · Space». */
  read: () => void;
  move: (collectionId: number | null) => void;
  /** «Новая коллекция из выбранного…»: the name field in the sidebar (Р-27). */
  newCollection: () => void;
  tag: (name: string) => void;
  favorite: (favorite: boolean) => void;
  /** Into Reading, or out of it (NP-121). */
  reading: (reading: boolean) => void;
  export: (format: ExportFormat) => void;
  /** Export → «Add to bundle» (share-bundle.md, M6): the selection into the bundle; not in the trash. */
  addToBundle: () => void;
  /** «Refresh previews»: their pages read again in the background, as Settings → Storage does. */
  refresh: () => void;
  trash: () => void;
  restore: () => void;
  /** After the dialog of frame 26; no undo. */
  deleteForever: () => void;
}

/** A popover of the bar: a menu or the tag field, with the button that opened it. */
type Popover = { id: "move" | "export"; anchor: DOMRect; trigger: HTMLElement } | { id: "tag"; left: number; trigger: HTMLElement };

/**
 * The dark bar 52 px high at the bottom of the content (frames 04 and 27,
 * sheet 31): «N выбрано · Read · В коллекцию… · Тег · В избранное · Reading ·
 * Обновить превью · Экспорт · В корзину · ✕». In the trash it offers «Восстановить · Экспорт ·
 * Удалить навсегда…». One bar at every width (#319): the count, then icons,
 * each named with its key by its hint, as frame 27 draws it in a narrow
 * window. Under it, only when there is one, a message: selected bookmarks the
 * list hides, or how to drop a drag. While an action runs the buttons wait: a
 * second click would not repeat it. A second click on the button of an open
 * menu or tag field closes it.
 */
export function SelectionBar({
  count,
  hidden,
  narrowed,
  trash,
  allStarred,
  inReading = false,
  busy,
  collections,
  tags,
  actions,
  onClear,
  dragging = false,
}: {
  count: number;
  /** Selected bookmarks the list does not show; actions still include them. */
  hidden: number;
  /** Search, a tag or a site narrows the section. */
  narrowed: boolean;
  /** The selection is in the trash. */
  trash: boolean;
  /** Every selected bookmark has a heart: the button takes it off. */
  allStarred: boolean;
  /** The bar is in Reading: its button takes the selection out (NP-121). */
  inReading?: boolean;
  busy: boolean;
  collections: Collection[];
  tags: Tag[];
  actions: SelectionActions;
  onClear: () => void;
  /** The selection is being dragged (NP-030): the row under the bar says how to drop or cancel. */
  dragging?: boolean;
}) {
  const { t } = useTranslation();
  const [popover, setPopover] = useState<Popover | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const exportEntries: MenuEntry[] = [
    // A list holds no trash (kpin-lists.md, «Builder»): the bundle is offered outside it only.
    ...(trash ? [] : ([{ id: "bundle", icon: Layers, label: t("bundle.addToBundle"), count, onSelect: actions.addToBundle }, "separator"] as MenuEntry[])),
    { id: "html", icon: ArrowUpFromLine, label: t("more.exportHtml"), onSelect: () => actions.export("html") },
    { id: "json", icon: FileText, label: t("more.exportJson"), onSelect: () => actions.export("json") },
    { id: "csv", icon: FileSpreadsheet, label: t("more.exportCsv"), onSelect: () => actions.export("csv") },
  ];
  const moveEntries: MenuEntry[] = [
    ...collectionEntries(collections, actions.move, t),
    "separator",
    { id: "new", icon: Plus, label: t("selection.newCollection"), onSelect: actions.newCollection },
  ];
  /** `label` names the icon, in its hint and to a screen reader. */
  type Action = { id: string; icon: LucideIcon; label: string; keys?: string; filled?: boolean; popover?: Popover["id"]; run: (button: HTMLElement) => void };
  const toggle = (id: Popover["id"]) => (button: HTMLElement) => {
    if (popover?.id === id) return setPopover(null);
    if (id === "tag") setPopover({ id, left: button.getBoundingClientRect().left - bar.current!.getBoundingClientRect().left, trigger: button });
    else setPopover({ id, anchor: button.getBoundingClientRect(), trigger: button });
  };
  const list: Action[] = trash
    ? [
        { id: "restore", icon: RotateCcw, label: t("trash.restore"), run: actions.restore },
        { id: "export", icon: ArrowUpFromLine, label: t("selection.export"), popover: "export", run: toggle("export") },
        { id: "delete", icon: Trash2, label: t("trash.deleteForever"), keys: deleteKey(), run: actions.deleteForever },
      ]
    : [
        // First on the bar (sheet S2): the book, «Read · Space» by its hint.
        { id: "read", icon: BookOpenText, label: t("selection.read"), keys: "Space", run: actions.read },
        { id: "move", icon: Folder, label: t("selection.move"), popover: "move", run: toggle("move") },
        { id: "tag", icon: TagIcon, label: t("selection.tag"), popover: "tag", run: toggle("tag") },
        allStarred
          ? // Sheet 31: a filled heart, named in full.
            { id: "favorite", icon: Heart, filled: true, label: t("selection.unfavoriteName"), run: () => actions.favorite(false) }
          : { id: "favorite", icon: Heart, label: t("selection.favorite"), run: () => actions.favorite(true) },
        inReading
          ? { id: "reading", icon: BookOpen, label: t("selection.fromReading"), keys: "R", run: () => actions.reading(false) }
          : { id: "reading", icon: BookOpen, label: t("selection.toReading"), keys: "R", run: () => actions.reading(true) },
        { id: "refresh", icon: RefreshCw, label: t("selection.refresh"), run: actions.refresh },
        { id: "export", icon: ArrowUpFromLine, label: t("selection.export"), popover: "export", run: toggle("export") },
        { id: "trash", icon: Trash2, label: t("selection.trash"), keys: deleteKey(), run: actions.trash },
      ];
  // The keys are in the hints of the buttons (#319): the row under the bar says only what the bar can't.
  const message = dragging
    ? t("drag.keys")
    : hidden
    ? t(narrowed ? "selection.hiddenBySearch" : "selection.hiddenElsewhere", { count: hidden, total: count })
    : null;
  return (
    <div className="flex w-full flex-col items-center gap-2">
      <div
        ref={bar}
        role="toolbar"
        aria-label={t("selection.label")}
        aria-busy={busy || undefined}
        className="relative flex h-[52px] max-w-full animate-appear items-center gap-1 rounded-2xl bg-toast py-2 pr-2 pl-4 text-sm text-[#e9e6dc] shadow-[0_10px_24px_rgb(0_0_0/0.19)]"
      >
        <span role="status" className="flex shrink-0 items-center gap-1">
          <span className="rounded-sm bg-accent px-2 py-0.5 font-bold text-on-accent">{count}</span>{" "}
          <span className="font-medium">{t("selection.selected", { count })}</span>
        </span>
        <span aria-hidden className="mx-1.5 h-[22px] w-px shrink-0 bg-[#4a4b44] dark:bg-[#55554c]" />
        {list.map((action) => {
          const open = !!action.popover && popover?.id === action.popover;
          return (
            // Keyed by its id: «В избранное» becoming «Из избранного» must not remount the focused button.
            <Hint key={action.id} label={action.label} keys={action.keys} side="top">
              <button
                type="button"
                disabled={busy}
                aria-label={action.label}
                aria-keyshortcuts={keyshortcuts(action.keys)}
                aria-haspopup={action.popover === "move" || action.popover === "export" ? "menu" : undefined}
                aria-expanded={action.popover ? open : undefined}
                // The tag field closes on blur: pressing its own button must not blur it first.
                onMouseDown={(e) => open && action.popover === "tag" && e.preventDefault()}
                onClick={(e) => action.run(e.currentTarget)}
                className={`flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-150 hover:bg-white/10 hover:text-white disabled:text-white/45 disabled:hover:bg-transparent ${open ? "bg-white/10 text-white" : ""}`}
              >
                <Icon icon={action.icon} size={15} fill={action.filled ? "currentColor" : "none"} />
              </button>
            </Hint>
          );
        })}
        <span className="min-w-2 flex-1" />
        <Hint label={t("selection.clear")} keys="Esc" side="top">
          <button
            type="button"
            aria-label={t("selection.clear")}
            aria-keyshortcuts="Escape"
            onClick={onClear}
            className="flex size-[30px] shrink-0 items-center justify-center rounded-lg text-[#9a998e] transition-colors duration-150 hover:bg-white/10 hover:text-white"
          >
            <Icon icon={X} size={14} />
          </button>
        </Hint>
        {popover?.id === "tag" && (
          // «Тег» (sheet 31): over its button, like a menu over its button (frame 15).
          <div
            style={{ left: Math.max(0, popover.left - 6) }}
            className="absolute bottom-full mb-2 w-[280px] animate-appear rounded-xl border border-border bg-card p-1.5 text-ink shadow-menu"
          >
            <TagField
              label={t("selection.tagLabel")}
              placeholder={t("selection.tagPlaceholder")}
              suggestions={tags}
              inputClassName="field h-8 w-full rounded-lg px-2.5 text-sm"
              onAdd={(name) => {
                setPopover(null);
                actions.tag(name);
              }}
              onClose={() => setPopover(null)}
            />
          </div>
        )}
      </div>
      {message && (
        // On a card, so it reads over the cards the list scrolls under it.
        <p className="max-w-full truncate rounded-md border border-border bg-card px-2.5 py-0.5 text-2xs leading-4 text-muted shadow-menu">{message}</p>
      )}
      {popover && popover.id !== "tag" && (
        <Menu
          label={popover.id === "move" ? t("selection.move") : t("selection.export")}
          anchor={popover.anchor}
          trigger={popover.trigger}
          align="start"
          // «Новая коллекция из выбранного…» fits whole.
          width={popover.id === "move" ? 292 : undefined}
          entries={popover.id === "move" ? moveEntries : exportEntries}
          onClose={() => setPopover(null)}
        />
      )}
    </div>
  );
}

/** A key of a hint as `aria-keyshortcuts` names it. */
const keyshortcuts = (keys?: string) => (keys === deleteKey() ? deleteKeyshortcuts() : keys);
