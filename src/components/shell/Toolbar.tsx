import { forwardRef, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
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
import { ExportFormat, ViewMode } from "../../types";
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
  onSearch: (value: string) => void;
  onView: (view: ViewMode) => void;
  onImport: () => void;
  /** Menu «⋯» → Export (NP-032, frame 29). */
  onExport: (format: ExportFormat) => void;
  /** Menu «⋯» → «Резервная копия Netami Pin (JSON)» (NP-033, frame 30). */
  onRestore: () => void;
  /** Groups of duplicates (NP-035): the count of «Дубликаты» and the section. */
  duplicates: number;
  onDuplicates: () => void;
  /** Links a check found broken or moved (NP-036): the count of «Проверка ссылок» and the section. */
  links: number;
  onLinks: () => void;
  onAdd: () => void;
}

/** One row 36 px (frame 01): title and count, search, view, «⋯», «Add». */
export const Toolbar = forwardRef<HTMLInputElement, ToolbarProps>(function Toolbar(props, searchRef) {
  const { t } = useTranslation();
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<DOMRect | null>(null);
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
    <div className="flex h-9 items-center gap-2.5">
      {/* The title takes the free room and never shrinks below its own length (the automatic
          minimum of a flex item), so the search field gives way first (NP-089: «Todos os
          marcadores» at 800 px). Only a title longer than the row minus the controls at their
          smallest (440 px) is cut. */}
      <h1 className="flex max-w-[calc(100%-440px)] flex-1 items-baseline gap-2">
        <span className="truncate text-2xl font-semibold">{props.title}</span>
        {props.count !== undefined && (
          <span className="shrink-0 text-md text-subtle" aria-live={props.countLive ? "polite" : undefined}>
            {props.count}
          </span>
        )}
      </h1>
      <label className={`relative ml-auto flex h-9 min-w-[120px] items-center ${props.narrow ? "w-[200px]" : "w-[340px]"}`}>
        <Icon icon={Search} size={15} className="pointer-events-none absolute left-3 text-subtle" />
        <input
          ref={searchRef}
          value={props.search}
          onChange={(e) => props.onSearch(e.target.value)}
          onKeyDown={(e) => {
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
        <Kbd className="pointer-events-none absolute right-2">{props.search ? "Esc" : "Ctrl K"}</Kbd>
      </label>
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
    </div>
  );
});
