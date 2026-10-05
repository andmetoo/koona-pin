import { createLucideIcon, type LucideIcon, type LucideProps } from "lucide-react";
import spiritGreen from "../../design/brand/pin-spirit-flat/pin-spirit.svg";
import spiritMint from "../../design/brand/pin-spirit-flat/pin-spirit-mint.svg";

// One outline set (doc/guidelines.md, «Иконки»): 16 px frame, 1.5 px stroke,
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
 * The Pin Spirit mascot as the app logo (NP-081, Р-36): green body on the light theme,
 * mint on the dark one. The one-colour mark is only for small OS and browser icons.
 */
export function Mascot({ size = 36, className = "" }: { size?: number; className?: string }) {
  const width = Math.round((size * 880) / 916);
  return (
    <span className={`inline-flex shrink-0 ${className}`} style={{ width, height: size }} aria-hidden="true">
      <img src={spiritGreen} width={width} height={size} alt="" draggable={false} className="dark:hidden" />
      <img src={spiritMint} width={width} height={size} alt="" draggable={false} className="hidden dark:block" />
    </span>
  );
}

/** A Lucide icon drawn by the guideline rules. */
export function Icon({ icon: Glyph, size = 16, ...rest }: { icon: LucideIcon } & LucideProps) {
  return <Glyph size={size} strokeWidth={1.5} absoluteStrokeWidth aria-hidden="true" {...rest} />;
}
