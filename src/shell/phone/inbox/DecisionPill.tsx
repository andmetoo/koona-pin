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
  return (
    <div role="group" aria-label={t("phone.inbox.decide")} className={`inb-decide ${glass()}`} data-toward={toward ?? undefined} data-decision-pill>
      <button type="button" className="inb-seg" data-pressed={toward === "trash" || undefined} disabled={disabled} onClick={onTrash}>
        <PhIcon icon={Trash2} />
        {t("phone.inbox.trash")}
      </button>
      <span className="inb-seg-rule" aria-hidden="true" />
      <button type="button" className="inb-seg" disabled={disabled} onClick={onReading}>
        <PhIcon icon={BookOpen} />
        {t("phone.inbox.reading")}
      </button>
      <button type="button" className="inb-seg inb-keep" data-recede={toward === "trash" || undefined} disabled={disabled} onClick={onKeep}>
        <PhIcon icon={Check} />
        {t("phone.inbox.keep")}
      </button>
    </div>
  );
}
