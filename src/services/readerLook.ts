import type { CSSProperties } from "react";
import type { SupporterStatus } from "../types";
import { preference, savePreference, storedValue } from "./preferences";

/**
 * How reading looks (NP-124, Р-69 points 7 and 9, frame B8): the theme, the
 * size of the text, the width of the column and the font of the Aa panel, kept
 * per computer. White and Dark are free and follow the app's theme until one is
 * chosen. Paper and Sepia are Supporter's: their palettes are commercial code
 * (`src/components/commercial/readerThemes.ts`) that registers itself here.
 * Without it — a community build — they stay locked. Both fonts, Serif (Literata)
 * and Sans (Inter), are free (owner, 2026-10-15: no paid fonts yet).
 */

/** One set of `--np-read-*` values: the page, the queue, lines and words (src/styles/app.css). */
export interface ReaderPalette {
  read: string;
  queue: string;
  current: string;
  card: string;
  edge: string;
  track: string;
  border: string;
  /** Body text of the article: at least 7:1 on `read` (readerLook.test.ts). */
  ink: string;
  /** Titles and words of the interface around it: at least 7:1 on `read` too. */
  text: string;
  muted: string;
  dim: string;
  /** The Aa panel, its segmented controls' trough and their chosen segment. */
  panel: string;
  well: string;
  raised: string;
}

export type FreeTheme = "white" | "dark";
export const FREE_THEMES: readonly FreeTheme[] = ["white", "dark"];
/** Supporter's themes, shown locked without the plan (or in a build without them). */
export const SUPPORTER_THEMES = ["paper", "sepia"] as const;
export type ReaderTheme = FreeTheme | (typeof SUPPORTER_THEMES)[number];

export const FONTS = ["serif", "sans"] as const;
export type ReaderFont = (typeof FONTS)[number];

export type ReaderColumn = "narrow" | "medium" | "wide";
export const COLUMNS: readonly ReaderColumn[] = ["narrow", "medium", "wide"];
/** The column of B3 is the medium one (640 px); the others a step either side. */
export const COLUMN_WIDTH: Record<ReaderColumn, number> = { narrow: 560, medium: 640, wide: 760 };

/** Text sizes of the slider, px; 18 is B3's body (line 30). */
export const SIZES = [15, 16, 17, 18, 19, 20, 22, 24] as const;
export const DEFAULT_SIZE = 18;

/** The free palettes: the same values as `:root` and `[data-theme=dark]` in app.css (B8's swatches). */
export const FREE_PALETTES: Record<FreeTheme, ReaderPalette> = {
  white: {
    read: "#ffffff",
    queue: "#f6f6f4",
    current: "#ffffff",
    card: "#fafaf9",
    edge: "#e8e8e4",
    track: "#ececea",
    border: "#dededa",
    ink: "#22231f",
    text: "#2e302b",
    muted: "#85857e",
    dim: "#adada6",
    panel: "#ffffff",
    well: "#f1f1ee",
    raised: "#ffffff",
  },
  dark: {
    read: "#1e1d1a",
    queue: "#252421",
    current: "#2c2b27",
    card: "#252421",
    edge: "#33322e",
    track: "#33322e",
    border: "#3d3c37",
    ink: "#e8e2d6",
    text: "#dfdad0",
    muted: "#8c8a83",
    dim: "#615f59",
    panel: "#292824",
    well: "#1e1d1a",
    raised: "#34332e",
  },
};

/** The faces of the fonts; Literata and Inter ship with the app (OFL). */
const FONT_STACKS: Record<ReaderFont, string> = {
  serif: '"Literata Variable", Literata, Georgia, "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", "Yu Mincho", "Hiragino Mincho ProN", "Times New Roman", serif',
  sans: 'var(--np-font)',
};

/** What a Supporter build adds: the palettes of its themes by id. */
export interface SupporterLook {
  themes: Partial<Record<(typeof SUPPORTER_THEMES)[number], ReaderPalette>>;
}
let supporterLook: SupporterLook = { themes: {} };

/** Called once by the commercial module; a community build never calls it. */
export function registerSupporterLook(look: SupporterLook) {
  supporterLook = look;
}

/** For tests: the build without the commercial module. */
export function clearSupporterLook() {
  supporterLook = { themes: {} };
}

/**
 * The plan check (Р-64, point 6): like the backup folder, the app opens Supporter's
 * themes by the state of the plan it keeps, no request behind it. A plan that ended
 * locks them again; the choice stays and comes back with a new plan.
 */
export function supporterUnlocked(supporter: SupporterStatus | null | undefined): boolean {
  return !!supporter?.plan;
}

const isSupporterTheme = (theme: ReaderTheme) => (SUPPORTER_THEMES as readonly string[]).includes(theme);

/** A Supporter's theme is locked without the plan, and always in a build without its code. */
export function themeLocked(theme: ReaderTheme, unlocked: boolean): boolean {
  if (!isSupporterTheme(theme)) return false;
  return !unlocked || !supporterLook.themes[theme as (typeof SUPPORTER_THEMES)[number]];
}

/** The palette of a theme when it can be shown; a Supporter's from the commercial module. */
export function paletteOf(theme: ReaderTheme): ReaderPalette | null {
  if (theme === "white" || theme === "dark") return FREE_PALETTES[theme];
  return supporterLook.themes[theme] ?? null;
}

/** What the person chose; `auto` follows the app's theme. */
export interface ReaderChoice {
  theme: ReaderTheme | "auto";
  font: ReaderFont;
  size: number;
  column: ReaderColumn;
}

const THEME_KEY = "readerTheme";
const FONT_KEY = "readerFont";
const SIZE_KEY = "readerSize";
const COLUMN_KEY = "readerColumn";

export function storedReaderChoice(): ReaderChoice {
  const size = Number(storedValue(SIZE_KEY));
  return {
    theme: preference<ReaderChoice["theme"]>(THEME_KEY, ["auto", ...FREE_THEMES, ...SUPPORTER_THEMES], "auto"),
    font: preference<ReaderFont>(FONT_KEY, [...FONTS], "serif"),
    size: (SIZES as readonly number[]).includes(size) ? size : DEFAULT_SIZE,
    column: preference<ReaderColumn>(COLUMN_KEY, [...COLUMNS], "medium"),
  };
}

export function saveReaderChoice(choice: ReaderChoice) {
  savePreference(THEME_KEY, choice.theme);
  savePreference(FONT_KEY, choice.font);
  savePreference(SIZE_KEY, String(choice.size));
  savePreference(COLUMN_KEY, choice.column);
}

/** What reading shows now: a locked or missing theme falls back to the free one. */
export interface ReaderLook {
  theme: ReaderTheme;
  palette: ReaderPalette;
  font: ReaderFont;
  fontStack: string;
  size: number;
  /** Line height of the body: B3's 30 on 18, the same rhythm at other sizes. */
  lineHeight: number;
  column: ReaderColumn;
  width: number;
}

export function resolveReaderLook(choice: ReaderChoice, { appDark, unlocked }: { appDark: boolean; unlocked: boolean }): ReaderLook {
  const fallback: FreeTheme = appDark ? "dark" : "white";
  const wanted = choice.theme === "auto" ? fallback : choice.theme;
  const theme = themeLocked(wanted, unlocked) ? fallback : wanted;
  return {
    theme,
    palette: paletteOf(theme)!,
    font: choice.font,
    fontStack: FONT_STACKS[choice.font],
    size: choice.size,
    lineHeight: Math.round((choice.size * 5) / 3),
    column: choice.column,
    width: COLUMN_WIDTH[choice.column],
  };
}

/** The look as CSS variables on the mode's or the sheet's root: everything inside takes it. */
export function readerStyle(look: ReaderLook): CSSProperties {
  const p = look.palette;
  return {
    "--np-read": p.read,
    "--np-read-queue": p.queue,
    "--np-read-current": p.current,
    "--np-read-card": p.card,
    "--np-read-edge": p.edge,
    "--np-read-track": p.track,
    "--np-read-border": p.border,
    "--np-read-ink": p.ink,
    "--np-read-text": p.text,
    "--np-read-muted": p.muted,
    "--np-read-dim": p.dim,
    "--np-read-panel": p.panel,
    "--np-read-well": p.well,
    "--np-read-raised": p.raised,
    // The aliases were resolved at :root; here they follow the theme too.
    "--np-sheet": p.read,
    "--np-sheet-ink": p.ink,
    "--np-sheet-line": p.border,
    "--reader-font": look.fontStack,
    "--reader-size": `${look.size}px`,
    "--reader-line": `${look.lineHeight}px`,
    "--reader-width": `${look.width}px`,
    // The accent of the app's light or dark theme, by the page and not by the app: White in a
    // dark app keeps the dark green. Native scrollbars and controls follow the page too.
    ...(darkPage(p) ? DARK_ACCENT : LIGHT_ACCENT),
    colorScheme: darkPage(p) ? "dark" : "light",
  } as CSSProperties;
}

const darkPage = (p: ReaderPalette) => relativeLuminance(p.read) < 0.2;
/** The values of app.css for each theme of the app. */
const LIGHT_ACCENT = {
  "--np-accent": "#2f6b4f",
  "--np-on-accent": "#ffffff",
  "--np-accent-soft": "#e2eee6",
  "--np-on-accent-soft": "#1f4a36",
  "--np-accent-muted": "#6e9c84",
};
const DARK_ACCENT = {
  "--np-accent": "#8fd0ae",
  "--np-on-accent": "#1c1c19",
  "--np-accent-soft": "#25352c",
  "--np-on-accent-soft": "#8fd0ae",
  "--np-accent-muted": "#6fa58a",
};

/** WCAG 2 relative luminance of `#rrggbb`. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two `#rrggbb` colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
