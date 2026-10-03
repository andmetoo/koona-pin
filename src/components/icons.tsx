import type { LucideIcon, LucideProps } from "lucide-react";

// One outline set (doc/guidelines.md, «Иконки»): 16 px frame, 1.5 px stroke,
// round caps. Icons follow Lucide geometry (ISC licence, lucide.dev).

/** The bobby pin bent into an «n», from app-icon.svg (logo.sketch). */
const PIN = "M0 121V30C0 21.7 2.93 14.6 8.79 8.79 14.6 2.93 21.7 0 30 0s15.4 2.93 21.2 8.79C57.1 14.6 60 21.7 60 30v11c10 8.67 10 17.5 0 26.5-10 8.67-10 17.5 0 26.5 10 9 10 18 0 27";

/** «All bookmarks»: the brand mark in the icon stroke; narrow by design. */
export function PinIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d={PIN}
        transform="translate(4.51 1.75) scale(0.1033)"
        stroke="currentColor"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The logo mark, 18×24, stroke 2.73 as in the sidebar. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg width={18} height={24} viewBox="0 0 18 24" fill="none" className={className} aria-hidden="true">
      <path
        d={PIN}
        transform="translate(2.87 1) scale(0.1819)"
        stroke="currentColor"
        strokeWidth={2.73}
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A Lucide icon drawn by the guideline rules. */
export function Icon({ icon: Glyph, size = 16, ...rest }: { icon: LucideIcon } & LucideProps) {
  return <Glyph size={size} strokeWidth={1.5} absoluteStrokeWidth aria-hidden="true" {...rest} />;
}
