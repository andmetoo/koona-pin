import { type RefObject, useLayoutEffect } from "react";
import { type ReaderChoice, type ReaderLook, relativeLuminance, SIZES } from "../../../services/readerLook";

/** What the reading look puts on the reader's or the post view's screen. */
export type PhoneReaderLook = {
  /** CSS custom properties (and `colorScheme`). */
  style: Record<string, string>;
  /** A chosen theme's tone, for the glass over it (`data-page`); null: the app's own. */
  page: "dark" | "light" | null;
};

/**
 * How the phone's reader and post view take the Aa choice (NP-124) in "Paper & Glass": the text
 * a step larger than the desktop's (R1 reads Literata 19/30 at the default 18), the font, and a
 * theme. "Match the app" (`auto`, the default) keeps the phone's own paper and mesh, light or
 * dark as R1; a chosen theme paints the page in its palette through the phone's tokens, so the
 * screen's fades, rules, meta lines and the glass over it follow it.
 */
export function phoneReaderLook(look: ReaderLook, choice: ReaderChoice): PhoneReaderLook {
  const size = look.size + 1;
  const style: Record<string, string> = {
    ...(look.fontStack && { "--rd-font": look.fontStack }),
    "--rd-size": `${size}px`,
    "--rd-line": `${Math.round((size * 30) / 19)}px`,
  };
  if (choice.theme === "auto") return { style, page: null };
  const p = look.palette;
  const dark = relativeLuminance(p.read) < 0.2;
  Object.assign(style, {
    "--ph-bg": p.read,
    "--ph-mesh": "linear-gradient(transparent, transparent)",
    "--ph-paper": p.card,
    "--ph-raised": p.raised,
    "--ph-ink": p.text,
    "--ph-body": p.ink,
    "--ph-meta": p.muted,
    "--ph-icon": p.text,
    "--ph-line": p.edge,
    "--ph-well": p.well,
    "--ph-hairline": dark ? "rgb(255 255 255 / 0.08)" : "rgb(46 48 43 / 0.07)",
    "--ph-clear-rim": dark ? "rgb(255 255 255 / 0.22)" : "rgb(46 48 43 / 0.2)",
    "--ph-e1": dark ? "inset 0 1px 0 rgb(255 255 255 / 0.05)" : "0 1px 2px rgb(46 48 43 / 0.04), 0 10px 24px -12px rgb(46 48 43 / 0.18)",
    "--ph-accent": dark ? "#8fd0ae" : "#2f6b4f",
    "--ph-accent-hi": dark ? "#a6ddc0" : "#3b8060",
    "--ph-on-accent": dark ? "#141413" : "#ffffff",
    "--ph-accent-shadow": `0 4px 12px -6px ${dark ? "rgb(143 208 174 / 0.35)" : "rgb(47 107 79 / 0.35)"}`,
    colorScheme: dark ? "dark" : "light",
  });
  return { style, page: dark ? "dark" : "light" };
}

/**
 * Puts the look on the screen's own element (the kit's `Screen` takes no style): its background,
 * its top edge's fade and everything in it follow the tokens, the glass the page's tone. What a
 * new look no longer has is taken off again.
 */
export function useScreenLook(screen: RefObject<HTMLElement | null>, { style, page }: PhoneReaderLook) {
  useLayoutEffect(() => {
    const element = screen.current;
    if (!element) return;
    const entries = Object.entries(style).map(([name, value]) => [name === "colorScheme" ? "color-scheme" : name, value]);
    for (const [name, value] of entries) element.style.setProperty(name, value);
    if (page) element.dataset.page = page;
    return () => {
      entries.forEach(([name]) => element.style.removeProperty(name));
      delete element.dataset.page;
    };
  }, [screen, style, page]);
}

/** The Aa sheet's size steps: one smaller or larger, none past either end. */
export function stepSize(size: number, step: 1 | -1): number {
  const at = SIZES.indexOf(size as (typeof SIZES)[number]);
  const from = at < 0 ? SIZES.indexOf(18) : at;
  return SIZES[Math.min(SIZES.length - 1, Math.max(0, from + step))];
}
