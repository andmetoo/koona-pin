import { type CSSProperties, type ReactNode, useState } from "react";
import { BookOpen, type LucideIcon, Plus, Rss } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { TABS, type Tab } from "../navigation/stack";
import { glass } from "./Glass";
import { ClipIcon, InboxTray, PhIcon } from "./icons";
import { useLongPress } from "./useLongPress";

/** Each tab's glyph and the key of its name (en.json `phone.nav.*`). */
export const TAB_ICONS: Record<Tab, LucideIcon> = { inbox: InboxTray, all: ClipIcon, reading: BookOpen, feeds: Rss };

/**
 * A place's name for screen readers: the Inbox's says how many links wait there, which its badge
 * shows to the eye ("Inbox: 7 waiting", as the desktop's sidebar says it).
 */
export const tabLabel = (t: TFunction, tab: Tab, inbox: number) =>
  tab === "inbox" && inbox > 0 ? t("nav.inboxWaiting", { count: inbox }) : t(`phone.nav.${tab}`);

/**
 * The nav pill (doc/mobile-design.md): floating chrome glass 361 × 60, five equal slots — Inbox
 * with its count, All bookmarks, Reading, Feeds — and "+" New link as an ink disc, an action that
 * looks unlike the places. The active place sits on an accent-soft pill that slides between them.
 * No labels: screen readers get the names, a long press shows them. `hidden` slides it away
 * (pushed screens, the keyboard) without unmounting it.
 */
export function NavPill({
  tab,
  inbox,
  hidden = false,
  onTab,
  onNew,
}: {
  tab: Tab;
  /** The Inbox's count; none shown at 0. */
  inbox: number;
  hidden?: boolean;
  onTab: (tab: Tab) => void;
  onNew: () => void;
}) {
  const { t } = useTranslation();
  const index = TABS.indexOf(tab);
  return (
    <nav
      aria-label={t("phone.nav.label")}
      data-navpill
      data-hidden={hidden || undefined}
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
      className={`ph-navpill ${glass()}`}
      style={{ "--index": index } as CSSProperties}
    >
      <span className="ph-navpill-active" aria-hidden="true" />
      {TABS.map((place) => (
        <Slot key={place} name={t(`phone.nav.${place}`)} label={tabLabel(t, place, inbox)} current={place === tab} onClick={() => onTab(place)}>
          <PhIcon icon={TAB_ICONS[place]} at="nav" />
          {place === "inbox" && inbox > 0 && (
            <span className="ph-badge" aria-hidden="true">
              {inbox > 99 ? "99+" : inbox}
            </span>
          )}
        </Slot>
      ))}
      <Slot name={t("phone.nav.new")} onClick={onNew}>
        <span className="ph-navpill-new">
          <PhIcon icon={Plus} at="nav" />
        </span>
      </Slot>
    </nav>
  );
}

/** `name` shows on a long press; `label` (the name by default) is what a screen reader says. */
function Slot({ name, label = name, current, onClick, children }: { name: string; label?: string; current?: boolean; onClick: () => void; children: ReactNode }) {
  const [named, setNamed] = useState(false);
  const press = useLongPress(
    () => setNamed(true),
    () => setNamed(false),
  );
  return (
    <button type="button" className="ph-navpill-slot" aria-label={label} aria-current={current ? "page" : undefined} onClick={onClick} {...press}>
      {children}
      {named && (
        <span className="ph-longpress-label" aria-hidden="true">
          {name}
        </span>
      )}
    </button>
  );
}
