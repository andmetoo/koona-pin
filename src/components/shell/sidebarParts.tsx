import { useLayoutEffect, useRef, useState } from "react";

/** A drop target and whether the pointer is over it; «Корзина» is lit in the danger tint (sheet 32). */
export type Drop = { attr: string; hot: boolean; danger?: boolean };

/**
 * The ring of a target under the pointer: 1.5 px inside, so nothing around it
 * moves. A shadow, not an outline: Chromium rounds an outline to whole pixels.
 */
export const hotOutline = "shadow-[inset_0_0_0_1.5px_var(--np-accent)]";
export const dropLook = (drop: Drop) =>
  drop.danger
    ? "bg-danger-soft text-on-danger-soft shadow-[inset_0_0_0_1.5px_var(--np-danger)]"
    : `bg-accent-soft text-on-accent-soft ${hotOutline}`;

/**
 * Where a moved collection would land (sheet 41): a 2 px accent line in the
 * gap above a row or below it, with a ring at its start; `indent` puts it at
 * the level the collection would take (2.19.0, frame N3).
 */
export function LandingLine({ at, indent = 0 }: { at: "top" | "bottom"; indent?: number }) {
  return (
    <span
      aria-hidden
      data-landing
      style={{ left: 6 + indent }}
      className={`pointer-events-none absolute right-1 z-10 h-0.5 rounded-full bg-accent ${at === "top" ? "-top-[2px]" : "-bottom-[2px]"}`}
    >
      <span className="absolute -top-[3px] -left-1.5 size-2 rounded-full border-2 border-accent bg-panel" />
    </span>
  );
}

/** A row's name: one longer than the row fades out at its end (2.1.2); one that fits is left whole. */
export function FadeLabel({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => setClipped(el.scrollWidth > el.clientWidth);
    measure();
    // Inter arrives after the first paint, and a folded section opens to its width later.
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    document.fonts.ready.then(measure);
    return () => watch.disconnect();
  }, [text]);
  return (
    <span ref={ref} className="fade-end min-w-0 flex-1" data-clipped={clipped || undefined}>
      {text}
    </span>
  );
}
