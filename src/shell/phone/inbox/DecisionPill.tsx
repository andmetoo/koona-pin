import { useLayoutEffect, useRef } from "react";
import { BookOpen, Check, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { glass } from "../ui/Glass";
import { PhIcon } from "../ui/icons";
import type { Toward } from "./useSwipe";

/**
 * The decision pill (doc/mobile-design.md; frames I1, I2, Components board): a flat chrome-glass
 * slab 353×60, Trash | Reading | Keep. Keep is the primary, a flat accent capsule 38 % wide;
 * Trash and Reading are transparent with icons, a pressed one a flat well pill. While a card is
 * dragged toward Trash, Trash shows pressed and Keep steps back to transparent with a hairline
 * and an accent label. Trash is never red. The segments are flat: no glass on glass.
 *
 * A label that does not fit beside its icon (a longer language, a larger font size) puts every
 * label under its icon (`data-stacked`), in the same 60 as long as the text allows; from the first
 * accessibility size (`data-text-large` on the shell's root) they always are (Dynamic Type).
 */
export function DecisionPill({
  toward,
  disabled,
  onTrash,
  onReading,
  onKeep,
}: {
  toward: Toward;
  disabled: boolean;
  onTrash: () => void;
  onReading: () => void;
  onKeep: () => void;
}) {
  const { t } = useTranslation();
  const pill = useRef<HTMLDivElement>(null);
  const labels = [t("phone.inbox.trash"), t("phone.inbox.reading"), t("phone.inbox.keep")];
  useLayoutEffect(() => {
    const el = pill.current;
    if (!el) return;
    // Measured beside the icons, before the frame is painted: stacked or not, the same answer.
    const fit = () => {
      el.removeAttribute("data-stacked");
      const cut = [...el.querySelectorAll<HTMLElement>(".inb-seg-label")].some((label) => label.scrollWidth > label.clientWidth + 0.5);
      if (cut) el.setAttribute("data-stacked", "");
    };
    fit();
    // The pill's width, and the labels' height when the system's font size changes.
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    for (const label of el.querySelectorAll(".inb-seg-label")) watch.observe(label);
    return () => watch.disconnect();
  }, [labels.join("\n")]);
  return (
    <div ref={pill} role="group" aria-label={t("phone.inbox.decide")} className={`inb-decide ${glass()}`} data-toward={toward ?? undefined} data-decision-pill>
      <button type="button" className="inb-seg" data-pressed={toward === "trash" || undefined} disabled={disabled} onClick={onTrash}>
        <PhIcon icon={Trash2} />
        <span className="inb-seg-label">{labels[0]}</span>
      </button>
      <span className="inb-seg-rule" aria-hidden="true" />
      <button type="button" className="inb-seg" disabled={disabled} onClick={onReading}>
        <PhIcon icon={BookOpen} />
        <span className="inb-seg-label">{labels[1]}</span>
      </button>
      <button type="button" className="inb-seg inb-keep" data-recede={toward === "trash" || undefined} disabled={disabled} onClick={onKeep}>
        <PhIcon icon={Check} />
        <span className="inb-seg-label">{labels[2]}</span>
      </button>
    </div>
  );
}
