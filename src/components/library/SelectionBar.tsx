import { ArrowUpFromLine, Folder, Star, Tag, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Icon } from "../icons";
import { Hint } from "../ui/Hint";

/**
 * The dark bar 740×52 at the bottom of the content with the hint row under it
 * (frames 04 and 27). The actions arrive with NP-029; until then they are
 * shown inactive with «Появится в следующих версиях», like other items not
 * made yet. In a narrow window the bar keeps the count and icons, names go
 * to hints and the hint row hides (Р-27).
 */
export function SelectionBar({
  count,
  hidden,
  narrowed,
  compact,
  onClear,
}: {
  count: number;
  /** Selected bookmarks the list does not show; actions still include them. */
  hidden: number;
  /** Search, a tag or a site narrows the section. */
  narrowed: boolean;
  compact: boolean;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const soon = t("common.soon");
  const actions = [
    { id: "move", icon: Folder, label: t("selection.move") },
    { id: "tag", icon: Tag, label: t("selection.tag") },
    { id: "favorite", icon: Star, label: t("selection.favorite") },
    { id: "export", icon: ArrowUpFromLine, label: t("selection.export") },
    { id: "trash", icon: Trash2, label: t("selection.trash") },
  ];
  const hint = hidden
    ? t(narrowed ? "selection.hiddenBySearch" : "selection.hiddenElsewhere", { count: hidden, total: count })
    : t("selection.keys");
  return (
    <div className="flex w-full flex-col items-center gap-2">
      <div
        role="toolbar"
        aria-label={t("selection.label")}
        className={`flex h-[52px] max-w-full animate-appear items-center gap-1 rounded-2xl bg-toast py-2 pr-2 pl-4 text-sm text-[#e9e6dc] shadow-[0_10px_24px_rgb(0_0_0/0.19)] ${compact ? "" : "w-[740px]"}`}
      >
        <span role="status" className="flex shrink-0 items-center gap-1">
          <span className="rounded-sm bg-accent px-2 py-0.5 font-bold text-on-accent">{count}</span>{" "}
          <span className="font-medium">{t("selection.selected", { count })}</span>
        </span>
        <span aria-hidden className="mx-3 h-[22px] w-px shrink-0 bg-[#4a4b44] dark:bg-[#55554c]" />
        {actions.map((action) => (
          <Hint key={action.id} label={compact ? `${action.label} · ${soon}` : soon} side="top">
            <button
              type="button"
              aria-disabled="true"
              aria-label={compact ? action.label : undefined}
              className={`flex h-8 shrink-0 items-center gap-[7px] rounded-lg px-2.5 text-white/45 ${compact ? "w-8 justify-center px-0" : ""}`}
            >
              <Icon icon={action.icon} size={15} />
              {!compact && action.label}
            </button>
          </Hint>
        ))}
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
      </div>
      {!compact && <p className="h-4 max-w-full truncate text-2xs leading-4 text-subtle">{hint}</p>}
    </div>
  );
}
