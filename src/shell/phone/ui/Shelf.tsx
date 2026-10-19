import type { ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { PhIcon } from "./icons";

/**
 * A shelf (doc/mobile-design.md, Cards and lists): one opaque paper surface per section, r 24, one
 * shadow for the group; its rows are separated by inset hairlines. `label` is the section's name
 * above it ("Today", "Settings").
 */
export function Shelf({ label, children, className = "" }: { label?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`ph-shelf-section ${className}`}>
      {label && <h2 className="ph-section-label">{label}</h2>}
      <div className="ph-shelf">{children}</div>
    </section>
  );
}

/**
 * A row on a shelf: an icon in a round well, a title with an optional second line, a detail on
 * the right and a chevron when it leads somewhere. A button with `onClick`; `children` replace the
 * text column for a row of its own (a bookmark row).
 */
export function ShelfRow({
  icon,
  title,
  subtitle,
  detail,
  chevron = false,
  trailing,
  onClick,
  children,
  className = "",
}: {
  icon?: LucideIcon;
  title?: ReactNode;
  subtitle?: ReactNode;
  detail?: ReactNode;
  chevron?: boolean;
  /** After the detail: a toggle, a checkbox. */
  trailing?: ReactNode;
  onClick?: () => void;
  children?: ReactNode;
  className?: string;
}) {
  const inner = (
    <>
      {icon && (
        <span className="ph-shelf-icon">
          <PhIcon icon={icon} at="field" />
        </span>
      )}
      {children ?? (
        <span className="ph-shelf-text">
          <span className="ph-shelf-title">{title}</span>
          {subtitle && <span className="ph-meta">{subtitle}</span>}
        </span>
      )}
      {detail && <span className="ph-shelf-detail">{detail}</span>}
      {trailing}
      {chevron && <PhIcon icon={ChevronRight} at="field" className="shrink-0 text-[var(--ph-faint)]" />}
    </>
  );
  return onClick ? (
    <button type="button" className={`ph-shelf-row ${className}`} data-inset-icon={icon ? "" : undefined} onClick={onClick}>
      {inner}
    </button>
  ) : (
    <div className={`ph-shelf-row ${className}`} data-inset-icon={icon ? "" : undefined}>
      {inner}
    </div>
  );
}
