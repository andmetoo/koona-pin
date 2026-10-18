import { CSSProperties, forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BundleEntry, entryKey } from "../../services/bundle";
import { Icon } from "../icons";
import { FeedIcon } from "../feeds/FeedIcon";
import { SiteMark } from "../library/Bookmarks";

/** The fan of mini cards (K6b): −8°, 0°, 8°, the first three things in the bundle. */
const FAN = [-8, 0, 8];

/** The motion of the capsule (share-bundle.md, «Animation»); these numbers win over the frames' captions. */
/** Near: the pointer within this many px of the capsule; it rises up to 8 px and the fan leans up to 4°. */
const NEAR = 120;
const LEAN = 4;
/** Over: the width follows the label. */
const WIDEN_MS = 160;
/** Drop: each card on its arc, the next one 40 ms later; at most 5 fly, the rest only count. */
const FLIGHT_MS = 260;
const STAGGER_MS = 40;
const FLYING = 5;
const ARC = 60;
const SPRING_MS = 380;
const SWEEP_MS = 420;
const ROLL_MS = 160;
/** Reduced motion: the static 2 px accent border that says it landed (N5). */
const LANDED_MS = 300;

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A drop on the bundle: where the pointer let go and how many cards to fly. */
interface Landing {
  at: { x: number; y: number };
  cards: number;
}
const landings = new Set<(landing: Landing) => void>();

/** Something was dropped on the bundle at `at`: the capsule plays its landing (or, reduced, its border). */
export function landInBundle(at: { x: number; y: number }, cards: number) {
  const landing = { at, cards: Math.max(1, Math.min(FLYING, cards)) };
  landings.forEach((listener) => listener(landing));
}

/** Listens for landings; the bundle keeps the capsule on screen while one plays. */
export function onLanding(listener: (landing: Landing) => void) {
  landings.add(listener);
  return () => void landings.delete(listener);
}

/** How long a landing keeps the capsule busy: the flights and the sweep, or the reduced border. */
export const landingMs = (cards: number) =>
  reduced() ? LANDED_MS : FLIGHT_MS + STAGGER_MS * (Math.max(1, Math.min(FLYING, cards)) - 1) + SWEEP_MS;

function Card({ entry, angle }: { entry: BundleEntry | null; angle: number }) {
  return (
    <span
      className="bundle-card absolute bottom-0 flex h-[26px] w-[20px] items-end justify-start rounded-[4px] border border-line bg-card p-[3px] shadow-[0_1px_2px_rgb(0_0_0/0.12)]"
      style={{ "--angle": angle, left: 7 + angle * 0.9 } as CSSProperties}
    >
      {entry?.kind === "bookmark" ? <SiteMark b={entry.bookmark} size={10} /> : entry?.kind === "feed" ? <FeedIcon feed={entry.feed} size={10} /> : null}
    </span>
  );
}

/** A point of the quadratic arc from `a` to `b` whose control point is 60 px above the higher end. */
function arc(a: { x: number; y: number }, b: { x: number; y: number }, t: number) {
  const c = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - ARC };
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

/** The cards of a drop fly from the pointer into the fan, one after another (K6b, «Drop animation»). */
function fly(from: { x: number; y: number }, to: DOMRect, cards: number) {
  const end = { x: to.left + to.width / 2 - 10, y: to.top + to.height / 2 - 13 };
  const start = { x: from.x - 10, y: from.y - 13 };
  for (let i = 0; i < cards; i++) {
    const card = document.createElement("div");
    card.setAttribute("aria-hidden", "true");
    card.dataset.bundleFlyer = "";
    card.className = "pointer-events-none fixed top-0 left-0 z-[60] h-[26px] w-[20px] rounded-[4px] border border-line bg-card shadow-[0_2px_6px_rgb(0_0_0/0.18)]";
    document.body.append(card);
    const angle = FAN[i % FAN.length];
    const frames = Array.from({ length: 9 }, (_, k) => {
      const t = k / 8;
      const p = arc(start, end, t);
      return { transform: `translate(${p.x}px, ${p.y}px) rotate(${angle * t}deg) scale(${1.25 - 0.25 * t})`, opacity: k === 8 ? 0.6 : 1 };
    });
    const flight = card.animate(frames, { duration: FLIGHT_MS, delay: i * STAGGER_MS, easing: "ease-in", fill: "both" });
    const remove = () => card.remove();
    flight.onfinish = remove;
    flight.oncancel = remove;
  }
}

/**
 * The bundle at rest (K6b): about 48 px of glass at the bottom right of the main area, a fan of
 * mini cards, «Bundle» and the count. Hover or focus shows × (hide it for the session) and fans the
 * cards wider. While something is dragged it fades in, even empty or hidden, and is a drop target.
 *
 * Motion (share-bundle.md, piece C) is transform and opacity only, and only near the capsule (S13):
 * within 120 px it rises, the fan leans toward the pointer and the glow grows. Over it, it widens to
 * say what the drop does and the count gives way. A drop flies the cards in on arcs, springs the
 * stack, rolls the count and runs a light sweep. Reduced motion: none of it, a 2 px accent border
 * for 300 ms instead. On Linux the glass is solid, the glow a plain ring and there is no sweep (CSS).
 */
export const Capsule = forwardRef<
  HTMLButtonElement,
  {
    count: number;
    entries: BundleEntry[];
    bottom: number;
    /** A drag is on: shown whatever the rest state, and a target. */
    dragging: boolean;
    /** The pointer is over it: the label of the drop. */
    over: string | null;
    expanded: boolean;
    panelId: string;
    onClick: () => void;
    onHide: () => void;
  }
>(function Capsule({ count, entries, bottom, dragging, over, expanded, panelId, onClick, onHide }, ref) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const shell = useRef<HTMLSpanElement>(null);
  const fan = useRef<HTMLSpanElement>(null);
  const sweep = useRef<HTMLSpanElement>(null);
  useImperativeHandle(ref, () => button.current!);
  const [landed, setLanded] = useState(false);

  // Near (≤ 120 px): how close the pointer is, as CSS variables; the stylesheet turns them into the
  // rise, the lean and the glow. Nothing re-renders while the pointer moves.
  useEffect(() => {
    const element = root.current;
    if (!dragging || !element) return;
    const near = (e: PointerEvent) => {
      const box = button.current?.getBoundingClientRect();
      if (!box) return;
      const dx = Math.max(box.left - e.clientX, 0, e.clientX - box.right);
      const dy = Math.max(box.top - e.clientY, 0, e.clientY - box.bottom);
      const closeness = Math.max(0, 1 - Math.hypot(dx, dy) / NEAR);
      const side = Math.max(-1, Math.min(1, (e.clientX - (box.left + box.width / 2)) / NEAR));
      element.style.setProperty("--near", closeness.toFixed(3));
      element.style.setProperty("--lean", (side * LEAN * closeness).toFixed(2));
      element.toggleAttribute("data-near", closeness > 0);
    };
    window.addEventListener("pointermove", near);
    return () => {
      window.removeEventListener("pointermove", near);
      element.style.removeProperty("--near");
      element.style.removeProperty("--lean");
      element.removeAttribute("data-near");
    };
  }, [dragging]);

  // Over: the glass follows the new width from the old one (FLIP on a scale, not on `width`).
  const width = useRef(0);
  useLayoutEffect(() => {
    const now = button.current?.offsetWidth ?? 0;
    const before = width.current;
    width.current = now;
    if (!before || !now || before === now || reduced()) return;
    shell.current?.animate([{ transform: `scaleX(${before / now})` }, { transform: "none" }], {
      duration: WIDEN_MS,
      easing: "cubic-bezier(.2,.8,.2,1)",
    });
  });

  // The count rolls: the old digits up and out, the new ones in from below.
  const [roll, setRoll] = useState<number | null>(null);
  const lastCount = useRef(count);
  useEffect(() => {
    const from = lastCount.current;
    lastCount.current = count;
    if (from === count || reduced()) return;
    setRoll(from);
    const timer = window.setTimeout(() => setRoll(null), ROLL_MS);
    return () => window.clearTimeout(timer);
  }, [count]);

  // A drop: the cards fly in, then the stack springs and the light sweeps; reduced, the border.
  useEffect(() => {
    const timers: number[] = [];
    const stop = onLanding(({ at, cards }) => {
      if (reduced()) {
        setLanded(true);
        timers.push(window.setTimeout(() => setLanded(false), LANDED_MS));
        return;
      }
      // After the drag's last render: the capsule has its resting width again.
      requestAnimationFrame(() => {
        const target = fan.current?.getBoundingClientRect();
        if (!target) return;
        fly(at, target, cards);
        timers.push(
          window.setTimeout(() => {
            fan.current?.animate([{ transform: "scale(0.82)" }, { transform: "none" }], { duration: SPRING_MS, easing: "cubic-bezier(.3,1.6,.5,1)" });
            sweep.current?.animate(
              [
                { transform: "translateX(-100%)", opacity: 0 },
                { opacity: 1, offset: 0.3 },
                { transform: "translateX(100%)", opacity: 0 },
              ],
              { duration: SWEEP_MS, easing: "ease-out" },
            );
          }, FLIGHT_MS + STAGGER_MS * (cards - 1)),
        );
      });
    });
    return () => {
      stop();
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  const cards = FAN.map((angle, i) => ({ angle, entry: entries[i] ?? null })).filter((card, i) => card.entry || (i === 1 && !entries.length));
  return (
    <div
      ref={root}
      data-bundle-capsule
      data-drop={dragging ? "bundle" : undefined}
      data-over={over ? "" : undefined}
      data-dragging={dragging || undefined}
      data-landed={landed ? "" : undefined}
      className="group/capsule absolute right-6 z-40 animate-[bundle-fade_120ms_linear]"
      style={{ bottom }}
    >
      <button
        ref={button}
        type="button"
        aria-label={t("bundle.label", { count })}
        aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined}
        onClick={onClick}
        className="bundle-capsule relative flex h-12 items-center gap-2.5 rounded-full pr-2 pl-3 text-md font-medium text-ink"
      >
        <span aria-hidden className="bundle-glow pointer-events-none absolute inset-0 rounded-full" />
        <span aria-hidden className="bundle-shell pointer-events-none absolute inset-0 overflow-hidden rounded-full">
          <span ref={sweep} className="bundle-sweep absolute inset-0 opacity-0" />
        </span>
        <span ref={fan} aria-hidden className={`bundle-fan relative h-[30px] w-9 shrink-0 ${entries.length ? "" : "opacity-60"}`}>
          {cards.map(({ angle, entry }) => (
            <Card key={entry ? entryKey(entry) : "empty"} entry={entry} angle={entry ? angle : 0} />
          ))}
        </span>
        <span
          key={over ?? "rest"}
          className={`relative animate-[bundle-fade_120ms_linear] whitespace-nowrap ${over ? "pr-2 font-semibold text-on-accent-soft" : count ? "" : "pr-2 text-muted"}`}
        >
          {over ?? t("bundle.name")}
        </span>
        {!over && count > 0 && (
          <span
            aria-hidden
            data-bundle-count
            className="relative flex h-6 min-w-6 items-center justify-center overflow-hidden rounded-full bg-accent px-1.5 text-xs font-bold text-on-accent tabular-nums"
          >
            <span key={count} className={roll !== null ? "bundle-roll-in" : ""}>
              {count}
            </span>
            {roll !== null && <span className="bundle-roll-out absolute inset-0 flex items-center justify-center">{roll}</span>}
          </span>
        )}
      </button>
      {!dragging && (
        <button
          type="button"
          aria-label={t("bundle.hide")}
          title={t("bundle.hide")}
          onClick={onHide}
          className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full border border-line bg-card text-icon opacity-0 shadow-[0_1px_3px_rgb(0_0_0/0.15)] transition-opacity duration-150 group-hover/capsule:opacity-100 group-focus-within/capsule:opacity-100 hover:text-ink"
        >
          <Icon icon={X} size={12} />
        </button>
      )}
    </div>
  );
});
