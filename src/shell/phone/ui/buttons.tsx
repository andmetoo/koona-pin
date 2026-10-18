import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { glass } from "./Glass";
import { PhIcon } from "./icons";

type Native = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">;

/**
 * A round icon button (40 by default, 48 to touch). `glass`: chrome glass, for buttons floating
 * over content (header, reader); `clear`: transparent with a hairline rim (a sheet's close);
 * `flat`: transparent; `well`, `accent`, `ink`: filled. Its name is `label`, read and not shown.
 */
export function CircleButton({
  icon,
  label,
  kind = "glass",
  size = 40,
  className = "",
  children,
  style,
  ...rest
}: Native & {
  icon?: LucideIcon;
  label: string;
  kind?: "glass" | "clear" | "flat" | "well" | "accent" | "ink";
  size?: number;
  /** Instead of `icon`: what the circle holds. */
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-kind={kind}
      className={`ph-circle ph-hit ${kind === "glass" ? glass() : ""} ${className}`}
      style={{ ...style, "--ph-circle": `${size}px` } as CSSProperties}
      {...rest}
    >
      {children ?? (icon && <PhIcon icon={icon} />)}
    </button>
  );
}

export type ButtonKind = "primary" | "clear" | "soft" | "ink" | "ghost";

/**
 * A pill button (doc/mobile-design.md, Buttons), flat: `primary` the one accent fill of a screen
 * (Save, Keep, Done); `clear` transparent with a hairline (Cancel, secondary); `soft` accent-soft;
 * `ink` the create action (New link); `ghost` text and icon. 52 tall, 44 `compact`.
 */
export function Button({
  kind = "clear",
  compact = false,
  block = false,
  icon,
  className = "",
  children,
  ...rest
}: Native & { kind?: ButtonKind; compact?: boolean; block?: boolean; icon?: LucideIcon; children: ReactNode }) {
  return (
    <button
      type="button"
      data-kind={kind}
      data-size={compact ? "compact" : undefined}
      data-block={block || undefined}
      className={`ph-button ${compact ? "ph-hit" : ""} ${className}`}
      {...rest}
    >
      {icon && <PhIcon icon={icon} />}
      {children}
    </button>
  );
}
