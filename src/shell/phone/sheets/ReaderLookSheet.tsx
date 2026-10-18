import "../reader/reader.css";
import type { CSSProperties } from "react";
import { Lock } from "lucide-react";
import { usePhone } from "../PhoneContext";
import { stepSize } from "../reader/look";
import { CircleButton } from "../ui/buttons";
import { Segmented } from "../ui/controls";
import { Sheet, useCloseSheet } from "../ui/Sheet";
import { FONTS, FREE_THEMES, paletteOf, type ReaderChoice, type ReaderFont, SUPPORTER_THEMES, themeLocked } from "../../../services/readerLook";

export type ReaderLookSheetProps = Record<string, never>;

/**
 * "Aa" of the reader and the post view (NP-124's panel as a phone sheet): the text size in steps,
 * the theme — "Match the app" (the phone's own paper, light or dark) or one of the reader's
 * themes, Paper and Sepia locked without Supporter (picked, the Supporter dialog opens and the
 * theme waits for the plan) — and the font. The desktop's column width is left out: a phone's
 * column is its screen.
 */
export function ReaderLookSheet(_: { props: ReaderLookSheetProps }) {
  const { app } = usePhone();
  const { t, readerLook } = app;
  const close = useCloseSheet();
  const { choice, unlocked } = readerLook;
  const change = (next: Partial<ReaderChoice>) => readerLook.setChoice({ ...choice, ...next });
  const supporter = () => {
    close();
    app.setSurface("supporter");
  };
  const pick = (theme: ReaderChoice["theme"]) => {
    if (theme !== "auto" && themeLocked(theme, unlocked)) {
      readerLook.wish({ theme });
      return supporter();
    }
    change({ theme });
  };
  const smaller = stepSize(choice.size, -1);
  const larger = stepSize(choice.size, 1);
  const anyLocked = SUPPORTER_THEMES.some((theme) => themeLocked(theme, unlocked));
  const themes: ReaderChoice["theme"][] = ["auto", ...FREE_THEMES, ...SUPPORTER_THEMES];
  return (
    <Sheet label={t("readerAa.label")} title={t("readerAa.label")}>
      <section className="rd-look-group" aria-label={t("readerAa.size")}>
        <h3 className="rd-look-label">{t("readerAa.size")}</h3>
        <div className="rd-look-size">
          <CircleButton kind="flat" size={44} label={t("phone.reader.smaller")} disabled={smaller === choice.size} onClick={() => change({ size: smaller })}>
            <span style={{ fontSize: 14 }}>A</span>
          </CircleButton>
          <output aria-live="polite">{t("readerAa.sizeValue", { size: choice.size + 1 })}</output>
          <CircleButton kind="flat" size={44} label={t("phone.reader.larger")} disabled={larger === choice.size} onClick={() => change({ size: larger })}>
            <span style={{ fontSize: 21 }}>A</span>
          </CircleButton>
        </div>
      </section>
      <section className="rd-look-group">
        <h3 className="rd-look-label">{t("readerAa.theme")}</h3>
        <div role="radiogroup" aria-label={t("readerAa.theme")} className="rd-look-themes">
          {themes.map((theme) => {
            const palette = theme === "auto" ? null : paletteOf(theme);
            const locked = theme !== "auto" && themeLocked(theme, unlocked);
            const name = theme === "auto" ? t("phone.reader.themeAuto") : t(`readerAa.themes.${theme}`);
            return (
              <button
                key={theme}
                type="button"
                role="radio"
                aria-checked={choice.theme === theme}
                aria-label={locked ? t("readerAa.locked", { name }) : name}
                data-reader-theme={theme}
                className="rd-look-theme ph-hit"
                style={palette ? ({ "--swatch": palette.read, "--swatch-ink": palette.ink } as CSSProperties) : undefined}
                onClick={() => pick(theme)}
              >
                {name}
                {locked && (
                  <span className="rd-look-lock" aria-hidden="true">
                    <Lock size={11} strokeWidth={2.25} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {anyLocked && (
          <p className="rd-look-hint">
            {t("readerAa.supporterHint")}{" "}
            <button type="button" onClick={supporter}>
              {t("readerAa.supporterLink")}
            </button>
          </p>
        )}
      </section>
      <section className="rd-look-group">
        <h3 className="rd-look-label">{t("readerAa.font")}</h3>
        <Segmented<ReaderFont>
          label={t("readerAa.font")}
          value={choice.font}
          options={FONTS.map((font) => ({ value: font, label: t(`readerAa.fonts.${font}`) }))}
          onChange={(font) => change({ font })}
        />
      </section>
    </Sheet>
  );
}
