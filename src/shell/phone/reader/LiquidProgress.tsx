import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useId, useRef } from "react";
import { impactMedium } from "../../../platform/haptics";
import { levelPath, liquidPath, sectorPath, settled, SPRINGS, springStep, type SpringState, wobble } from "./liquid";

/** How far the finger moves before a press is a pull, not a tap. */
const SLOP = 6;

export type LiquidProgressProps = {
  /** The pie in the reader's pill (phones, the Fold), or the drop in iPhone Duo's column (DO2). */
  variant: "pie" | "drop";
  /** How much is read, 0…1. */
  progress: number;
  /** Its name and its value for screen readers: "Read so far", "34 % read, 6 minutes left". */
  label: string;
  value: string;
  /** "Mark as finished" where pulling it up finishes (the bookmark is in Reading); null: progress only. */
  finishLabel: string | null;
  /** Finished in this reader: the check instead of the progress. */
  finished: boolean;
  /** Pulled past the threshold, or the screen reader's action. */
  onFinish: () => void;
  /** A tap: ask first ("Mark as finished?"). */
  onAsk: () => void;
  /** How far up the pull snaps, in CSS pixels (~80 in the pill, ~120 in the column). */
  threshold: number;
  /** Above the drop: "6 min left", "Finished". */
  caption?: string;
};

/** Reduce Motion, read once and kept up to date: not a media query per frame. */
let still = false;
if (typeof window !== "undefined" && window.matchMedia) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  still = query.matches;
  query.addEventListener?.("change", (e) => {
    still = e.matches;
  });
}
const reducedMotion = () => still;

/**
 * The reading progress as liquid (the progress board and DO2's motion note): at rest a pie's sector
 * or a drop's fill level that settles with a soft slosh when it changes; pulled up, it follows the
 * finger with a little lag, stretches out and its neck thins; past the threshold it snaps with a
 * haptic, a droplet recoils into the base, which wobbles once, and the reading is finished; let go
 * early, it springs back with one slight wobble and nothing changes. A tap asks first. Screen
 * readers get the value and a "Mark as finished" button. Reduce Motion: the plain fill and a
 * cross-fade, no stretch or wobble. Everything moves by transforms and one small path per frame.
 */
export function LiquidProgress({ variant, progress, label, value, finishLabel, finished, onFinish, onAsk, threshold, caption }: LiquidProgressProps) {
  const pie = variant === "pie";
  // The pie is 26 pt (R1, FC3); the drop 52 (DO2).
  const base = pie ? 7 : 14;
  const top = pie ? 13 : 20;
  const host = useRef<HTMLDivElement>(null);
  const liquid = useRef<SVGPathElement>(null);
  const lifted = useRef<SVGGElement>(null);
  const fill = useRef<SVGPathElement>(null);
  const droplet = useRef<SVGCircleElement>(null);
  const body = useRef<SVGGElement>(null);
  const clip = useId().replace(/:/g, "");

  // What moves: the pull (h), the level, the snap's droplet and the wobble's clock.
  const m = useRef({
    h: { x: 0, v: 0 } as SpringState,
    target: 0,
    level: { x: progress, v: 0 } as SpringState,
    levelTarget: progress,
    pointer: null as null | { id: number; x: number; y: number; pulling: boolean },
    snapped: false,
    snapH: 0,
    snapAt: 0,
    wobbleAt: 0,
    frame: 0,
    last: 0,
  });
  const can = finishLabel !== null && !finished;
  const canRef = useRef(can);
  canRef.current = can;
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;

  const draw = useCallback(() => {
    const s = m.current;
    const reduced = reducedMotion();
    const h = reduced ? 0 : Math.max(0, s.h.x);
    liquid.current?.setAttribute("d", s.snapped ? "" : liquidPath(base, top, h, threshold));
    lifted.current?.setAttribute("transform", `translate(0 ${-h})`);
    if (lifted.current && !pie) lifted.current.style.opacity = String(Math.min(1, h / 24));
    const level = reduced ? s.levelTarget : s.level.x;
    if (pie) fill.current?.setAttribute("d", sectorPath(0, 0, 11.25, level));
    else fill.current?.setAttribute("d", levelPath(25, level, s.level.v * -0.6));
    const now = performance.now();
    const since = (now - s.wobbleAt) / 1000;
    const scale = reduced || !s.wobbleAt ? 1 : wobble(since);
    body.current?.setAttribute("transform", `scale(${(2 - scale).toFixed(3)} ${scale.toFixed(3)})`);
    if (droplet.current) {
      const t = s.snapAt ? (now - s.snapAt) / 320 : 1;
      const on = !reduced && t < 1;
      droplet.current.style.opacity = on ? String(1 - t * 0.6) : "0";
      if (on) droplet.current.setAttribute("cy", String(-(s.snapH / 2) * (1 - t * t)));
    }
  }, [base, top, pie, threshold]);

  const tick = useCallback(
    (time: number) => {
      const s = m.current;
      const dt = s.last ? (time - s.last) / 1000 : 1 / 60;
      s.last = time;
      s.h = springStep(s.h, s.target, s.pointer?.pulling ? SPRINGS.follow : SPRINGS.back, dt);
      s.level = springStep(s.level, s.levelTarget, SPRINGS.slosh, dt);
      draw();
      // A finger resting still needs no frames: the next move starts them again.
      const busy =
        !settled(s.h, s.target, 0.2) ||
        !settled(s.level, s.levelTarget, 0.002) ||
        (s.wobbleAt && time - s.wobbleAt < 900) ||
        (s.snapAt && time - s.snapAt < 400);
      s.frame = busy ? requestAnimationFrame(tick) : 0;
      if (!busy) s.last = 0;
    },
    [draw],
  );
  const run = useCallback(() => {
    const s = m.current;
    if (!s.frame) s.frame = requestAnimationFrame(tick);
  }, [tick]);

  // A new progress settles like liquid.
  useEffect(() => {
    m.current.levelTarget = finished ? 1 : progress;
    run();
  }, [progress, finished, run]);
  useEffect(() => {
    draw();
    const s = m.current;
    return () => {
      cancelAnimationFrame(s.frame);
      s.frame = 0;
      s.last = 0;
    };
  }, [draw]);

  const snap = () => {
    const s = m.current;
    s.snapped = true;
    s.snapH = Math.max(0, s.h.x);
    s.snapAt = performance.now();
    s.wobbleAt = s.snapAt;
    s.target = 0;
    s.pointer = s.pointer && { ...s.pointer, pulling: false };
    void impactMedium();
    finishRef.current();
    run();
  };

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    m.current.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, pulling: false };
    m.current.snapped = false;
    host.current?.setPointerCapture?.(e.pointerId);
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = m.current;
    const p = s.pointer;
    if (!p || p.id !== e.pointerId || s.snapped || !canRef.current) return;
    const up = p.y - e.clientY;
    if (!p.pulling) {
      if (up < SLOP || up < Math.abs(e.clientX - p.x)) return;
      p.pulling = true;
    }
    // Beyond the threshold the finger has to mean it: a little resistance on the way.
    s.target = up < threshold ? up : threshold + (up - threshold) * 0.3;
    if (up >= threshold) snap();
    else run();
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = m.current;
    const p = s.pointer;
    if (!p || p.id !== e.pointerId) return;
    s.pointer = null;
    const moved = Math.hypot(e.clientX - p.x, e.clientY - p.y);
    if (!p.pulling && !s.snapped && moved < SLOP && canRef.current) onAsk();
    if (p.pulling && !s.snapped) {
      // Early release: back to rest with one slight wobble, nothing changes.
      s.target = 0;
      s.wobbleAt = performance.now();
    }
    run();
  };
  const cancel = () => {
    const s = m.current;
    if (!s.pointer) return;
    s.pointer = null;
    s.target = 0;
    run();
  };

  const handlers = { onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: cancel };
  const percent = Math.round(progress * 100);

  if (pie)
    return (
      <div className="lq lq-pie" data-finished={finished || undefined} data-can={can || undefined}>
        <div
          ref={host}
          className="lq-host ph-hit"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={finished ? 100 : percent}
          aria-valuetext={value}
          data-reading-progress
          {...handlers}
        >
          <svg className="lq-svg" viewBox="-16 -16 32 32" width="32" height="32" aria-hidden="true">
            <path ref={liquid} className="lq-liquid" />
            <circle ref={droplet} className="lq-droplet" r="2.2" cx="0" cy="0" />
            <g ref={lifted}>
              <g ref={body}>
                <circle className="lq-track" r="12.25" />
                <path ref={fill} className="lq-sector" />
                <g className="lq-check">
                  <circle r="13" />
                  <path d="M-5.4 0.4 L-1.6 4.2 L5.6 -3.8" />
                </g>
              </g>
            </g>
          </svg>
        </div>
        {can && finishLabel && (
          <button type="button" className="sr-only" onClick={onFinish}>
            {finishLabel}
          </button>
        )}
      </div>
    );

  return (
    <div className="lq lq-drop" data-finished={finished || undefined} data-can={can || undefined}>
      {caption && (
        <span className="lq-caption" aria-hidden="true">
          {caption}
        </span>
      )}
      <div
        ref={host}
        className="lq-host lq-drop-body ph-glass"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={finished ? 100 : percent}
        aria-valuetext={value}
        data-reading-progress
        {...handlers}
      >
        <svg className="lq-svg" viewBox="-26 -26 52 52" width="52" height="52" aria-hidden="true">
          <defs>
            <clipPath id={clip}>
              <circle r="25" />
            </clipPath>
          </defs>
          <g ref={body}>
            <path ref={fill} className="lq-level" clipPath={`url(#${clip})`} />
            <rect className="lq-grip" x="-10" y="-18" width="20" height="3" rx="1.5" />
            <g className="lq-check">
              <circle r="15" />
              <path d="M-5.6 0.4 L-1.8 4.2 L5.8 -3.8" />
            </g>
          </g>
          <path ref={liquid} className="lq-liquid" transform="translate(0 -12)" />
          <circle ref={droplet} className="lq-droplet" r="3" cx="0" cy="0" transform="translate(0 -12)" />
          <g ref={lifted} className="lq-lifted" style={{ opacity: 0 }}>
            <circle className="lq-top" r={top} cy="-12" />
          </g>
        </svg>
      </div>
      {can && finishLabel && (
        <button type="button" className="sr-only" onClick={onFinish}>
          {finishLabel}
        </button>
      )}
    </div>
  );
}
