import { forwardRef, useRef, useState } from "react";
import {
  BookOpen,
  ArrowDownToLine,
  ArrowDownWideNarrow,
  ArrowUpFromLine,
  ChevronDown,
  Copy,
  FileJson,
  FileSpreadsheet,
  FileText,
  LayoutGrid,
  List,
  MoreHorizontal,
  Plus,
  Search,
  Unlink,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { composing } from "../../services/ime";
import { BookmarkSort, ExportFormat, ViewMode } from "../../types";
import { SORTS } from "../../services/library";
import { Icon } from "../icons";
import { Button } from "../ui/Button";
import { Hint, Kbd } from "../ui/Hint";
import { Menu } from "../ui/Menu";

export interface ToolbarProps {
  title: string;
  /** The section size, or «N из M» while search, a tag or a site narrows it. */
  count?: number | string;
  /** Announce count changes: they are search results. */
  countLive?: boolean;
  narrow: boolean;
  search: string;
  view: ViewMode;
  /** The list's order (NP-114, sheet 41); none in the trash, which keeps its own. */
  sort: BookmarkSort | null;
  onSearch: (value: string) => void;
  onView: (view: ViewMode) => void;
  onSort: (sort: BookmarkSort) => void;
  onImport: () => void;
  /** Menu «⋯» → Export (NP-032, frame 29). */
  onExport: (format: ExportFormat) => void;
  /** Menu «⋯» → «Резервная копия Koona Pin (JSON)» (NP-033, frame 30). */
  onRestore: () => void;
  /** Groups of duplicates (NP-035): the count of «Дубликаты» and the section. */
  duplicates: number;
  onDuplicates: () => void;
  /** Links a check found broken or moved (NP-036): the count of «Проверка ссылок» and the section. */
  links: number;
  onLinks: () => void;
  onAdd: () => void;
  /** «Read» in the right corner (Р-69, frame R0): the reading mode drops from it. */
  onRead: () => void;
  readRef?: React.Ref<HTMLButtonElement>;
}

/** One row 36 px (frame 01): title and count, search, order, view, «⋯», «Add». */
export const Toolbar = forwardRef<HTMLInputElement, ToolbarProps>(function Toolbar(props, searchRef) {
  const { t } = useTranslation();
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const sortButton = useRef<HTMLButtonElement>(null);
  const [sortMenu, setSortMenu] = useState<DOMRect | null>(null);
  const { sort } = props;
  const sortName = sort && t(`sort.${sort}`);
  // The order button names the order from a toolbar of 60rem (sheet 41, the
  // `@min-[60rem]` classes below): the longest name and the longest title of a
  // section fit there in every language. Narrower, and in a narrow window, it
  // is an icon and the hint names the order.
  // What an IME is still building (NP-090): the field shows it, the list
  // waits for the finished character. `from` is the query it started on: a
  // query changed meanwhile from outside («Clear search», Esc on the window)
  // wins, and the end of the composition does not bring the old text back.
  const [composition, setComposition] = useState<{ text: string; from: string } | null>(null);
  const composed = composition && composition.from === props.search ? composition.text : null;
  const viewButton = (mode: ViewMode, label: string, glyph: typeof List) => (
    <Hint label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={props.view === mode}
        onClick={() => props.onView(mode)}
        className={`flex h-[30px] w-8 items-center justify-center rounded-lg transition-[background-color,color] duration-150 ${props.view === mode ? "bg-card text-ink shadow-active" : "text-subtle hover:text-ink"}`}
      >
        <Icon icon={glyph} />
      </button>
    </Hint>
  );
  return (
    <div className={`@container flex h-9 items-center ${props.narrow ? "gap-1.5" : "gap-2.5"}`}>
      {/* The title takes the free room; when the row runs short the search field gives way
          first, so much faster that the title loses not even a pixel, down to 120 px (NP-089: «Todos os marcadores» at
          800 px), and only then is the title cut. The buttons never shrink. */}
      <h1 className="flex min-w-0 flex-auto items-baseline gap-2">
        <span className="truncate text-2xl font-semibold">{props.title}</span>
        {props.count !== undefined && (
          <span className="shrink-0 text-md text-subtle" aria-live={props.countLive ? "polite" : undefined}>
            {props.count}
          </span>
        )}
      </h1>
      <label className={`relative ml-auto flex h-9 min-w-[120px] shrink-[100000] items-center ${props.narrow ? "w-[200px]" : "w-[340px]"}`}>
        <Icon icon={Search} size={15} className="pointer-events-none absolute left-3 text-subtle" />
        <input
          ref={searchRef}
          value={composed ?? props.search}
          onChange={(e) =>
            composed !== null || (e.nativeEvent as InputEvent).isComposing
              ? setComposition({ text: e.target.value, from: props.search })
              : props.onSearch(e.target.value)
          }
          onCompositionStart={(e) => setComposition({ text: e.currentTarget.value, from: props.search })}
          onCompositionEnd={(e) => {
            setComposition(null);
            if (composed !== null) props.onSearch(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            // Esc inside an IME cancels the character, not the query.
            if (composing(e)) return;
            // Esc clears the query first (frame 09); an empty field lets it close layers.
            if (e.key === "Escape" && props.search) {
              e.preventDefault();
              e.stopPropagation();
              props.onSearch("");
            }
          }}
          aria-label={t("toolbar.searchLabel")}
          placeholder={props.narrow ? t("toolbar.searchShort") : t("toolbar.searchPlaceholder")}
          className="field h-9 pr-12 pl-[35px]"
        />
        {/* Esc also takes back a character the IME is composing: the field is not empty then either. */}
        <Kbd className="pointer-events-none absolute right-2">{(composed ?? props.search) ? "Esc" : "Ctrl K"}</Kbd>
      </label>
      {sort && (
        <Hint label={t("toolbar.sortHint", { order: sortName })} show={!sortMenu}>
          <button
            ref={sortButton}
            type="button"
            aria-label={t("toolbar.sortHint", { order: sortName })}
            aria-haspopup="menu"
            aria-expanded={!!sortMenu}
            onClick={() => setSortMenu(sortMenu ? null : sortButton.current!.getBoundingClientRect())}
            className={`flex h-[34px] w-[34px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border text-sm text-ink transition-colors duration-150 hover:bg-hover ${sortMenu ? "bg-hover" : ""} ${props.narrow ? "" : `@min-[60rem]:w-auto @min-[60rem]:px-2.5`}`}
          >
            <Icon icon={ArrowDownWideNarrow} className="shrink-0 text-icon" />
            {!props.narrow && (
              <>
                <span className={`hidden max-w-[180px] truncate @min-[60rem]:inline`}>{sortName}</span>
                <Icon icon={ChevronDown} size={12} className={`hidden shrink-0 text-subtle @min-[60rem]:block`} />
              </>
            )}
          </button>
        </Hint>
      )}
      {sort && sortMenu && (
        <Menu
          label={t("toolbar.sortBy")}
          anchor={sortMenu}
          width={200}
          trigger={sortButton.current}
          onClose={() => setSortMenu(null)}
          entries={[
            { heading: t("toolbar.sortBy") },
            ...SORTS.map((order) => ({
              id: `sort-${order}`,
              label: t(`sort.${order}`),
              checked: order === sort,
              radio: true,
              onSelect: () => props.onSort(order),
            })),
          ]}
        />
      )}
      <div role="group" aria-label={t("toolbar.view")} className="flex gap-0.5 rounded-lg bg-secondary p-[3px]">
        {viewButton("grid", t("toolbar.grid"), LayoutGrid)}
        {viewButton("list", t("toolbar.list"), List)}
      </div>
      <Hint label={t("toolbar.more")}>
        <button
          ref={more}
          type="button"
          aria-label={t("toolbar.more")}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          onClick={() => setMenu(menu ? null : more.current!.getBoundingClientRect())}
          className="flex size-[34px] items-center justify-center rounded-lg border border-border text-icon transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          <Icon icon={MoreHorizontal} />
        </button>
      </Hint>
      {menu && (
        <Menu
          label={t("toolbar.more")}
          anchor={menu}
          width={264}
          onClose={() => setMenu(null)}
          entries={[
            { heading: t("more.import") },
            {
              id: "import-html",
              icon: ArrowDownToLine,
              label: t("more.importHtml"),
              description: t("more.importHtmlHint"),
              onSelect: props.onImport,
            },
            { id: "import-json", icon: FileJson, label: t("more.importJson"), onSelect: props.onRestore },
            "separator",
            { heading: t("more.export") },
            { id: "export-html", icon: ArrowUpFromLine, label: t("more.exportHtml"), onSelect: () => props.onExport("html") },
            { id: "export-json", icon: FileText, label: t("more.exportJson"), onSelect: () => props.onExport("json") },
            { id: "export-csv", icon: FileSpreadsheet, label: t("more.exportCsv"), onSelect: () => props.onExport("csv") },
            "separator",
            { heading: t("more.cleanUp") },
            { id: "duplicates", icon: Copy, label: t("more.duplicates"), count: props.duplicates || undefined, onSelect: props.onDuplicates },
            { id: "links", icon: Unlink, label: t("more.links"), count: props.links || undefined, onSelect: props.onLinks },
          ]}
        />
      )}
      <Button variant="primary" size="lg" onClick={props.onAdd} aria-label={t("toolbar.add")}>
        <Icon icon={Plus} size={14} strokeWidth={2} absoluteStrokeWidth />
        {t("toolbar.addShort")}
      </Button>
      {/* In a narrow window the word gives way to the book; the hint names it. */}
      <Hint label={t("readingMode.read")} show={props.narrow}>
        <Button
          ref={props.readRef}
          variant="outline"
          size="lg"
          data-read-mode
          onClick={props.onRead}
          aria-label={props.narrow ? t("readingMode.read") : undefined}
          className={`rounded-lg text-ink ${props.narrow ? "w-[34px] !px-0" : ""}`}
        >
          <Icon icon={BookOpen} size={15} className="shrink-0" />
          {!props.narrow && t("readingMode.read")}
        </Button>
      </Hint>
    </div>
  );
});
