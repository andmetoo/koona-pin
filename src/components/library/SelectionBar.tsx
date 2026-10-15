import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUpFromLine, BookOpen, BookOpenText, FileSpreadsheet, FileText, Folder, LucideIcon, Plus, RotateCcw, Heart, Tag as TagIcon, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isMac } from "../../services/keys";
import { Collection, ExportFormat, Tag } from "../../types";
import { Icon } from "../icons";
import { Hint } from "../ui/Hint";
import { Menu, MenuEntry } from "../ui/Menu";
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
  trash: () => void;
  restore: () => void;
  /** After the dialog of frame 26; no undo. */
  deleteForever: () => void;
}

/** A popover of the bar: a menu or the tag field, with the button that opened it. */
type Popover = { id: "move" | "export"; anchor: DOMRect; trigger: HTMLElement } | { id: "tag"; left: number; trigger: HTMLElement };

/**
 * The dark bar 740×52 at the bottom of the content with the hint row under it
 * (frames 04 and 27, sheet 31): «N выбрано · В коллекцию… · Тег · В избранное
 * · Экспорт · В корзину · ✕». In the trash it offers «Восстановить · Экспорт ·
 * Удалить навсегда…». In a narrow window the bar keeps the count and icons,
 * names go to hints and the hint row hides (Р-27). While an action runs the
 * buttons wait: a second click would not repeat it. A second click on the
 * button of an open menu or tag field closes it.
 *
 * NP-123 puts «Read · Space» first (sheet S2). Where the words of a language
 * do not fit the 740 px, the bar tightens step by step: the icons beside
 * words go (S2 has words only), then the key of «Read», then the words, as in
 * a narrow window.
 */
export function SelectionBar({
  count,
  hidden,
  narrowed,
  compact,
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
  compact: boolean;
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
  /** The selection is being dragged (NP-030): the hint row says how to drop or cancel. */
  dragging?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [popover, setPopover] = useState<Popover | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const clear = useRef<HTMLButtonElement>(null);
  /** 0 — as drawn; 1 — no icons beside words; 2 — and no key on «Read»; 3 — icons only. */
  const [tight, setTight] = useState(0);
  const words = `${i18n.language}|${trash}|${allStarred}|${inReading}|${compact}|${String(count).length}`;
  useLayoutEffect(() => setTight(0), [words]);
  useLayoutEffect(() => {
    const element = bar.current;
    // By «×», the last thing on the bar: the hints, there but unseen, reach past its edge anyway.
    const end = clear.current?.getBoundingClientRect().right ?? 0;
    if (element && !compact && tight < 3 && end > element.getBoundingClientRect().right - 7) setTight(tight + 1);
  });
  const exportEntries: MenuEntry[] = [
    { id: "html", icon: ArrowUpFromLine, label: t("more.exportHtml"), onSelect: () => actions.export("html") },
    { id: "json", icon: FileText, label: t("more.exportJson"), onSelect: () => actions.export("json") },
    { id: "csv", icon: FileSpreadsheet, label: t("more.exportCsv"), onSelect: () => actions.export("csv") },
  ];
  const moveEntries: MenuEntry[] = [
    ...collectionEntries(collections, actions.move, t),
    "separator",
    { id: "new", icon: Plus, label: t("selection.newCollection"), onSelect: actions.newCollection },
  ];
  /** `name` — the full name when the label on the bar is shorter. */
  /** `bare`: the icon alone, named by its hint, as in a narrow window. */
  /** `primary`: the accent pill with its key inside (sheet S2), «Read · Space». */
  type Action = { id: string; icon?: LucideIcon; label: string; name?: string; keys?: string; filled?: boolean; bare?: boolean; primary?: boolean; popover?: Popover["id"]; run: (button: HTMLElement) => void };
  const toggle = (id: Popover["id"]) => (button: HTMLElement) => {
    if (popover?.id === id) return setPopover(null);
    if (id === "tag") setPopover({ id, left: button.getBoundingClientRect().left - bar.current!.getBoundingClientRect().left, trigger: button });
    else setPopover({ id, anchor: button.getBoundingClientRect(), trigger: button });
  };
  const list: Action[] = trash
    ? [
        { id: "restore", icon: RotateCcw, label: t("trash.restore"), run: actions.restore },
        { id: "export", icon: ArrowUpFromLine, label: t("selection.export"), popover: "export", run: toggle("export") },
        { id: "delete", icon: Trash2, label: t("trash.deleteForever"), keys: "Del", run: actions.deleteForever },
      ]
    : [
        // First on the bar (sheet S2); in a narrow window the book icon, named by its hint.
        { id: "read", icon: BookOpenText, label: t("selection.read"), keys: "Space", primary: true, run: actions.read },
        { id: "move", icon: Folder, label: t("selection.move"), popover: "move", run: toggle("move") },
        { id: "tag", icon: TagIcon, label: t("selection.tag"), popover: "tag", run: toggle("tag") },
        allStarred
          ? // Sheet 31: a filled heart and «Из избранного», which keeps the bar 740 px wide; the name says it whole.
            { id: "favorite", icon: Heart, filled: true, label: t("selection.unfavorite"), name: t("selection.unfavoriteName"), run: () => actions.favorite(false) }
          : { id: "favorite", icon: Heart, label: t("selection.favorite"), run: () => actions.favorite(true) },
        // No room for a word on a bar 740 px wide: the icon, named in full by its hint. With it
        // the buttons keep 8 px a side and 6 px to their words, the divider 6 px, so the bar is no fuller than before (NP-121).
        inReading
          ? { id: "reading", icon: BookOpen, bare: true, label: t("selection.fromReading"), keys: "R", run: () => actions.reading(false) }
          : { id: "reading", icon: BookOpen, bare: true, label: t("selection.toReading"), keys: "R", run: () => actions.reading(true) },
        { id: "export", icon: ArrowUpFromLine, label: t("selection.export"), popover: "export", run: toggle("export") },
        { id: "trash", icon: Trash2, label: t("selection.trash"), keys: "Del", run: actions.trash },
      ];
  const hint = dragging
    ? t("drag.keys")
    : hidden
    ? t(narrowed ? "selection.hiddenBySearch" : "selection.hiddenElsewhere", { count: hidden, total: count })
    : // ⌘+click and ⌘+A on a Mac, the language's Ctrl elsewhere (#319).
      t(trash ? "selection.keysTrash" : count > 1 ? "selection.keysMany" : "selection.keys", { mod: isMac() ? "⌘" : t("selection.mod") });
  return (
    <div className="flex w-full flex-col items-center gap-2">
      <div
        ref={bar}
        role="toolbar"
        aria-label={t("selection.label")}
        aria-busy={busy || undefined}
        className={`relative flex h-[52px] max-w-full animate-appear items-center gap-1 rounded-2xl bg-toast py-2 pr-2 pl-4 text-sm text-[#e9e6dc] shadow-[0_10px_24px_rgb(0_0_0/0.19)] ${compact ? "" : "w-[740px]"}`}
      >
        <span role="status" className="flex shrink-0 items-center gap-1">
          <span className="rounded-sm bg-accent px-2 py-0.5 font-bold text-on-accent">{count}</span>{" "}
          <span className="font-medium">{t("selection.selected", { count })}</span>
        </span>
        <span aria-hidden className="mx-1.5 h-[22px] w-px shrink-0 bg-[#4a4b44] dark:bg-[#55554c]" />
        {list.map((action) => {
          const open = !!action.popover && popover?.id === action.popover;
          const bare = compact || tight >= 3 || action.bare;
          if (action.primary && !compact && tight < 3)
            return (
              <button
                key={action.id}
                type="button"
                disabled={busy}
                aria-keyshortcuts={action.keys}
                onClick={(e) => action.run(e.currentTarget)}
                className="mr-1 flex h-8 shrink-0 items-center gap-2 rounded-lg bg-accent pr-1.5 pl-3 font-semibold text-on-accent transition-[filter] duration-150 hover:brightness-110 disabled:opacity-45"
              >
                {action.label}
                {tight < 2 && (
                  <kbd aria-hidden className="rounded-xs bg-black/15 px-1.5 py-px font-sans text-2xs font-medium">
                    {action.keys}
                  </kbd>
                )}
              </button>
            );
          return (
            // The same wrapper with or without a hint: «В избранное» becoming
            // «Из избранного» must not remount the focused button.
            <Hint
              key={action.id}
              label={action.name ?? action.label}
              keys={action.keys}
              side="top"
              show={bare || !!action.keys || !!action.name}
            >
              <button
                type="button"
                disabled={busy}
                aria-label={bare ? (action.name ?? action.label) : action.name}
                aria-haspopup={action.popover === "move" || action.popover === "export" ? "menu" : undefined}
                aria-expanded={action.popover ? open : undefined}
                // The tag field closes on blur: pressing its own button must not blur it first.
                onMouseDown={(e) => open && action.popover === "tag" && e.preventDefault()}
                onClick={(e) => action.run(e.currentTarget)}
                className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 transition-colors duration-150 hover:bg-white/10 hover:text-white disabled:text-white/45 disabled:hover:bg-transparent ${open ? "bg-white/10 text-white" : ""} ${bare ? "w-8 justify-center px-0" : ""}`}
              >
                {action.icon && (bare || tight < 1) && <Icon icon={action.icon} size={15} fill={action.filled ? "currentColor" : "none"} />}
                {!bare && action.label}
              </button>
            </Hint>
          );
        })}
        <span className="min-w-2 flex-1" />
        <Hint label={t("selection.clear")} keys="Esc" side="top">
          <button
            ref={clear}
            type="button"
            aria-label={t("selection.clear")}
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
      {!compact && <p className="h-4 max-w-full truncate text-2xs leading-4 text-subtle">{hint}</p>}
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
