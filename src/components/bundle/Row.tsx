import { KeyboardEvent } from "react";
import { KeyRound, StickyNote, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BundleEntry } from "../../services/bundle";
import { feedName } from "../../services/feeds";
import { hostOf, mayHoldKey } from "../../services/listText";
import { isDeleteKey } from "../../services/keys";
import { Icon } from "../icons";
import { FeedIcon } from "../feeds/FeedIcon";
import { SiteMark } from "../library/Bookmarks";

const titleOf = (entry: BundleEntry) =>
  entry.kind === "bookmark" ? entry.bookmark.title || hostOf(entry.bookmark.url) : feedName(entry.feed);

/** The address and, for a feed, its site: either may hold a key. */
const holdsKey = (entry: BundleEntry) =>
  entry.kind === "bookmark" ? mayHoldKey(entry.bookmark.url) : mayHoldKey(entry.feed.url) || mayHoldKey(entry.feed.site_url ?? undefined);

/**
 * One line of the panel (K7a): 32 px, the site's icon and the title. A click or Enter opens this one
 * row: the description (two lines), the tags as text and «Add my note» when there is a note; an
 * address that may hold a key says so with «Remove». Delete removes the focused row.
 */
export function Row({
  entry,
  open,
  onToggle,
  onRemove,
  onUseNote,
}: {
  entry: BundleEntry;
  open: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onUseNote: (use: boolean) => void;
}) {
  const { t } = useTranslation();
  const title = titleOf(entry);
  const key = holdsKey(entry);
  const b = entry.kind === "bookmark" ? entry.bookmark : null;
  const note = b?.notes?.trim() ?? "";
  // The note takes the description's place once added, as the file will hold it.
  const description =
    entry.kind === "bookmark" ? (entry.useNote && note ? note : (entry.bookmark.description ?? "")) : hostOf(entry.feed.site_url ?? entry.feed.url);
  const keys = (e: KeyboardEvent) => {
    if (!isDeleteKey(e)) return;
    e.preventDefault();
    e.stopPropagation();
    onRemove();
  };
  return (
    <div role="listitem" data-bundle-row className={`group/row relative rounded-lg ${open ? "bg-hover" : ""}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={keys}
        className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg pr-8 pl-2 text-left text-sm text-ink hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        {b ? <SiteMark b={b} size={16} /> : entry.kind === "feed" && <FeedIcon feed={entry.feed} size={16} />}
        <span className={`min-w-0 flex-1 truncate ${open ? "font-medium" : ""}`}>{title}</span>
        {note && !open && (
          <span role="img" aria-label={t("bundle.hasNote")} className="shrink-0 text-subtle">
            <Icon icon={StickyNote} size={14} />
          </span>
        )}
        {key && (
          <span role="img" data-bundle-key aria-label={t("bundle.mayHoldKey")} className="shrink-0 text-ochre">
            <Icon icon={KeyRound} size={14} />
          </span>
        )}
      </button>
      <button
        type="button"
        aria-label={t("bundle.removeItem", { name: title })}
        title={t("bundle.removeItem", { name: title })}
        onClick={onRemove}
        className={`absolute top-1 right-1 flex size-6 items-center justify-center rounded-md text-subtle hover:bg-hover hover:text-ink focus-visible:opacity-100 ${open ? "" : "opacity-0 group-hover/row:opacity-100"}`}
      >
        <Icon icon={X} size={13} />
      </button>
      {open && (
        <div className="flex flex-col gap-1 px-2 pb-2 pl-8 text-xs">
          {description && <p className="line-clamp-2 text-meta [overflow-wrap:anywhere]">{description}</p>}
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-subtle">{b?.tags?.length ? b.tags.join(", ") : ""}</span>
            {entry.kind === "bookmark" && note && (
              <button type="button" onClick={() => onUseNote(!entry.useNote)} className="shrink-0 font-medium text-accent hover:underline">
                {entry.useNote ? t("bundle.removeNote") : t("bundle.addNote")}
              </button>
            )}
          </div>
          {key && (
            <p className="flex items-center gap-1 text-ochre">
              <Icon icon={KeyRound} size={12} className="shrink-0" />
              <span>{t("bundle.mayHoldKey")}</span>
              <span aria-hidden>·</span>
              <button type="button" onClick={onRemove} className="font-medium hover:underline">
                {t("bundle.remove")}
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
