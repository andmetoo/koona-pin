import { CircleArrowDown, createLucideIcon, type LucideIcon, type LucideProps } from "lucide-react";
import spiritMark from "../../design/brand/pin-spirit-flat/pin-spirit-micro.svg";

// One outline set (docs/design.md): 16 px frame, 1.5 px stroke,
// round caps. Icons follow Lucide geometry (ISC licence, lucide.dev).

/**
 * «All bookmarks»: the paperclip of the Pin Spirit (NP-081). Two loops ~2 px apart at 16 px,
 * so it keeps the weight of the set (Lucide's three-wire clip clots at this size).
 */
export const ClipIcon = createLucideIcon("ClipIcon", [
  ["path", { d: "M12.375 7.875V17.25a3 3 0 0 0 6 0V7.125a6.375 6.375 0 0 0-12.75 0v12", transform: "rotate(40 12 12)", key: "wire" }],
]);

/** «Inbox»: a tray with an arrow into it, as `Icon/Inbox` in iterone.sketch (16 grid × 1.5). */
export const InboxTray = createLucideIcon("InboxTray", [
  ["path", { d: "M12 2.625v7.125", key: "shaft" }],
  ["path", { d: "m8.25 6 3.75 3.75L15.75 6", key: "head" }],
  ["path", { d: "M2.625 13.875H7.5l1.5 2.25h6l1.5-2.25h4.875v4.5a3 3 0 0 1-3 3H5.625a3 3 0 0 1-3-3z", key: "tray" }],
]);

/**
 * The Pin Spirit as the app logo in the sidebar (NP-081, Р-36): its one-colour mark, the
 * silhouette of the app icon, painted in the accent through a mask, so it is green on the light
 * theme and mint on the dark one. The owner chose it over the full-colour spirit with the card
 * redesign (2026-10-16); the full spirit stays on the site, the store and the DMG.
 */
export function Mascot({ size = 28, className = "" }: { size?: number; className?: string }) {
  const mask = `url("${spiritMark}") center / contain no-repeat`;
  return (
    <span
      className={`inline-block shrink-0 bg-accent ${className}`}
      style={{ width: size, height: size, mask, WebkitMask: mask }}
      aria-hidden="true"
    />
  );
}

/** A Lucide icon drawn by the guideline rules. */
export function Icon({ icon: Glyph, size = 16, ...rest }: { icon: LucideIcon } & LucideProps) {
  return <Glyph size={size} strokeWidth={1.5} absoluteStrokeWidth aria-hidden="true" {...rest} />;
}

/**
 * «Offline» (NP-126): Lucide's circle-arrow-down. `filled`, the marker of a
 * saved copy: the disc in the current colour, the arrow cut out of it in
 * `cut` (the accent's own ink by default; the reader passes its button's colour).
 */
export function OfflineIcon({ filled = false, size = 16, cut = "[&_path]:stroke-on-accent", className = "" }: { filled?: boolean; size?: number; cut?: string; className?: string }) {
  return <Icon icon={CircleArrowDown} size={size} className={filled ? `fill-current ${cut} ${className}` : className} />;
}
