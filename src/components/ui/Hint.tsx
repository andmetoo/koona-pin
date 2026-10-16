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
 * клавиши»): after 500 ms of hover, at once on keyboard focus. Without
 * `show` the wrapper stays and only the hint goes, so toggling it never
 * remounts the element inside (and never drops its focus).
 */
export function Hint({
  label,
  keys,
  children,
  side = "bottom",
  align = "center",
  show = true,
}: {
  label: string;
  keys?: string;
  children: ReactNode;
  /** `right`: beside the element, for the strip of a narrow window, where a bubble below would leave the window. */
  side?: "bottom" | "top" | "right";
  /** `end`: the bubble's right edge at the element's, for a control at the right edge of a clipped box. */
  align?: "center" | "end";
  show?: boolean;
}) {
  return (
    <span className="group/hint relative inline-flex">
      {children}
      {show && <span
        role="tooltip"
        className={`pointer-events-none absolute z-50 flex ${side === "right" ? "top-1/2 left-full ml-2 -translate-y-1/2" : `${align === "end" ? "right-0" : "left-1/2 -translate-x-1/2"} ${side === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5"}`} items-center gap-2 whitespace-nowrap rounded-md bg-toast px-2 py-1 text-xs text-white opacity-0 transition-opacity duration-150 group-hover/hint:opacity-100 group-hover/hint:delay-500 group-has-[:focus-visible]/hint:opacity-100`}
      >
        {label}
        {keys && <kbd className="rounded-xs bg-white/15 px-1.5 font-sans text-2xs">{keys}</kbd>}
      </span>}
    </span>
  );
}
