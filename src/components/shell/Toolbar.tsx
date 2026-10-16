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
  Grid3x3,
  LayoutGrid,
  List,
  MoreHorizontal,
  Unlink,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { BookmarkSort, ExportFormat, ViewMode } from "../../types";
import { SORTS } from "../../services/library";
import { Icon } from "../icons";
import { Button } from "../ui/Button";
import { Hint } from "../ui/Hint";
import { SearchField } from "./SearchField";
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
  /** «Read» in the right corner (Р-69, frame R0): the reading mode drops from it. */
  onRead: () => void;
  readRef?: React.Ref<HTMLButtonElement>;
}

/** The toolbar's outlined buttons: radius 9, a 1 px line and a faint lift (2026-10-16). */
const toolButton = "rounded-[9px] border border-line shadow-button transition-colors duration-150 hover:bg-hover";

/** One row 36 px (frame 01): title and count, search (a narrow window only), order, view, «⋯», «Read»; adding is in the sidebar. */
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
  // Three views since the compact grid: a narrow window gives each a little less, so the title keeps its room.
  const viewButton = (mode: ViewMode, label: string, glyph: typeof List) => (
    <Hint label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={props.view === mode}
        onClick={() => props.onView(mode)}
        className={`flex h-7 ${props.narrow ? "w-[26px]" : "w-[30px]"} items-center justify-center rounded-[7px] transition-[background-color,color,box-shadow] duration-150 ${props.view === mode ? "bg-raised text-ink shadow-segment" : "text-subtle hover:text-ink"}`}
      >
        <Icon icon={glyph} />
      </button>
    </Hint>
  );
  return (
    <div className={`@container flex h-9 items-center ${props.narrow ? "gap-1.5" : "gap-2.5"}`}>
      {/* The title takes the free room; when the row runs short the search field gives way
          first, so much faster that the title loses not even a pixel, down to 104 px (NP-089: «Todos os marcadores» at
          800 px, with room for WebKitGTK drawing it a few pixels wider), and only then is the title cut. The buttons never shrink. */}
      <h1 className="flex min-w-0 flex-auto items-baseline gap-2">
        <span className="truncate text-2xl font-semibold">{props.title}</span>
        {props.count !== undefined && (
          <span className="shrink-0 text-md text-subtle" aria-live={props.countLive ? "polite" : undefined}>
            {props.count}
          </span>
        )}
      </h1>
      {/* One search in every window (2026-10-16): the sidebar keeps its room for «New link», feeds and collections. */}
      <SearchField
        ref={searchRef}
        well
        search={props.search}
        onSearch={props.onSearch}
        placeholder={t("toolbar.searchShort")}
        className={`ml-auto min-w-[104px] shrink-[100000] ${props.narrow ? "w-[200px]" : "w-[320px]"}`}
      />
      {sort && (
        <Hint label={t("toolbar.sortHint", { order: sortName })} show={!sortMenu}>
          <button
            ref={sortButton}
            type="button"
            aria-label={t("toolbar.sortHint", { order: sortName })}
            aria-haspopup="menu"
            aria-expanded={!!sortMenu}
            onClick={() => setSortMenu(sortMenu ? null : sortButton.current!.getBoundingClientRect())}
            className={`flex h-[34px] w-[34px] shrink-0 items-center justify-center gap-1.5 ${toolButton} text-sm text-ink ${sortMenu ? "bg-hover" : "bg-card"} ${props.narrow ? "" : `@min-[60rem]:w-auto @min-[60rem]:px-2.5`}`}
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
      <div role="group" aria-label={t("toolbar.view")} className="flex shrink-0 gap-0.5 rounded-[10px] bg-well p-[3px]">
        {viewButton("grid", t("toolbar.grid"), LayoutGrid)}
        {viewButton("dense", t("toolbar.denseGrid"), Grid3x3)}
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
          className={`flex size-[34px] shrink-0 items-center justify-center ${toolButton} text-icon hover:text-ink ${menu ? "bg-hover" : "bg-card"}`}
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
      {/* In a narrow window the word gives way to the book; the hint names it. */}
      <Hint label={t("readingMode.read")} show={props.narrow}>
        <Button
          ref={props.readRef}
          variant="outline"
          size="lg"
          data-read-mode
          onClick={props.onRead}
          aria-label={props.narrow ? t("readingMode.read") : undefined}
          className={`!rounded-[9px] !border-line bg-card text-ink shadow-button ${props.narrow ? "w-[34px] !px-0" : ""}`}
        >
          <Icon icon={BookOpen} size={15} className="shrink-0" />
          {!props.narrow && t("readingMode.read")}
        </Button>
      </Hint>
    </div>
  );
});
