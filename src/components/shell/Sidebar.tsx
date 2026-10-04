import { ReactNode, useState } from "react";
import { Inbox, Link, Plus, Settings, Star, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CaptureStatus, Collection, FilterState, LibraryCounts, Tag } from "../../types";
import { collectionColor } from "../../services/collections";
import { statusColor, statusLabel } from "../../services/capture";
import { Icon, LogoMark, PinIcon } from "../icons";
import { Dot } from "../ui/Controls";

export interface SidebarProps {
  narrow: boolean;
  filters: FilterState;
  settingsOpen: boolean;
  counts: LibraryCounts;
  collections: Collection[];
  tags: Tag[];
  capture: CaptureStatus | null;
  onInbox: () => void;
  onAll: () => void;
  onFavorites: () => void;
  onCollection: (id: number) => void;
  onTag: (name: string) => void;
  onSettings: () => void;
  onConnect: () => void;
  onNewCollection: () => void;
  onDeleteCollection: (collection: Collection) => void;
}

const VISIBLE_TAGS = 6;

/** Sidebar 232 px (frame 01); a 56 px strip of icons in a narrow window (frame 16). */
export function Sidebar(props: SidebarProps) {
  const { t } = useTranslation();
  const { filters, settingsOpen, counts, collections, tags, capture, narrow } = props;
  const [allTags, setAllTags] = useState(false);
  const library = !settingsOpen;
  const inbox = library && filters.onlyInbox;
  const all = library && !filters.collectionId && !filters.onlyFavorites && !filters.onlyInbox;
  const favorites = library && filters.onlyFavorites;
  const status = { color: statusColor(capture), label: statusLabel(capture, t) };
  const soon = t("common.soon");

  if (narrow)
    return (
      <aside className="flex w-14 shrink-0 flex-col items-center gap-0.5 bg-panel py-3.5" aria-label={t("sidebar.label")}>
        <div className="mb-3 text-accent" data-tauri-drag-region>
          <LogoMark />
        </div>
        <StripButton
          label={counts.inbox > 0 ? t("nav.inboxWaiting", { count: counts.inbox }) : t("nav.inbox")}
          active={inbox}
          onClick={props.onInbox}
        >
          <span className="relative">
            <Icon icon={Inbox} />
            {counts.inbox > 0 && <span className="absolute -top-0.5 -right-1 size-1.5 rounded-full bg-accent" />}
          </span>
        </StripButton>
        <StripButton label={t("nav.all")} active={all} onClick={props.onAll}>
          <PinIcon />
        </StripButton>
        <StripButton label={t("nav.favorites")} active={favorites} onClick={props.onFavorites}>
          <Icon icon={Star} />
        </StripButton>
        <StripButton label={t("nav.trash")} disabled title={soon}>
          <Icon icon={Trash2} />
        </StripButton>
        <div className="my-2.5 h-px w-6 bg-line" />
        {collections.map((c) => (
          <StripButton
            key={c.id}
            label={c.name}
            active={library && filters.collectionId === c.id}
            onClick={() => props.onCollection(c.id)}
          >
            <Dot color={collectionColor(c.id)} />
          </StripButton>
        ))}
        <div className="flex-1" />
        <StripButton label={status.label} onClick={props.onConnect}>
          <span className="relative">
            <Icon icon={Link} />
            <span className="absolute -top-0.5 -right-1 size-1.5 rounded-full" style={{ background: status.color }} />
          </span>
        </StripButton>
        <StripButton label={t("nav.settings")} active={settingsOpen} onClick={props.onSettings}>
          <Icon icon={Settings} />
        </StripButton>
      </aside>
    );

  return (
    <aside
      className="flex w-[232px] shrink-0 flex-col gap-0.5 overflow-y-auto bg-panel px-3 py-3.5"
      aria-label={t("sidebar.label")}
    >
      <div className="flex items-center gap-2.5 px-2 pt-1.5 pb-[18px] text-accent" data-tauri-drag-region>
        <LogoMark />
        <span className="text-lg font-semibold" data-tauri-drag-region>
          netami pin
        </span>
      </div>
      <nav aria-label={t("sidebar.sections")} className="flex flex-col gap-0.5">
        <NavRow
          icon={<Icon icon={Inbox} />}
          label={t("nav.inbox")}
          badge={counts.inbox}
          active={inbox}
          onClick={props.onInbox}
        />
        <NavRow icon={<PinIcon />} label={t("nav.all")} count={counts.total} active={all} onClick={props.onAll} />
        <NavRow
          icon={<Icon icon={Star} />}
          label={t("nav.favorites")}
          count={counts.favorites}
          active={favorites}
          onClick={props.onFavorites}
        />
        <NavRow icon={<Icon icon={Trash2} />} label={t("nav.trash")} disabled title={soon} />
      </nav>

      <div className="flex items-center pt-[22px] pr-2 pb-1.5 pl-2.5">
        <h2 className="flex-1 text-2xs font-semibold text-subtle uppercase">{t("sidebar.collections")}</h2>
        <button
          type="button"
          aria-label={t("sidebar.newCollection")}
          title={t("sidebar.newCollection")}
          onClick={props.onNewCollection}
          className="flex size-5 items-center justify-center rounded-sm text-subtle hover:bg-hover hover:text-ink"
        >
          <Icon icon={Plus} size={14} />
        </button>
      </div>
      <nav aria-label={t("sidebar.collections")} className="flex flex-col gap-0.5">
        {collections.length === 0 && <p className="px-2.5 py-1 text-xs text-subtle">{t("sidebar.noCollections")}</p>}
        {collections.map((c) => (
          <div key={c.id} className="group relative">
            <NavRow
              icon={
                <span className="flex size-4 items-center justify-center">
                  <Dot color={collectionColor(c.id)} />
                </span>
              }
              label={c.name}
              count={c.count ?? 0}
              active={library && filters.collectionId === c.id}
              onClick={() => props.onCollection(c.id)}
              plain
            />
            <button
              type="button"
              aria-label={t("sidebar.deleteCollection", { name: c.name })}
              title={t("sidebar.deleteCollection", { name: c.name })}
              onClick={() => props.onDeleteCollection(c)}
              className="absolute top-[7px] right-8 flex size-4 items-center justify-center rounded-xs text-faint opacity-0 group-hover:opacity-100 hover:text-ink focus-visible:opacity-100"
            >
              <Icon icon={X} size={12} />
            </button>
          </div>
        ))}
      </nav>

      {tags.length > 0 && (
        <>
          <h2 className="pt-[22px] pr-2 pb-1.5 pl-2.5 text-2xs font-semibold text-subtle uppercase">
            {t("sidebar.tags")}
          </h2>
          <div className="flex flex-wrap gap-1.5 px-2 py-2">
            {(allTags ? tags : tags.slice(0, VISIBLE_TAGS)).map((tag) => (
              <button
                key={tag.id}
                type="button"
                aria-pressed={filters.tag === tag.name}
                onClick={() => props.onTag(tag.name)}
                className={`rounded-sm px-1.5 py-0.5 text-2xs transition-colors duration-150 ${filters.tag === tag.name ? "bg-accent-soft text-on-accent-soft" : "bg-line text-muted hover:text-ink"}`}
              >
                {tag.name}
              </button>
            ))}
            {tags.length > VISIBLE_TAGS && (
              <button
                type="button"
                onClick={() => setAllTags(!allTags)}
                className="px-1 py-0.5 text-2xs text-subtle hover:text-ink"
              >
                {allTags ? t("sidebar.fewerTags") : t("sidebar.moreTags", { count: tags.length - VISIBLE_TAGS })}
              </button>
            )}
          </div>
        </>
      )}

      <div className="flex-1" />
      <NavRow
        icon={<Icon icon={Link} />}
        label={status.label}
        title={status.label}
        onClick={props.onConnect}
        trailing={<Dot color={status.color} className="size-1.5" />}
        plain
        danger={capture?.state === "failing"}
      />
      <NavRow icon={<Icon icon={Settings} />} label={t("nav.settings")} active={settingsOpen} onClick={props.onSettings} plain />
    </aside>
  );
}

function NavRow({
  icon,
  label,
  count,
  badge,
  active = false,
  onClick,
  disabled = false,
  title,
  plain = false,
  trailing,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  /** An accent counter, shown when above zero: bookmarks waiting in the inbox. */
  badge?: number;
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  /** Regular weight: collections and the bottom items. */
  plain?: boolean;
  trailing?: ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      aria-current={active ? "page" : undefined}
      aria-disabled={disabled || undefined}
      title={title}
      className={`flex h-[30px] w-full shrink-0 items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-[background-color,color] duration-150 ${active ? "bg-card font-semibold shadow-active" : `${plain ? "" : "font-medium"} ${disabled ? "" : "hover:bg-hover"}`} ${disabled ? "text-faint" : danger ? "text-danger" : "text-ink"}`}
    >
      <span className={`flex shrink-0 ${active ? "text-accent" : disabled ? "text-faint" : "text-icon"}`}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && <span className="text-xs font-normal text-subtle">{count}</span>}
      {!!badge && (
        <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-[7px] text-2xs font-semibold text-on-accent">
          {badge}
        </span>
      )}
      {trailing}
    </button>
  );
}

function StripButton({
  label,
  children,
  active = false,
  onClick,
  disabled = false,
  title,
}: {
  label: string;
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      aria-current={active ? "page" : undefined}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      className={`flex h-8 w-9 items-center justify-center rounded-md transition-[background-color,color] duration-150 ${active ? "bg-card text-accent shadow-active" : disabled ? "text-faint" : "text-icon hover:bg-hover"}`}
    >
      {children}
    </button>
  );
}
