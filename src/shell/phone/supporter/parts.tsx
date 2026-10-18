import type { CSSProperties, ReactNode } from "react";
import { Heart } from "lucide-react";

/** The Supporter heart, filled, in the season's colour on its soft disc (A1). */
export function SeasonHeart({ size = 48 }: { size?: number }) {
  return (
    <span className="ys-heart sp-heart" style={{ "--sp-heart": `${size}px` } as CSSProperties} aria-hidden="true">
      <Heart size={Math.round(size / 2)} strokeWidth={1.75} absoluteStrokeWidth fill="currentColor" />
    </span>
  );
}

/**
 * A line that needs attention: a failure (danger, read out at once) or a notice (amber, a status).
 * Errors only are red (doc/mobile-design.md).
 */
export function Note({ tone, children }: { tone: "danger" | "amber"; children: ReactNode }) {
  return (
    <p role={tone === "danger" ? "alert" : "status"} className="sp-note" data-tone={tone}>
      {children}
    </p>
  );
}
