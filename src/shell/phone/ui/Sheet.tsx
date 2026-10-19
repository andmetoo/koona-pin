import { createContext, type KeyboardEvent, type PointerEvent, type ReactNode, useContext, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CircleButton } from "./buttons";
import { glass } from "./Glass";

/**
 * What the sheet layer (../sheets/SheetLayer.tsx) tells the sheet it hosts: whether it is leaving,
 * how to close it (scrim, drag, the close button, Escape; Back goes through the layer), and when
 * its exit has played.
 */
export type SheetHandle = { leaving: boolean; close: () => void; exited: () => void };
export const SheetHandleContext = createContext<SheetHandle | null>(null);

/** Closes the sheet this component is in (a Cancel or Done of its own). */
export function useCloseSheet(): () => void {
  return useContext(SheetHandleContext)?.close ?? (() => {});
}

/** A drag this far down, or a quick flick, dismisses. */
const DISMISS_PX = 140;
const FLICK = 0.6;
/** A finger that moves this far is dragging, not tapping a button in the bar. */
const SLOP = 8;

/**
 * A bottom sheet (doc/mobile-design.md, Sheets): sheet glass, r 34, a grabber. `detached`: compact,
 * 8 from the edges, over a scrim (C1, N1, A1, menus). `attached`: full height for editing (B1),
 * its `bar` (Cancel · title · Save, see {@link SheetBar}) at the top so it stays above the
 * keyboard. Dragging the grabber or the top down dismisses it, as do the scrim, Escape and Back.
 * Render it from a sheet registered in ../sheets/registry.ts; `inline` draws it in place (the
 * kit gallery).
 */
export function Sheet({
  label,
  variant = "detached",
  title,
  subtitle,
  closeButton = true,
  bar,
  footer,
  children,
  className = "",
  inline = false,
}: {
  /** Its name for screen readers. */
  label: string;
  variant?: "detached" | "attached";
  /** A detached sheet's title (title2), with the close circle beside it. */
  title?: ReactNode;
  subtitle?: ReactNode;
  closeButton?: boolean;
  /** An attached sheet's top bar. */
  bar?: ReactNode;
  /** Below the scrolling body: Done, Save link. */
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
  inline?: boolean;
}) {
  const { t } = useTranslation();
  const handle = useContext(SheetHandleContext);
  const close = handle?.close ?? (() => {});
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ id: number; y: number; at: number; dy: number; dragging: boolean } | null>(null);

  // The sheet takes focus when it opens, unless something in it asked for it.
  useEffect(() => {
    const el = ref.current;
    if (!inline && el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [inline]);

  // Its exit is the transition to below the screen.
  const leaving = !!handle?.leaving;
  useEffect(() => {
    const el = ref.current;
    if (!leaving || !el || !handle) return;
    const done = (e: TransitionEvent) => e.target === el && handle.exited();
    el.addEventListener("transitionend", done);
    return () => el.removeEventListener("transitionend", done);
  }, [leaving, handle]);

  const onPointerDown = (e: PointerEvent) => {
    if (inline || e.button !== 0) return;
    drag.current = { id: e.pointerId, y: e.clientY, at: e.timeStamp, dy: 0, dragging: false };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || !el || d.id !== e.pointerId) return;
    d.dy = Math.max(0, e.clientY - d.y);
    if (!d.dragging) {
      if (d.dy < SLOP) return;
      d.dragging = true;
      // Only now: captured from the start, a tap on Cancel or Save would land on the bar.
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      el.style.transition = "none";
    }
    el.style.transform = `translateY(${d.dy}px)`;
  };
  const onPointerEnd = (e: PointerEvent) => {
    const d = drag.current;
    const el = ref.current;
    drag.current = null;
    if (!d || !el || !d.dragging) return;
    const speed = d.dy / Math.max(1, e.timeStamp - d.at);
    el.style.transition = "";
    el.style.transform = "";
    if (d.dy > Math.min(DISMISS_PX, el.offsetHeight * 0.35) || (speed > FLICK && d.dy > 24)) close();
  };
  const dragArea = { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    close();
  };

  const sheet = (
    <section
      ref={ref}
      role="dialog"
      aria-modal={!inline || undefined}
      aria-label={label}
      tabIndex={-1}
      data-sheet
      data-variant={variant}
      className={`ph-sheet ${glass("sheet")} ${className}`}
      style={inline ? { position: "relative", inset: "auto", animation: "none" } : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="ph-sheet-grab" {...dragArea}>
        <span className="ph-grabber" />
      </div>
      {bar && (
        <div className="ph-sheet-bar" {...dragArea}>
          {bar}
        </div>
      )}
      {!bar && (title || closeButton) && (
        <div className="ph-sheet-head" {...dragArea}>
          <div>
            {title && <h2 className="ph-title2">{title}</h2>}
            {subtitle && <p className="ph-meta">{subtitle}</p>}
          </div>
          {closeButton && <CircleButton icon={X} kind="clear" label={t("common.close")} onClick={close} />}
        </div>
      )}
      <div className="ph-sheet-body">{children}</div>
      {footer && <div className="ph-sheet-footer">{footer}</div>}
    </section>
  );
  if (inline) return sheet;
  return (
    <>
      <div className="ph-scrim" aria-hidden="true" onClick={close} />
      {sheet}
    </>
  );
}

/** An attached sheet's top bar: Cancel on the left, the title, the action on the right. */
export function SheetBar({ left, title, right }: { left?: ReactNode; title: ReactNode; right?: ReactNode }) {
  return (
    <>
      <span>{left}</span>
      <h2 className="ph-headline">{title}</h2>
      <span>{right}</span>
    </>
  );
}
