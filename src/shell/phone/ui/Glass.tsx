import type { HTMLAttributes } from "react";

export type GlassLevel = "chrome" | "sheet" | "toast";

const CLASS: Record<GlassLevel, string> = { chrome: "ph-glass", sheet: "ph-glass-sheet", toast: "ph-glass-toast" };

/** The class of a glass level, for a control that is glass itself (a button, a section). */
export const glass = (level: GlassLevel = "chrome") => CLASS[level];

/**
 * A floating glass surface (doc/mobile-design.md, Glass levels): chrome for the nav pill, the
 * decision pill, header circles, the account cluster and the rail; sheet; toast. Never in the
 * content layer, and nothing glass on it: controls on glass are flat. Turns into opaque paper
 * with a hairline under Reduce Transparency, without backdrop-filter, or `data-glass="flat"`.
 */
export function Glass({ level = "chrome", className = "", ...rest }: { level?: GlassLevel } & HTMLAttributes<HTMLDivElement>) {
  return <div className={`${CLASS[level]} ${className}`} {...rest} />;
}
