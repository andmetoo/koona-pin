import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Minus, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ViewerSource } from "../../services/articlePictures";
import { clampView, FITTED, fitSize, maxScale, type Point, type Size, swipeCloses, type View, zoomAt } from "../../services/pictureZoom";
import { useBack } from "../../platform/useBack";
import { Icon } from "../icons";

/**
 * A picture of the article in a card over it (frames P1–P4, #400): the card grows out of the
 * picture's place in the text while the page dims and softens behind it, the picture zooms inside
 * the card by the wheel, a pinch, a double click or + and −, pans by dragging, and the card goes
 * back to the picture on Escape, Back, the close button, a click beside it or a swipe down. A modal
 * <dialog>, so it stands over the reading sheet (itself one), keeps the focus, and every page's
 * keys stand down while it is open (`dialog[open]`). It renders beside the article, not in a
 * portal, so the card takes the reading theme's colours from the page around it.
 */
export function PictureViewer({ img, source, caption, onOpen, onClose }: {
  /** The picture in the article: where the card grows from and goes back to. */
  img: HTMLImageElement;
  source: ViewerSource;
  caption: string | null;
  onOpen: (url: string) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [window_, setWindow] = useState<Size>(() => windowSize());
  const [natural, setNatural] = useState<Size>(() => ({ width: img.naturalWidth, height: img.naturalHeight }));
  const [src, setSrc] = useState(source.shown);
  // The box is sized once, as large as the large picture will be when the srcset says so: the
  // card neither jumps nor resizes when that picture arrives. A larger file than promised only
  // lets the zoom go further, and the percentage is always of the pixels on screen.
  const [cap] = useState(() => Math.max(img.naturalWidth, source.largeWidth ?? 0));
  const pixels = Math.max(cap, natural.width);
  const narrow = window_.width < 640;
  const room = roomFor(window_);
  const box = useMemo(() => fitSize(natural, room, cap), [natural.width, natural.height, room.width, room.height, cap]);
  const card = cardFor(box, window_, narrow, !!caption);
  const max = maxScale(box, pixels);
  const middle: Point = { x: box.width / 2, y: box.height / 2 };

  /** The picture inside the box: offset from the box's centre and scale over the fit. */
  const [view, setView] = useState<View>(FITTED);
  /** The card itself: where it stands against its place, for the growth out of the picture, the way back and a swipe. */
  const reduce = useMemo(() => matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  const [lift, setLift] = useState<Lift>(() => (reduce ? FADED : liftFrom(img, card)));
  /** How the next change moves: `open` and `close` for the card, `glide` for a button or a key, `none` while a finger or the wheel leads. */
  const [motion, setMotion] = useState<"open" | "close" | "glide" | "quick" | "none">("none");
  const [shade, setShade] = useState(0);
  const closing = useRef(false);
  const percentOf = useMemo(() => new Intl.NumberFormat(i18n.language, { style: "percent", maximumFractionDigits: 0 }), [i18n.language]);

  const latest = useRef({ view, box, max, middle, card });
  latest.current = { view, box, max, middle, card };

  // Open: in the top layer, grown out of the article's picture on the next frame.
  useLayoutEffect(() => {
    const element = dialog.current!;
    const before = document.activeElement as HTMLElement | null;
    element.showModal();
    // The dialog would focus its first button, the zoom level; Close is the one to start from.
    closeButton.current?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => {
      setMotion("open");
      setLift(SETTLED);
      setShade(1);
    });
    return () => {
      cancelAnimationFrame(frame);
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
  // A new window or a larger picture keeps the zoom inside the box.
  useEffect(() => setView((v) => clampView(v, box, box, max, middle)), [box.width, box.height]);

  const close = () => {
    if (closing.current) return;
    closing.current = true;
    setMotion("close");
    setShade(0);
    // Back toward the picture in the text when it is still on screen; otherwise it fades where it is.
    // Reduced motion: it only fades, from where it stands (after a swipe too).
    const back = liftFrom(img, latest.current.card);
    if (reduce) setLift((l) => ({ ...l, opacity: 0 }));
    else setLift(back.visible ? { ...back, opacity: 0 } : { x: 0, y: 0, scale: 0.94, opacity: 0, visible: true });
    window.setTimeout(onClose, reduce ? 120 : 200);
  };
  useBack(close);

  const zoomTo = (scale: number, at: Point = { x: 0, y: 0 }, how: "glide" | "quick" | "none" = "glide") => {
    const s = latest.current;
    setMotion(how);
    setView(zoomAt(s.view, scale, at, s.box, s.box, s.max, s.middle));
  };
  const step = (factor: number) => zoomTo(latest.current.view.scale * factor);
  /** A point of the window from the box's centre, as the zoom takes it. */
  const inBox = (e: { clientX: number; clientY: number }): Point => {
    const rect = boxRef.current!.getBoundingClientRect();
    return { x: e.clientX - (rect.left + rect.width / 2), y: e.clientY - (rect.top + rect.height / 2) };
  };

  // The wheel over the picture. A pinch on a trackpad comes as the wheel with ctrl in Chromium and
  // as gesture events in WebKit (the Mac app): both zoom at the pointer. A whole notch zooms. For
  // the rest (a Mac mouse's small, uneven steps, a trackpad's scroll) a burst of wheel events is
  // one session, decided as it starts: begun vertically over the fitted picture, it zooms all
  // along; begun over a zoomed one, it pans. Anywhere else the wheel does nothing, and the page
  // under the dialog does not scroll.
  useEffect(() => {
    const element = dialog.current!;
    /** The WebKit pinch going on: the scale it began from, and when it last changed. */
    let pinch: { scale: number; at: number } | null = null;
    /** A pinch whose gestureend never came (the window lost focus) is over after a pause. */
    const pinching = () => !!pinch && performance.now() - pinch.at < 300;
    /** The wheel burst going on: whether it zooms, and when its last event came. */
    let burst: { zooms: boolean; at: number } | null = null;
    const over = (target: EventTarget | null) => !closing.current && !!boxRef.current?.contains(target as Node);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      // WebKit may follow its gesture events with ctrl-wheels: one pinch zooms once.
      if (pinching() || !over(e.target)) return;
      const s = latest.current;
      const at = inBox(e);
      const notch = e.deltaMode === 1 || (Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
      const lines = e.deltaMode === 1 ? 40 : 1;
      if (e.ctrlKey) return zoomTo(s.view.scale * Math.exp(-e.deltaY * lines * 0.01), at, "none");
      if (notch) return zoomTo(s.view.scale * (e.deltaY < 0 ? 1.25 : 0.8), at, "quick");
      const now = performance.now();
      if (!burst || now - burst.at > 200) burst = { zooms: s.view.scale <= 1.01 && e.deltaX === 0, at: now };
      burst.at = now;
      if (burst.zooms) zoomTo(s.view.scale * Math.exp(-e.deltaY * 0.0025), at, "none");
      else {
        setMotion("none");
        setView(clampView({ ...s.view, x: s.view.x - e.deltaX, y: s.view.y - e.deltaY }, s.box, s.box, s.max, s.middle));
      }
    };
    /** WebKit's GestureEvent: `scale` since the gesture began. */
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    const gestureStart = (e: Event) => {
      e.preventDefault();
      pinch = over(e.target) ? { scale: latest.current.view.scale, at: performance.now() } : null;
    };
    const gestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Gesture;
      if (!pinch || !Number.isFinite(g.scale)) return;
      pinch.at = performance.now();
      // The point between the fingers when the event names one, else the picture's middle.
      const at = Number.isFinite(g.clientX) && Number.isFinite(g.clientY) && (g.clientX || g.clientY) ? inBox(g) : { x: 0, y: 0 };
      zoomTo(pinch.scale * g.scale, at, "none");
    };
    const gestureEnd = (e: Event) => {
      e.preventDefault();
      pinch = null;
    };
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("gesturestart", gestureStart);
    element.addEventListener("gesturechange", gestureChange);
    element.addEventListener("gestureend", gestureEnd);
    return () => {
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("gesturestart", gestureStart);
      element.removeEventListener("gesturechange", gestureChange);
      element.removeEventListener("gestureend", gestureEnd);
    };
  }, []);

  // Pointers on the picture: one drags a zoomed picture, or (a finger) swipes the unzoomed card
  // down or up to close it; two pinch. A press beside the card that does not move closes it.
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ view: View; distance: number; mid: Point; start: Point & { at: number }; moved: boolean } | null>(null);
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);
  /** Where the press began: on the picture, elsewhere on the card, or beside it. Captured events all come from the dialog. */
  const pressed = useRef<"picture" | "card" | "beside">("beside");

  const begin = () => {
    const points = [...pointers.current.values()];
    const mid = points.length === 2 ? { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 } : points[0];
    const distance = points.length === 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;
    gesture.current = { view: latest.current.view, distance, mid, start: { ...mid, at: performance.now() }, moved: gesture.current?.moved ?? false };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (closing.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    if (pointers.current.size === 0) pressed.current = target.closest("[data-viewer-box]") ? "picture" : target.closest("[data-viewer-card]") ? "card" : "beside";
    try {
      dialog.current!.setPointerCapture(e.pointerId);
    } catch {
      // A pointer the browser no longer tracks: the gesture goes on without the capture.
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture.current = null;
    begin();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current || pressed.current !== "picture") return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const s = latest.current;
    const points = [...pointers.current.values()];
    if (points.length === 2) {
      const mid = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      const zoomed = zoomAt(g.view, g.view.scale * (distance / Math.max(1, g.distance)), inBox({ clientX: g.mid.x, clientY: g.mid.y }), s.box, s.box, s.max, s.middle);
      g.moved = true;
      setMotion("none");
      setView(clampView({ ...zoomed, x: zoomed.x + mid.x - g.mid.x, y: zoomed.y + mid.y - g.mid.y }, s.box, s.box, s.max, s.middle));
      return;
    }
    const dx = e.clientX - g.mid.x;
    const dy = e.clientY - g.mid.y;
    if (!g.moved && Math.hypot(dx, dy) < 6) return;
    g.moved = true;
    setMotion("none");
    if (g.view.scale > 1) setView(clampView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy }, s.box, s.box, s.max, s.middle));
    else if (e.pointerType !== "mouse") {
      // The swipe that closes: the card follows the finger, the shade thins.
      setLift({ ...SETTLED, y: dy });
      setShade(Math.max(0.2, 1 - Math.abs(dy) / (window_.height * 0.6)));
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
      if (pressed.current === "picture" && g.view.scale <= 1 && s.view.scale <= 1 && e.pointerType !== "mouse") {
        const dy = e.clientY - g.start.y;
        if (swipeCloses(dy, dy / Math.max(1, performance.now() - g.start.at), window_.height)) close();
        else {
          setMotion("glide");
          setLift(SETTLED);
          setShade(1);
        }
      }
      return;
    }
    if (pressed.current === "beside") return close();
    if (pressed.current !== "picture") return;
    // Twice on the picture zooms in at that point, or back to the fit.
    const now = performance.now();
    const twice = lastTap.current && now - lastTap.current.at < 300 && Math.hypot(e.clientX - lastTap.current.x, e.clientY - lastTap.current.y) < 30;
    lastTap.current = twice ? null : { at: now, x: e.clientX, y: e.clientY };
    if (twice) zoomTo(s.view.scale > 1.01 ? 1 : Math.min(s.max, 2.5), inBox(e));
  };

  const pan = (dx: number, dy: number) => {
    const s = latest.current;
    if (s.view.scale <= 1) return;
    setMotion("quick");
    setView(clampView({ ...s.view, x: s.view.x + dx, y: s.view.y + dy }, s.box, s.box, s.max, s.middle));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    // The reading sheet and the article around it would take these keys otherwise: React bubbles through.
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

  const percent = percentOf.format(pixels ? (box.width * view.scale) / pixels : 1);
  const zoomed = view.scale > 1.01;
  const cardStyle: CSSProperties = {
    left: card.left,
    top: card.top,
    width: card.width,
    height: card.height,
    // It grows from the picture box's middle, which is what lands on the picture in the text.
    transformOrigin: `${card.pad + box.width / 2}px ${card.top_ + box.height / 2}px`,
    // Under reduced motion too: a swipe still moves the card with the finger; only the growth is left out.
    transform: `translate(${lift.x}px, ${lift.y}px) scale(${lift.scale})`,
    opacity: lift.opacity,
  };

  return (
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
      // React bubbles through the tree: the article around it would open the picture again.
      onClick={(e) => e.stopPropagation()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="picture-viewer-shade" style={{ opacity: shade }} aria-hidden />
      <div data-viewer-card className="picture-viewer-card" data-narrow={narrow || undefined} style={cardStyle}>
        {narrow && <span className="picture-viewer-grabber" aria-hidden />}
        <div
          ref={boxRef}
          data-viewer-box
          className="picture-viewer-box"
          data-zoomed={zoomed || undefined}
          style={{ left: card.pad, top: card.top_, width: box.width, height: box.height }}
        >
          <img
            data-viewer-picture
            src={src}
            alt={img.alt}
            referrerPolicy="no-referrer"
            draggable={false}
            style={{ width: box.width, height: box.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          />
        </div>
        {caption && narrow && <p className="picture-viewer-caption" style={{ top: card.top_ + box.height + 12 }}>{caption}</p>}
        <div className="picture-viewer-bar" style={{ top: card.height - 12 - 32 }}>
          {caption && !narrow ? <p className="picture-viewer-caption">{caption}</p> : <span className="flex-1" />}
          {source.link && (
            <button type="button" className="picture-viewer-button picture-viewer-wide" onClick={() => onOpen(source.link!)}>
              {t("viewer.openLink")}
              <Icon icon={ArrowUpRight} size={14} />
            </button>
          )}
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
          <button type="button" className="picture-viewer-button picture-viewer-close" aria-label={t("viewer.close")} title={t("viewer.close")} onClick={close} ref={closeButton}>
            <Icon icon={X} size={16} />
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** The card's move against its place: a translation, a scale about the picture box's middle, and its opacity. */
interface Lift {
  x: number;
  y: number;
  scale: number;
  opacity: number;
  /** Whether the picture it comes from is on screen at all. */
  visible: boolean;
}
const SETTLED: Lift = { x: 0, y: 0, scale: 1, opacity: 1, visible: true };
/** In place, not shown yet: the start under reduced motion, which only fades. */
const FADED: Lift = { ...SETTLED, opacity: 0 };

/** Where the card stands so that its picture box covers the picture in the text (frame P3). */
function liftFrom(img: HTMLImageElement, card: Card): Lift {
  const rect = img.getBoundingClientRect();
  const visible = rect.width > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  if (!rect.width || !card.box.width) return { x: 0, y: 0, scale: 0.94, opacity: 0, visible };
  const scale = Math.min(1, Math.max(rect.width / card.box.width, rect.height / card.box.height));
  const boxX = card.left + card.pad + card.box.width / 2;
  const boxY = card.top + card.top_ + card.box.height / 2;
  return { x: rect.left + rect.width / 2 - boxX, y: rect.top + rect.height / 2 - boxY, scale, opacity: 0, visible };
}

const windowSize = (): Size => ({ width: window.innerWidth, height: window.innerHeight });

/**
 * The most room the picture takes (frame P1): the card stays well inside the window, about a
 * fifth of it free on either side, and the bar under the picture fits below. A phone gives it
 * the width and three fifths of the height (P4).
 */
function roomFor(window: Size): Size {
  if (window.width < 640) return { width: Math.max(1, window.width - 48), height: Math.max(1, window.height * 0.6) };
  const side = Math.max(48, window.width * 0.18);
  const top = Math.max(32, window.height * 0.15);
  return { width: Math.max(1, window.width - side * 2), height: Math.max(1, window.height - top * 2 - 80) };
}

interface Card {
  left: number;
  top: number;
  width: number;
  height: number;
  pad: number;
  /** The picture box's top inside the card: below the grabber on a phone. */
  top_: number;
  box: Size;
}

/** The card around the picture box: 12 px of padding, the bar of 32 below, the caption over it on a phone. */
function cardFor(box: Size, window: Size, narrow: boolean, caption: boolean): Card {
  const pad = 12;
  const top_ = narrow ? 20 : pad;
  const width = Math.max(box.width + pad * 2, narrow ? 0 : 340);
  const height = top_ + box.height + 12 + (narrow && caption ? 44 : 0) + 32 + 12;
  return { left: (window.width - width) / 2, top: (window.height - height) / 2, width, height, pad: (width - box.width) / 2, top_, box };
}
