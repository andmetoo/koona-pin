import { forwardRef } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BundleEntry, entryKey } from "../../services/bundle";
import { Icon } from "../icons";
import { FeedIcon } from "../feeds/FeedIcon";
import { SiteMark } from "../library/Bookmarks";

/** The fan of mini cards (K6b): −8°, 0°, 8°, the first three things in the bundle. */
const FAN = [-8, 0, 8];

function Card({ entry, angle }: { entry: BundleEntry | null; angle: number }) {
  return (
    <span
      className="bundle-card absolute bottom-0 flex h-[26px] w-[20px] items-end justify-start rounded-[4px] border border-line bg-card p-[3px] shadow-[0_1px_2px_rgb(0_0_0/0.12)]"
      style={{ transform: `rotate(${angle}deg)`, left: 7 + angle * 0.9 }}
    >
      {entry?.kind === "bookmark" ? <SiteMark b={entry.bookmark} size={10} /> : entry?.kind === "feed" ? <FeedIcon feed={entry.feed} size={10} /> : null}
    </span>
  );
}

/**
 * The bundle at rest (K6b): about 48 px of glass at the bottom right of the main area, a fan of
 * mini cards, «Bundle» and the count. Hover or focus shows × (hide it for the session). While the
 * selection is dragged it fades in, even empty or hidden, and is a drop target; over it, it widens
 * to say what the drop does and the count gives way. Motion (near, landing) is piece C's.
 */
export const Capsule = forwardRef<
  HTMLButtonElement,
  {
    count: number;
    entries: BundleEntry[];
    bottom: number;
    /** A drag is on: shown whatever the rest state, and a target. */
    dragging: boolean;
    /** The pointer is over it: the label of the drop. */
    over: string | null;
    expanded: boolean;
    panelId: string;
    onClick: () => void;
    onHide: () => void;
  }
>(function Capsule({ count, entries, bottom, dragging, over, expanded, panelId, onClick, onHide }, ref) {
  const { t } = useTranslation();
  const fan = FAN.map((angle, i) => ({ angle, entry: entries[i] ?? null })).filter((card, i) => card.entry || (i === 1 && !entries.length));
  return (
    <div
      data-bundle-capsule
      data-drop={dragging ? "bundle" : undefined}
      data-over={over ? "" : undefined}
      data-dragging={dragging || undefined}
      className="group/capsule absolute right-6 z-40 animate-[bundle-fade_120ms_linear]"
      style={{ bottom }}
    >
      <button
        ref={ref}
        type="button"
        aria-label={t("bundle.label", { count })}
        aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined}
        onClick={onClick}
        className="bundle-capsule flex h-12 items-center gap-2.5 rounded-full pr-2 pl-3 text-md font-medium text-ink"
      >
        <span aria-hidden className={`relative h-[30px] w-9 shrink-0 ${entries.length ? "" : "opacity-60"}`}>
          {fan.map(({ angle, entry }) => (
            <Card key={entry ? entryKey(entry) : "empty"} entry={entry} angle={entry ? angle : 0} />
          ))}
        </span>
        <span className={`whitespace-nowrap ${over ? "pr-2 font-semibold text-on-accent-soft" : count ? "" : "pr-2 text-muted"}`}>{over ?? t("bundle.name")}</span>
        {!over && count > 0 && (
          <span aria-hidden className="flex h-6 min-w-6 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-bold text-on-accent tabular-nums">
            {count}
          </span>
        )}
      </button>
      {!dragging && (
        <button
          type="button"
          aria-label={t("bundle.hide")}
          title={t("bundle.hide")}
          onClick={onHide}
          className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full border border-line bg-card text-icon opacity-0 shadow-[0_1px_3px_rgb(0_0_0/0.15)] transition-opacity duration-150 group-hover/capsule:opacity-100 group-focus-within/capsule:opacity-100 hover:text-ink"
        >
          <Icon icon={X} size={12} />
        </button>
      )}
    </div>
  );
});
