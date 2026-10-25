import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Minus, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ViewerSource } from "../../services/articlePictures";
import { clampView, FITTED, fitSize, maxScale, type Point, type Size, swipeCloses, type View, viewOver, zoomAt } from "../../services/pictureZoom";
import { useBack } from "../../platform/useBack";
import { Icon } from "../icons";

/**
 * A picture of the article over the whole window (frame «picture», #400): it lifts from its place
 * in the text, zooms by the wheel, a pinch, a double click or + and −, pans by dragging, and goes
 * back into its place on Escape, Back, a click beside it, the close button or a swipe down. A
 * modal <dialog>, so it stands over the reading sheet (itself one), keeps the focus, and every
 * page's keys stand down while it is open (`dialog[open]`).
 */
export function PictureViewer({ img, source, caption, onOpen, onClose }: {
  /** The picture in the article: where the viewer lifts from and goes back to. */
  img: HTMLImageElement;
  source: ViewerSource;
  caption: string | null;
  onOpen: (url: string) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [window_, setWindow] = useState<Size>(() => windowSize());
  const [natural, setNatural] = useState<Size>(() => ({ width: img.naturalWidth, height: img.naturalHeight }));
  const [src, setSrc] = useState(source.shown);
  // The fit is as large as the large picture will be, so it does not jump when that arrives.
  const cap = Math.max(natural.width, source.largeWidth ?? 0);
  const { room, centre } = layoutFor(window_, !!caption);
  const fit = useMemo(() => fitSize(natural, room, cap), [natural.width, natural.height, room.width, room.height, cap]);
  const max = maxScale(fit, cap);
  const [view, setView] = useState<View>(() => viewOver(img.getBoundingClientRect(), fit, centre));
  /** How the next change moves: `glide` for a lift, a button or a key; `none` while a finger or the wheel leads. */
  const [motion, setMotion] = useState<"glide" | "quick" | "none">("none");
  const [shade, setShade] = useState(0);
  const [chrome, setChrome] = useState(true);
  const closing = useRef(false);
  const reduce = useMemo(() => matchMedia("(prefers-reduced-motion: reduce)").matches, []);

  const latest = useRef({ view, fit, window_, max, centre });
  latest.current = { view, fit, window_, max, centre };

  // Open: in the top layer, lifted from the article's picture to the fit on the next frame.
  useLayoutEffect(() => {
    const element = dialog.current!;
    const before = document.activeElement as HTMLElement | null;
    element.showModal();
    img.style.visibility = "hidden";
    const frame = requestAnimationFrame(() => {
      setMotion(reduce ? "quick" : "glide");
      setView(FITTED);
      setShade(1);
    });
    return () => {
      cancelAnimationFrame(frame);
      img.style.visibility = "";
      if (element.open) element.close();
      before?.focus({ preventScroll: true });
    };
  }, []);

  // The large picture behind the shown one; it replaces it once loaded.
  useEffect(() => {
    if (!source.large) return;
    const large = new Image();
    large.referrerPolicy = "no-referrer";
    large.decoding = "async";
    large.onload = () => {
      if (closing.current || !large.naturalWidth) return;
      setNatural({ width: large.naturalWidth, height: large.naturalHeight });
      setSrc(large.src);
    };
    large.src = source.large;
    return () => {
      large.onload = null;
    };
  }, [source.large]);

  useEffect(() => {
    const resize = () => setWindow(windowSize());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  // A new window or a larger picture keeps the view inside the bounds (not the lift's first frame).
  const lifted = useRef(false);
  useEffect(() => {
    if (!lifted.current) {
      lifted.current = true;
      return;
    }
    setView((v) => (closing.current ? v : clampView(v, fit, window_, max, centre)));
  }, [fit.width, fit.height, window_.width, window_.height]);

  const close = () => {
    if (closing.current) return;
    closing.current = true;
    const rect = img.getBoundingClientRect();
    const visible = rect.width > 0 && rect.bottom > 0 && rect.top < window_.height;
    setMotion(reduce ? "quick" : "glide");
    setShade(0);
    setChrome(false);
    // Back into its place when it is still on screen; otherwise it fades where it is.
    setView(visible ? viewOver(rect, fit, centre) : { ...latest.current.view, scale: latest.current.view.scale * 0.94 });
    window.setTimeout(onClose, reduce ? 140 : 300);
  };
  useBack(close);

  const zoomTo = (scale: number, at: Point = { x: 0, y: 0 }, how: "glide" | "quick" | "none" = "glide") => {
    const s = latest.current;
    setMotion(how);
    setView(zoomAt(s.view, scale, at, s.fit, s.window_, s.max, s.centre));
  };
  const step = (factor: number) => zoomTo(latest.current.view.scale * factor);
  const fromCentre = (e: { clientX: number; clientY: number }): Point => ({ x: e.clientX - centre.x, y: e.clientY - centre.y });

  // The wheel: a pinch on a trackpad (ctrl) or a mouse's notch zooms at the pointer; a trackpad's
  // two-finger scroll pans a zoomed picture. Not passive, so the page under it does not scroll.
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = stage.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (closing.current) return;
      const s = latest.current;
      const at = { x: e.clientX - s.centre.x, y: e.clientY - s.centre.y };
      const notch = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
      if (e.ctrlKey) zoomTo(s.view.scale * Math.exp(-e.deltaY * 0.01), at, "none");
      else if (notch) zoomTo(s.view.scale * (e.deltaY < 0 ? 1.25 : 0.8), at, "quick");
      else if (s.view.scale > 1) {
        setMotion("none");
        setView(clampView({ ...s.view, x: s.view.x - e.deltaX, y: s.view.y - e.deltaY }, s.fit, s.window_, s.max, s.centre));
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  // Pointers: one drags a zoomed picture, or swipes an unzoomed one down (touch) to close; two pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ view: View; distance: number; mid: { x: number; y: number }; start: { x: number; y: number; at: number }; moved: boolean } | null>(null);
  /** Whether the pointer went down on the picture: once captured, its events all come from the stage. */
  const downOnPicture = useRef(false);
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);
  /** A finger's single tap shows or hides the buttons, once it is clear no second tap follows. */
  const chromeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(chromeTimer.current), []);

  const begin = () => {
    const points = [...pointers.current.values()];
    const mid = points.length === 2 ? { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 } : points[0];
    const distance = points.length === 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;
    gesture.current = { view: latest.current.view, distance, mid, start: { ...mid, at: performance.now() }, moved: gesture.current?.moved ?? false };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (closing.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    if ((e.target as HTMLElement).closest("button")) return;
    if (pointers.current.size === 0) downOnPicture.current = !!(e.target as HTMLElement).closest("[data-viewer-picture]");
    try {
      stage.current!.setPointerCapture(e.pointerId);
    } catch {
      // A pointer the browser no longer tracks: the gesture goes on without the capture.
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture.current = null;
    begin();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const s = latest.current;
    const points = [...pointers.current.values()];
    if (points.length === 2) {
      const mid = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      const at = { x: g.mid.x - s.centre.x, y: g.mid.y - s.centre.y };
      const zoomed = zoomAt(g.view, g.view.scale * (distance / Math.max(1, g.distance)), at, s.fit, s.window_, s.max, s.centre);
      g.moved = true;
      setMotion("none");
      setView(clampView({ ...zoomed, x: zoomed.x + mid.x - g.mid.x, y: zoomed.y + mid.y - g.mid.y }, s.fit, s.window_, s.max, s.centre));
      return;
    }
    const dx = e.clientX - g.mid.x;
    const dy = e.clientY - g.mid.y;
    if (!g.moved && Math.hypot(dx, dy) < 6) return;
    g.moved = true;
    setMotion("none");
    if (g.view.scale > 1) setView(clampView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy }, s.fit, s.window_, s.max, s.centre));
    else if (e.pointerType !== "mouse") {
      // The swipe that closes: the picture follows the finger down or up, the shade thins.
      setView({ ...FITTED, x: dx * 0.25, y: dy });
      setShade(Math.max(0.2, 1 - Math.abs(dy) / (s.window_.height * 0.6)));
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (pointers.current.size > 0) {
      // One finger of a pinch lifted: the other carries on from here.
      begin();
      return;
    }
    gesture.current = null;
    if (!g || closing.current) return;
    const s = latest.current;
    if (g.moved) {
      if (g.view.scale <= 1 && s.view.scale <= 1 && e.pointerType !== "mouse") {
        const dy = e.clientY - g.start.y;
        if (swipeCloses(dy, dy / Math.max(1, performance.now() - g.start.at), s.window_.height)) close();
        else {
          setMotion("glide");
          setView(FITTED);
          setShade(1);
        }
      }
      return;
    }
    // A tap or a click. Twice on the picture zooms in at that point, or back to the fit; once
    // beside it closes; a finger's once on it shows or hides the buttons.
    const onPicture = downOnPicture.current;
    const now = performance.now();
    const twice = lastTap.current && now - lastTap.current.at < 300 && Math.hypot(e.clientX - lastTap.current.x, e.clientY - lastTap.current.y) < 30;
    lastTap.current = twice ? null : { at: now, x: e.clientX, y: e.clientY };
    window.clearTimeout(chromeTimer.current);
    if (twice && onPicture) zoomTo(s.view.scale > 1.01 ? 1 : Math.min(s.max, 2.5), fromCentre(e));
    else if (!onPicture && s.view.scale <= 1.01) close();
    else if (onPicture && e.pointerType !== "mouse") chromeTimer.current = window.setTimeout(() => setChrome((c) => !c), 300);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const keys: Record<string, () => void> = {
      "+": () => step(1.5),
      "=": () => step(1.5),
      "-": () => step(1 / 1.5),
      "0": () => zoomTo(1),
      ArrowLeft: () => pan(60, 0),
      ArrowRight: () => pan(-60, 0),
      ArrowUp: () => pan(0, 60),
      ArrowDown: () => pan(0, -60),
    };
    const action = !e.ctrlKey && !e.metaKey && !e.altKey ? keys[e.key] : undefined;
    if (!action) return;
    e.preventDefault();
    action();
  };
  const pan = (dx: number, dy: number) => {
    const s = latest.current;
    if (s.view.scale <= 1) return;
    setMotion("quick");
    setView(clampView({ ...s.view, x: s.view.x + dx, y: s.view.y + dy }, s.fit, s.window_, s.max, s.centre));
  };

  const percent = new Intl.NumberFormat(i18n.language, { style: "percent", maximumFractionDigits: 0 }).format(
    natural.width ? (fit.width * view.scale) / natural.width : 1,
  );
  const zoomed = view.scale > 1.01;

  return createPortal(
    <dialog
      ref={dialog}
      data-picture-viewer
      aria-label={caption || img.alt || t("viewer.label")}
      className="picture-viewer"
      data-motion={motion}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onKeyDown={onKeyDown}
      // A portal still bubbles through React's tree: the article would open it again, the sheet take its keys.
      onClick={(e) => e.stopPropagation()}
    >
      <div className="picture-viewer-shade" style={{ opacity: shade }} aria-hidden />
      <div
        ref={stage}
        className="picture-viewer-stage"
        data-zoomed={zoomed || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img
          data-viewer-picture
          src={src}
          alt={img.alt}
          referrerPolicy="no-referrer"
          draggable={false}
          style={{
            left: centre.x - fit.width / 2,
            top: centre.y - fit.height / 2,
            width: fit.width,
            height: fit.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
        />
      </div>
      <div className="picture-viewer-chrome" data-hidden={!chrome || undefined}>
        <div className="picture-viewer-top">
          {source.link ? (
            <button type="button" className="picture-viewer-button picture-viewer-wide" onClick={() => onOpen(source.link!)}>
              {t("viewer.openLink")}
              <Icon icon={ArrowUpRight} size={14} />
            </button>
          ) : (
            <span />
          )}
          <button type="button" className="picture-viewer-button" aria-label={t("viewer.close")} title={t("viewer.close")} onClick={close} autoFocus>
            <Icon icon={X} size={18} />
          </button>
        </div>
        <div className="picture-viewer-bottom">
          {caption && !zoomed && <p className="picture-viewer-caption">{caption}</p>}
          <div className="picture-viewer-zoom" role="group" aria-label={t("viewer.zoom")}>
            <button type="button" className="picture-viewer-button" aria-label={t("viewer.zoomOut")} title={t("viewer.zoomOut")} disabled={!zoomed} onClick={() => step(1 / 1.5)}>
              <Icon icon={Minus} size={16} />
            </button>
            <button type="button" className="picture-viewer-button picture-viewer-level" aria-label={t("viewer.fit")} title={t("viewer.fit")} onClick={() => zoomTo(1)}>
              {percent}
            </button>
            <button type="button" className="picture-viewer-button" aria-label={t("viewer.zoomIn")} title={t("viewer.zoomIn")} disabled={view.scale >= max - 0.01} onClick={() => step(1.5)}>
              <Icon icon={Plus} size={16} />
            </button>
          </div>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}

const windowSize = (): Size => ({ width: window.innerWidth, height: window.innerHeight });

/** The room for the fitted picture, a margin left for the buttons above and below and the caption, and its middle. */
function layoutFor(window: Size, caption: boolean): { room: Size; centre: Point } {
  const narrow = window.width < 640;
  const side = narrow ? 0 : 48;
  const top = narrow ? 64 : 72;
  const bottom = (narrow ? 72 : 80) + (caption ? 56 : 0);
  const room = { width: Math.max(1, window.width - side * 2), height: Math.max(1, window.height - top - bottom) };
  return { room, centre: { x: window.width / 2, y: top + room.height / 2 } };
}
