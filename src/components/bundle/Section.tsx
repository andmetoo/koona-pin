import { useEffect, useState } from "react";
import { Rss, Tag as TagIcon, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BundleSection, entryKey } from "../../services/bundle";
import { collectionColor } from "../../services/collections";
import { Icon } from "../icons";
import { Dot } from "../ui/Controls";
import { Row } from "./Row";

/** A section over this many rows folds to `FOLDED` and «Show N more». */
const FOLD_OVER = 8;
const FOLDED = 5;
/** A section added again flashes its header this long. */
const FLASH_MS = 400;

/**
 * A section of the panel (K7a): its icon (a collection's dot, a tag, the rss glyph), name and count
 * on a 28 px header with × on hover and focus, then its rows. The Links header is left out while
 * Links is the only section.
 */
export function Section({
  section,
  name,
  header,
  flash,
  openRow,
  onOpenRow,
  onRemove,
  onRemoveEntry,
  onUseNote,
}: {
  section: BundleSection;
  /** Links and Feeds in the interface's language; a collection's or a tag's own name. */
  name: string;
  header: boolean;
  /** Bumped when the section is added again. */
  flash: number | null;
  openRow: string | null;
  onOpenRow: (key: string | null) => void;
  onRemove: () => void;
  onRemoveEntry: (key: string) => void;
  onUseNote: (key: string, use: boolean) => void;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (flash === null) return;
    setFlashing(true);
    const timer = window.setTimeout(() => setFlashing(false), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);
  const { entries, origin } = section;
  const folded = !all && entries.length > FOLD_OVER;
  const shown = folded ? entries.slice(0, FOLDED) : entries;
  const icon =
    origin.kind === "collection" ? (
      <Dot color={collectionColor(origin.id)} />
    ) : origin.kind === "tag" ? (
      <Icon icon={TagIcon} size={12} />
    ) : origin.kind === "feeds" ? (
      <Icon icon={Rss} size={12} />
    ) : null;
  return (
    <section data-bundle-section={section.key} aria-label={name} className="flex flex-col">
      {header && (
        <h3
          data-flash={flashing || undefined}
          className={`group/head flex h-7 shrink-0 items-center gap-1.5 rounded-md pr-1 pl-2 text-2xs font-semibold tracking-[0.04em] text-icon uppercase transition-colors duration-150 ${flashing ? "bg-accent-soft" : ""}`}
        >
          {icon}
          <span className="min-w-0 flex-1 truncate">{name}</span>
          <span className="font-medium text-subtle tabular-nums">{entries.length}</span>
          <button
            type="button"
            aria-label={t("bundle.removeSection", { name })}
            title={t("bundle.removeSection", { name })}
            onClick={onRemove}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-subtle opacity-0 group-hover/head:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100"
          >
            <Icon icon={X} size={13} />
          </button>
        </h3>
      )}
      <div role="list" aria-label={name} className="flex flex-col">
        {shown.map((entry) => {
          const key = entryKey(entry);
          return (
            <Row
              key={key}
              entry={entry}
              open={openRow === key}
              onToggle={() => onOpenRow(openRow === key ? null : key)}
              onRemove={() => onRemoveEntry(key)}
              onUseNote={(use) => onUseNote(key, use)}
            />
          );
        })}
      </div>
      {folded && (
        <button type="button" onClick={() => setAll(true)} className="flex h-7 items-center self-start rounded-md px-2 text-xs font-medium text-accent hover:underline">
          {t("bundle.showMore", { count: entries.length - FOLDED })}
        </button>
      )}
    </section>
  );
}
