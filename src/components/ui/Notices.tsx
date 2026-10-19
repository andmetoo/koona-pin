import { ReactNode, useRef } from "react";
import { Check, CircleAlert } from "lucide-react";
import { Icon } from "../icons";
import { useOverDialogs } from "./overDialogs";

/** Dark notice 44 px at the bottom centre (frame «12 · Ошибки»). */
export function Toast({
  children,
  action,
  tone = "status",
  docked = false,
  glass = false,
}: {
  children: ReactNode;
  action?: ReactNode;
  tone?: "status" | "alert";
  /** In the column above the selection bar instead of the bottom of the window (frame 27). */
  docked?: boolean;
  /** Glass with a check (2026-10-16): «Saved to Design · Undo» after a link is added. */
  glass?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // At the bottom of the window it stays readable over an open dialog; docked, it sits in the column.
  const { popover, place } = useOverDialogs(ref, !docked, children);
  if (glass)
    return place(
      <div ref={ref} popover={popover} role={tone} data-glass-toast data-docked={docked || undefined} className={`glass-toast ${docked ? "max-w-full" : "fixed"}`}>
        <Icon icon={Check} size={15} strokeWidth={2.25} className="shrink-0 text-accent" />
        <span className="min-w-0">{children}</span>
        {action}
      </div>,
    );
  return place(
    <div
      ref={ref}
      popover={popover}
      role={tone}
      data-toast
      data-docked={docked || undefined}
      className={`flex min-h-11 animate-appear items-center gap-3 rounded-xl bg-toast px-4 py-2 text-sm text-white shadow-menu ${docked ? "max-w-full" : "fixed bottom-6 left-1/2 z-40 max-w-[calc(100vw-32px)] -translate-x-1/2"}`}
    >
      {tone === "alert" && <Icon icon={CircleAlert} className="shrink-0 text-[#e99797]" />}
      <span>{children}</span>
      {action}
    </div>,
  );
}

const TONES = {
  danger: "bg-danger-soft text-on-danger-soft",
  accent: "bg-accent-soft text-on-accent-soft",
  quiet: "bg-panel text-ink",
} as const;

/**
 * Plate over the content: an error, the soft accent, such as the inbox
 * banner, or the quiet panel of an offer, such as the import on a new
 * library (sheet 43).
 */
export function Banner({
  children,
  action,
  tone = "danger",
  icon,
  label,
}: {
  children: ReactNode;
  action?: ReactNode;
  tone?: "danger" | "accent" | "quiet";
  /** The accent icon on the left; an error always has the alert sign. */
  icon?: ReactNode;
  /**
   * An accent banner with a name is a region, not a live one: the inbox
   * banner would otherwise be read out again with every new link.
   */
  label?: string;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : label ? "region" : "status"}
      aria-label={label}
      className={`flex items-center justify-between gap-5 rounded-xl px-4 py-3 text-sm ${TONES[tone]}`}
    >
      <span className="flex min-w-0 items-start gap-2.5 [overflow-wrap:anywhere]">
        {tone === "danger" ? (
          <Icon icon={CircleAlert} className="mt-px shrink-0" />
        ) : (
          icon && <span className={`mt-px flex shrink-0 ${tone === "quiet" ? "text-icon" : "text-accent"}`}>{icon}</span>
        )}
        <span>{children}</span>
      </span>
      {action}
    </div>
  );
}
