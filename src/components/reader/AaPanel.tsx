import { KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  COLUMNS,
  FREE_FONTS,
  FREE_THEMES,
  fontLocked,
  paletteOf,
  ReaderChoice,
  ReaderColumn,
  ReaderFont,
  ReaderLook,
  ReaderTheme,
  SIZES,
  SUPPORTER_FONTS,
  SUPPORTER_THEMES,
  themeLocked,
} from "../../services/readerLook";
import { Hint } from "../ui/Hint";

/**
 * «Aa» in the reading mode's top bar and its panel (NP-124, frame B8): text
 * size, column width, theme and font. White and Dark are free; Paper, Sepia and
 * the extra fonts carry a lock without Supporter, and a locked one opens the
 * Supporter dialog — chosen, it applies as soon as the plan arrives. Everything
 * is in the colours of the reading theme.
 */
export function AaButton({
  choice,
  look,
  unlocked,
  narrow,
  onChoice,
  onLocked,
  onSupporter,
}: {
  choice: ReaderChoice;
  look: ReaderLook;
  unlocked: boolean;
  narrow: boolean;
  onChoice: (choice: ReaderChoice) => void;
  /** A locked theme or font: it waits for the plan, and the Supporter dialog opens. */
  onLocked: (wish: Partial<Pick<ReaderChoice, "theme" | "font">>) => void;
  onSupporter: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  // A click anywhere else closes it; the Supporter dialog over it does not.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panel.current?.contains(target) || button.current?.contains(target) || (target as Element).closest?.("dialog[open]")) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>("input, [aria-checked=true]")?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  const sizeIndex = Math.max(0, SIZES.indexOf(choice.size as (typeof SIZES)[number]));
  const pickTheme = (theme: ReaderTheme) => (themeLocked(theme, unlocked) ? onLocked({ theme }) : onChoice({ ...choice, theme }));
  const pickFont = (font: ReaderFont) => (fontLocked(font, unlocked) ? onLocked({ font }) : onChoice({ ...choice, font }));
  const anyLocked = [...SUPPORTER_THEMES].some((theme) => themeLocked(theme, unlocked)) || [...SUPPORTER_FONTS].some((font) => fontLocked(font, unlocked));

  return (
    <div className="relative">
      <Hint label={t("readerAa.label")}>
        <button
          ref={button}
          type="button"
          data-reader-aa
          aria-label={t("readerAa.label")}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen(!open)}
          className={`read-serif flex size-[34px] items-center justify-center rounded-lg border border-read-border text-sm font-semibold text-read-text transition-colors duration-150 hover:bg-read-track ${open ? "bg-read-track" : ""}`}
        >
          Aa
        </button>
      </Hint>
      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label={t("readerAa.label")}
          data-menu
          data-reader-panel
          onKeyDown={onKeyDown}
          className={`absolute top-[42px] z-20 w-[300px] animate-appear rounded-xl border border-read-edge bg-read-panel px-4 pt-4 pb-4 text-read-text shadow-[0_10px_24px_rgb(46_48_43/0.15)] ${narrow ? "-right-[42px]" : "-right-[80px]"}`}
        >
          <Label>{t("readerAa.size")}</Label>
          <div className="mt-2 flex h-[30px] items-center gap-3">
            <span aria-hidden className="read-serif w-[9px] text-[13px] text-read-muted">
              A
            </span>
            <input
              type="range"
              min={0}
              max={SIZES.length - 1}
              step={1}
              value={sizeIndex}
              aria-label={t("readerAa.size")}
              aria-valuetext={t("readerAa.sizeValue", { size: SIZES[sizeIndex] })}
              onChange={(e) => onChoice({ ...choice, size: SIZES[Number(e.target.value)] })}
              className="h-[15px] min-w-0 flex-1 accent-accent"
            />
            <span aria-hidden className="read-serif w-[15px] text-[20px] text-read-ink">
              A
            </span>
          </div>

          <Label className="mt-4">{t("readerAa.column")}</Label>
          <Segments<ReaderColumn>
            label={t("readerAa.column")}
            value={choice.column}
            options={COLUMNS.map((column) => ({ value: column, label: t(`readerAa.columns.${column}`) }))}
            onChange={(column) => onChoice({ ...choice, column })}
          />

          <Label className="mt-4">{t("readerAa.theme")}</Label>
          <div role="radiogroup" aria-label={t("readerAa.theme")} className="mt-2 grid grid-cols-4 gap-1.5">
            {[...FREE_THEMES, ...SUPPORTER_THEMES].map((theme) => (
              <ThemeSwatch
                key={theme}
                theme={theme}
                name={t(`readerAa.themes.${theme}`)}
                checked={look.theme === theme}
                locked={themeLocked(theme, unlocked)}
                lockedLabel={t("readerAa.locked", { name: t(`readerAa.themes.${theme}`) })}
                onPick={() => pickTheme(theme)}
              />
            ))}
          </div>
          {anyLocked && (
            <p data-reader-supporter className="mt-2.5 text-xs leading-[15px] text-read-muted">
              {t("readerAa.supporterHint")}{" "}
              <button type="button" onClick={onSupporter} className="font-medium text-accent hover:underline">
                {t("readerAa.supporterLink")}
              </button>
            </p>
          )}

          <Label className="mt-4">{t("readerAa.font")}</Label>
          <Segments<ReaderFont>
            label={t("readerAa.font")}
            value={look.font}
            options={[...FREE_FONTS, ...SUPPORTER_FONTS].map((font) => ({
              value: font,
              label: t(`readerAa.fonts.${font}`),
              locked: fontLocked(font, unlocked),
              lockedLabel: t("readerAa.locked", { name: t(`readerAa.fonts.${font}`) }),
              font: font === "sans" || font === "legible" ? "sans" : "serif",
            }))}
            onChange={pickFont}
          />
        </div>
      )}
    </div>
  );
}

function Label({ children, className = "" }: { children: string; className?: string }) {
  return <p className={`text-2xs leading-[14px] font-semibold tracking-[0.02em] text-read-muted uppercase ${className}`}>{children}</p>;
}

function LockBadge() {
  return (
    <span aria-hidden data-lock className="absolute -top-2 -right-2 flex size-[18px] items-center justify-center rounded-full bg-read-ink text-read-panel">
      <Lock size={10} strokeWidth={2.25} />
    </span>
  );
}

/** A theme as a swatch of its own page and ink (B8), with a lock when it is Supporter's. */
function ThemeSwatch({
  theme,
  name,
  checked,
  locked,
  lockedLabel,
  onPick,
}: {
  theme: ReaderTheme;
  name: string;
  checked: boolean;
  locked: boolean;
  lockedLabel: string;
  onPick: () => void;
}) {
  // A community build has no palette for Supporter's themes: a plain swatch, still locked.
  const palette = paletteOf(theme);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={locked ? lockedLabel : name}
      data-reader-theme={theme}
      data-locked={locked || undefined}
      onClick={onPick}
      style={palette ? { background: palette.read, color: palette.ink } : undefined}
      className={`read-serif relative h-10 rounded-lg text-[13px] ${palette ? "" : "bg-read-well text-read-muted"} ${checked ? "border-2 border-accent" : "border border-read-border"}`}
    >
      {name}
      {locked && <LockBadge />}
    </button>
  );
}

/** The segmented control of the panel, in the reading theme; a locked segment shows its lock. */
function Segments<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; locked?: boolean; lockedLabel?: string; font?: "serif" | "sans" }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="mt-2 flex gap-0.5 rounded-lg bg-read-well p-[3px]">
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.locked ? option.lockedLabel : undefined}
            data-locked={option.locked || undefined}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              const at = options.findIndex((o) => o.value === value);
              const next = options[(at + (e.key === "ArrowRight" ? 1 : -1) + options.length) % options.length];
              // Arrows never land on a lock: that opens a dialog.
              if (next.locked) return;
              onChange(next.value);
              (e.currentTarget.parentElement?.children[options.indexOf(next)] as HTMLElement)?.focus();
            }}
            className={`relative h-[26px] min-w-0 flex-1 truncate rounded-md px-1.5 text-[13px] transition-[background-color,color] duration-150 ${option.font === "serif" ? "read-serif" : ""} ${checked ? "bg-read-raised font-medium text-read-ink shadow-active" : "text-read-muted hover:text-read-ink"}`}
          >
            {option.label}
            {option.locked && (
              <span aria-hidden data-lock className="absolute top-0.5 right-0.5 text-read-muted">
                <Lock size={9} strokeWidth={2.25} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
