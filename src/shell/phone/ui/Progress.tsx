import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

/**
 * Progress (doc/mobile-design.md): a 6 pt pill track with an accent → accent-hi fill. `label`
 * shows "5 of 12" under it; a screen that puts the count beside its title passes false.
 */
export function Progress({ done, total, label = true, className = "" }: { done: number; total: number; label?: boolean; className?: string }) {
  const { t } = useTranslation();
  const value = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  const text = t("phone.kit.progress", { done, total });
  return (
    <div className={className}>
      <div className="ph-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-valuetext={text}>
        <div className="ph-progress-fill" style={{ "--value": value } as CSSProperties} />
      </div>
      {label && <p className="ph-meta mt-2">{text}</p>}
    </div>
  );
}
