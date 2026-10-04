import { ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { Icon } from "../icons";

/** Dark notice 44 px at the bottom centre (frame «12 · Ошибки»). */
export function Toast({
  children,
  action,
  tone = "status",
}: {
  children: ReactNode;
  action?: ReactNode;
  tone?: "status" | "alert";
}) {
  return (
    <div
      role={tone}
      className="fixed bottom-6 left-1/2 z-40 flex min-h-11 max-w-[calc(100vw-32px)] -translate-x-1/2 animate-appear items-center gap-3 rounded-xl bg-toast px-4 py-2 text-sm text-white shadow-menu"
    >
      {tone === "alert" && <Icon icon={CircleAlert} className="shrink-0 text-[#e99797]" />}
      <span>{children}</span>
      {action}
    </div>
  );
}

/** Plate over the content: an error, or the soft accent, such as the inbox banner. */
export function Banner({
  children,
  action,
  tone = "danger",
  icon,
  label,
}: {
  children: ReactNode;
  action?: ReactNode;
  tone?: "danger" | "accent";
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
      className={`flex items-center justify-between gap-5 rounded-xl px-4 py-3 text-sm ${tone === "danger" ? "bg-danger-soft text-on-danger-soft" : "bg-accent-soft text-on-accent-soft"}`}
    >
      <span className="flex min-w-0 items-start gap-2.5 [overflow-wrap:anywhere]">
        {tone === "danger" ? (
          <Icon icon={CircleAlert} className="mt-px shrink-0" />
        ) : (
          icon && <span className="mt-px flex shrink-0 text-accent">{icon}</span>
        )}
        <span>{children}</span>
      </span>
      {action}
    </div>
  );
}
