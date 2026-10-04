import { FormEvent, useRef, useState } from "react";
import {
  ArrowUpFromLine,
  FileSpreadsheet,
  FileText,
  Folder,
  LucideIcon,
  Plus,
  RotateCcw,
  Star,
  Tag as TagIcon,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Collection, ExportFormat, Tag } from "../../types";
import { collectionColor } from "../../services/collections";
import { foldText } from "../../services/library";
import { Icon } from "../icons";
import { Hint } from "../ui/Hint";
import { Menu, MenuEntry } from "../ui/Menu";

/** What the bar asks App to do with the selection (NP-029). */
export interface SelectionActions {
  move: (collectionId: number | null) => void;
  /** «Новая коллекция из выбранного…»: the name field in the sidebar (Р-27). */
  newCollection: () => void;
  tag: (name: string) => void;
  favorite: (favorite: boolean) => void;
  export: (format: ExportFormat) => void;
  trash: () => void;
  restore: () => void;
  /** After the dialog of frame 26; no undo. */
  deleteForever: () => void;
}

/** Tags offered under the field. */
const SUGGESTIONS = 6;

/**
 * The dark bar 740×52 at the bottom of the content with the hint row under it
 * (frames 04 and 27): «N выбрано · В коллекцию… · Тег · В избранное · Экспорт
 * · В корзину · ✕». In the trash it offers «Восстановить · Экспорт · Удалить
 * навсегда…». In a narrow window the bar keeps the count and icons, names go
 * to hints and the hint row hides (Р-27). While an action runs the buttons
 * wait: a second click would not repeat it.
 */
export function SelectionBar({
  count,
  hidden,
  narrowed,
  compact,
  trash,
  allStarred,
  busy,
  collections,
  tags,
  actions,
  onClear,
}: {
  count: number;
  /** Selected bookmarks the list does not show; actions still include them. */
  hidden: number;
  /** Search, a tag or a site narrows the section. */
  narrowed: boolean;
  compact: boolean;
  /** The selection is in the trash. */
  trash: boolean;
  /** Every selected bookmark has a star: the button takes it off. */
  allStarred: boolean;
  busy: boolean;
  collections: Collection[];
  tags: Tag[];
  actions: SelectionActions;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ id: "move" | "export"; anchor: DOMRect } | null>(null);
  /** The tag field is open above the «Тег» button, this far from the bar's left edge. */
  const [tagging, setTagging] = useState<number | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const exportEntries: MenuEntry[] = [
    { id: "html", icon: ArrowUpFromLine, label: t("more.exportHtml"), onSelect: () => actions.export("html") },
    { id: "json", icon: FileText, label: t("more.exportJson"), onSelect: () => actions.export("json") },
    { id: "csv", icon: FileSpreadsheet, label: t("more.exportCsv"), onSelect: () => actions.export("csv") },
  ];
  const moveEntries: MenuEntry[] = [
    ...collections.map((c, index) => ({
      id: `c${c.id}`,
      label: c.name,
      dot: collectionColor(c.id),
      keys: index < 9 ? String(index + 1) : undefined,
      onSelect: () => actions.move(c.id),
    })),
    ...(collections.length ? ["separator" as const] : []),
    { id: "none", label: t("card.noCollection"), onSelect: () => actions.move(null) },
    "separator",
    { id: "new", icon: Plus, label: t("selection.newCollection"), onSelect: actions.newCollection },
  ];
  /** `name` — the full name when the label on the bar is shorter. */
  type Action = { id: string; icon: LucideIcon; label: string; name?: string; keys?: string; pressed?: boolean; filled?: boolean; run: (button: HTMLElement) => void };
  const open = (id: "move" | "export") => (button: HTMLElement) =>
    setMenu(menu?.id === id ? null : { id, anchor: button.getBoundingClientRect() });
  const list: Action[] = trash
    ? [
        { id: "restore", icon: RotateCcw, label: t("trash.restore"), run: actions.restore },
        { id: "export", icon: ArrowUpFromLine, label: t("selection.export"), run: open("export") },
        { id: "delete", icon: Trash2, label: t("trash.deleteForever"), keys: "Del", run: actions.deleteForever },
      ]
    : [
        { id: "move", icon: Folder, label: t("selection.move"), run: open("move") },
        {
          id: "tag",
          icon: TagIcon,
          label: t("selection.tag"),
          pressed: tagging !== null,
          run: (button) =>
            setTagging(tagging === null ? button.getBoundingClientRect().left - bar.current!.getBoundingClientRect().left : null),
        },
        allStarred
          ? // Sheet 31: a filled star and «Из избранного», which keeps the bar 740 px wide; the name says it whole.
            { id: "favorite", icon: Star, filled: true, label: t("selection.unfavorite"), name: t("selection.unfavoriteName"), run: () => actions.favorite(false) }
          : { id: "favorite", icon: Star, label: t("selection.favorite"), run: () => actions.favorite(true) },
        { id: "export", icon: ArrowUpFromLine, label: t("selection.export"), run: open("export") },
        { id: "trash", icon: Trash2, label: t("selection.trash"), keys: "Del", run: actions.trash },
      ];
  const hint = hidden
    ? t(narrowed ? "selection.hiddenBySearch" : "selection.hiddenElsewhere", { count: hidden, total: count })
    : t(trash ? "selection.keysTrash" : "selection.keys");
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
        <span aria-hidden className="mx-3 h-[22px] w-px shrink-0 bg-[#4a4b44] dark:bg-[#55554c]" />
        {list.map((action) => {
          const button = (
            <button
              type="button"
              disabled={busy}
              aria-label={compact ? (action.name ?? action.label) : action.name}
              aria-haspopup={action.id === "move" || action.id === "export" ? "menu" : undefined}
              aria-expanded={action.id === "move" || action.id === "export" ? menu?.id === action.id : undefined}
              aria-pressed={action.pressed}
              onClick={(e) => action.run(e.currentTarget)}
              className={`flex h-8 shrink-0 items-center gap-[7px] rounded-lg px-2.5 transition-colors duration-150 hover:bg-white/10 hover:text-white disabled:text-white/45 disabled:hover:bg-transparent ${action.pressed || menu?.id === action.id ? "bg-white/10 text-white" : ""} ${compact ? "w-8 justify-center px-0" : ""}`}
            >
              <Icon icon={action.icon} size={15} fill={action.filled ? "currentColor" : "none"} />
              {!compact && action.label}
            </button>
          );
          return compact || action.keys || action.name ? (
            <Hint key={action.id} label={action.name ?? action.label} keys={action.keys} side="top">
              {button}
            </Hint>
          ) : (
            <span key={action.id} className="inline-flex">
              {button}
            </span>
          );
        })}
        <span className="min-w-2 flex-1" />
        <Hint label={t("selection.clear")} keys="Esc" side="top">
          <button
            type="button"
            aria-label={t("selection.clear")}
            onClick={onClear}
            className="flex size-[30px] shrink-0 items-center justify-center rounded-lg text-[#9a998e] transition-colors duration-150 hover:bg-white/10 hover:text-white"
          >
            <Icon icon={X} size={14} />
          </button>
        </Hint>
        {tagging !== null && (
          <TagPicker
            left={tagging}
            tags={tags}
            onAdd={(name) => {
              setTagging(null);
              actions.tag(name);
            }}
            onClose={() => setTagging(null)}
          />
        )}
      </div>
      {!compact && <p className="h-4 max-w-full truncate text-2xs leading-4 text-subtle">{hint}</p>}
      {menu && (
        <Menu
          label={menu.id === "move" ? t("selection.move") : t("selection.export")}
          anchor={menu.anchor}
          align="start"
          // «Новая коллекция из выбранного…» fits whole.
          width={menu.id === "move" ? 292 : undefined}
          entries={menu.id === "move" ? moveEntries : exportEntries}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * «Тег»: a field above the bar (as `T` in triage) with the library's tags
 * that match what is typed; arrows pick one, Enter adds it, or the typed
 * name, to every selected bookmark. Esc or leaving the field cancels.
 */
function TagPicker({ left, tags, onAdd, onClose }: { left: number; tags: Tag[]; onAdd: (name: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [active, setActive] = useState(-1);
  const typed = foldText(value.trim());
  const offered = tags.filter((tag) => !typed || foldText(tag.name).includes(typed)).slice(0, SUGGESTIONS);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = (offered[active]?.name ?? value).trim().toLowerCase();
    if (name) onAdd(name);
    else onClose();
  };
  return (
    <form
      onSubmit={submit}
      // Over the «Тег» button, like a menu over its button (frame 15).
      style={{ left: Math.max(0, left - 6) }}
      className="absolute bottom-full mb-2 w-[280px] animate-appear rounded-xl border border-border bg-card p-1.5 text-ink shadow-menu"
    >
      <input
        autoFocus
        role="combobox"
        aria-label={t("selection.tagLabel")}
        aria-expanded={offered.length > 0}
        aria-controls="selection-tags"
        aria-activedescendant={active >= 0 ? `selection-tag-${active}` : undefined}
        placeholder={t("selection.tagPlaceholder")}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setActive(-1);
        }}
        onBlur={onClose}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            // From the field (-1) through the tags and back to the field.
            setActive((i) => {
              const next = i + step;
              return next < -1 ? offered.length - 1 : next >= offered.length ? -1 : next;
            });
          }
        }}
        className="field h-8 w-full rounded-lg px-2.5 text-sm"
      />
      {offered.length > 0 && (
        <ul id="selection-tags" role="listbox" aria-label={t("selection.tagSuggestions")} className="mt-1 flex flex-col">
          {offered.map((tag, i) => (
            <li
              key={tag.id}
              id={`selection-tag-${i}`}
              role="option"
              aria-selected={i === active}
              // Keeps the field focused: a blur would close the picker first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onAdd(tag.name)}
              className={`flex h-8 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-sm hover:bg-hover ${i === active ? "bg-hover" : ""}`}
            >
              <Icon icon={TagIcon} className="text-icon" />
              <span className="min-w-0 flex-1 truncate">{tag.name}</span>
              <span className="text-2xs text-subtle">{tag.count}</span>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
