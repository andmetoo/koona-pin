import { type ReactNode, useEffect, useState } from "react";
import { Check, type LucideIcon } from "lucide-react";
import { api } from "../../../services/api";
import type { DataSummary } from "../../../types";
import { PhIcon } from "../ui/icons";

/** The running app's version, once read; empty until then. */
export function useVersion(): string {
  const [version, setVersion] = useState("");
  useEffect(() => {
    void api.getVersion().then(setVersion).catch(() => {});
  }, []);
  return version;
}

/** The library's backups (Settings → Sync and backups on the desktop), read again after a restore (`dataVersion`). */
export function useDataSummary(dataVersion: number) {
  const [data, setData] = useState<DataSummary | null>(null);
  useEffect(() => {
    void api.getDataSummary().then(setData).catch(() => {});
  }, [dataVersion]);
  return [data, setData] as const;
}

/**
 * A card of its own on the page (FL3's "Controls"): opaque paper r 22 with a title, a caption and
 * what it holds — a switch, a stepper. Content, so never glass.
 */
export function SettingsCard({ title, caption, children, footnote }: { title?: ReactNode; caption?: ReactNode; children?: ReactNode; footnote?: ReactNode }) {
  return (
    <div className="ys-card ys-settings-card">
      {title && <h3 className="ph-headline">{title}</h3>}
      {caption && <p className="ys-caption">{caption}</p>}
      {children}
      {footnote && <p className="ph-meta">{footnote}</p>}
    </div>
  );
}

/**
 * One option of a single choice on a shelf (a language, the reader's theme): the row is the radio,
 * its tick an accent disc on the right as the kit's round checkbox draws it. The kit's `ShelfRow`
 * takes no role, so this row is its own.
 */
export function ChoiceRow({
  label,
  detail,
  icon,
  checked,
  onSelect,
}: {
  label: ReactNode;
  detail?: ReactNode;
  icon?: LucideIcon;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" role="radio" aria-checked={checked} className="ph-shelf-row ys-choice" onClick={onSelect}>
      <span className="ph-shelf-text">
        <span className="ph-shelf-title">{label}</span>
      </span>
      {detail && <span className="ph-shelf-detail">{detail}</span>}
      {icon && <PhIcon icon={icon} at="field" className="shrink-0 text-[var(--ph-meta)]" />}
      <span className="ph-checkbox" aria-checked={checked} aria-hidden="true">
        {checked && <Check size={14} strokeWidth={2.5} absoluteStrokeWidth />}
      </span>
    </button>
  );
}
