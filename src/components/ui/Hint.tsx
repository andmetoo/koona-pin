import { ReactNode } from "react";

export function Kbd({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={`rounded-xs bg-secondary px-1.5 py-px font-sans text-2xs text-subtle ${className}`}>
      {children}
    </kbd>
  );
}

/**
 * A dark hint under the element with an optional key (frame «13 · Фокус и
 * клавиши»): after 500 ms of hover, at once on keyboard focus.
 */
export function Hint({
  label,
  keys,
  children,
  side = "bottom",
}: {
  label: string;
  keys?: string;
  children: ReactNode;
  side?: "bottom" | "top";
}) {
  return (
    <span className="group/hint relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-md bg-toast px-2 py-1 text-xs text-white opacity-0 transition-opacity duration-150 group-hover/hint:opacity-100 group-hover/hint:delay-500 group-has-[:focus-visible]/hint:opacity-100 ${side === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5"}`}
      >
        {label}
        {keys && <kbd className="rounded-xs bg-white/15 px-1.5 font-sans text-2xs">{keys}</kbd>}
      </span>
    </span>
  );
}
