import { type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, useId } from "react";
import { Check, CircleX, type LucideIcon, Search, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PhIcon } from "./icons";

/**
 * A chip (doc/mobile-design.md, Chips): a pill 36 tall, 40 `large` (triage). At rest paper with a
 * hairline; `active` an ink fill (the filter on); `dot` a collection's colour; `suggested` that
 * colour as its edge and a soft glow of it, with the accent-soft "Suggested" tag. Opaque: chips
 * are content, never glass.
 */
export function Chip({
  active = false,
  large = false,
  dot,
  glyph,
  suggested = false,
  icon,
  className = "",
  style,
  children,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  active?: boolean;
  large?: boolean;
  /** A collection's colour (services/collections.ts `collectionColor`). */
  dot?: string;
  /** A collection's own mark (CollectionGlyph: icon, emoji or dot) in place of the plain dot (2.19.0). */
  glyph?: ReactNode;
  suggested?: boolean;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-pressed={active}
      data-active={active || undefined}
      data-size={large ? "large" : undefined}
      data-suggested={(suggested && !!dot) || undefined}
      className={`ph-chip ph-hit ${className}`}
      style={dot ? ({ ...style, "--dot": dot } as CSSProperties) : style}
      {...rest}
    >
      {icon && <PhIcon icon={icon} at="chip" />}
      {glyph ?? (dot && <span className="ph-chip-dot" aria-hidden="true" />)}
      {children}
      {suggested && dot && (
        <span className="ph-chip-tag">
          <PhIcon icon={Sparkles} size={12} strokeWidth={1.5} />
          {t("phone.kit.suggested")}
        </span>
      )}
    </button>
  );
}

/**
 * A segmented switch: a well trough with a raised paper thumb that slides to the chosen option.
 * Options are labels or icons (an icon option needs `label` for screen readers).
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className = "",
}: {
  value: T;
  options: { value: T; label: string; icon?: LucideIcon }[];
  onChange: (value: T) => void;
  /** The switch's name for screen readers. */
  label: string;
  className?: string;
}) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div role="radiogroup" aria-label={label} className={`ph-segmented ${className}`} style={{ "--count": options.length, "--index": index } as CSSProperties}>
      <span className="ph-segmented-thumb" aria-hidden="true" />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-label={o.icon ? o.label : undefined}
          className="ph-segment ph-hit"
          onClick={() => o.value !== value && onChange(o.value)}
        >
          {o.icon ? <PhIcon icon={o.icon} at="field" /> : o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The search field: a pill 44 tall, a well at rest; focused, paper with an accent edge and halo.
 * A clear button shows while it holds text.
 */
export function SearchField({
  value,
  onChange,
  placeholder,
  className = "",
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  return (
    <label className={`ph-search ${className}`}>
      <PhIcon icon={Search} at="field" />
      <input type="search" enterKeyHint="search" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} {...rest} />
      {value && (
        <button type="button" className="ph-circle ph-hit" style={{ "--ph-circle": "32px" } as CSSProperties} aria-label={t("phone.kit.clear")} onClick={() => onChange("")}>
          <PhIcon icon={CircleX} at="field" />
        </button>
      )}
    </label>
  );
}

/**
 * A field with its label inside (caption): a single-line pill 56 tall, or `multiline` with r 20.
 * Focused like the search field.
 */
export function Field({
  label,
  multiline = false,
  value,
  onChange,
  className = "",
  ...rest
}: {
  label: string;
  multiline?: boolean;
  value: string;
  onChange: (value: string) => void;
  className?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement> & TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">) {
  const id = useId();
  return (
    <div className={`ph-field ${className}`} data-multiline={multiline || undefined}>
      <label htmlFor={id} className="ph-field-label">
        {label}
      </label>
      {multiline ? (
        <textarea id={id} value={value} rows={2} onChange={(e) => onChange(e.target.value)} {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)} />
      ) : (
        <input id={id} value={value} onChange={(e) => onChange(e.target.value)} {...(rest as InputHTMLAttributes<HTMLInputElement>)} />
      )}
    </div>
  );
}

/** A switch 52 × 32. */
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="ph-toggle ph-hit" onClick={() => onChange(!checked)} />
  );
}

/** A round checkbox 22: an empty ring, or an accent disc with a tick. */
export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label} className="ph-checkbox ph-hit" onClick={() => onChange(!checked)}>
      {checked && <Check size={14} strokeWidth={2.5} absoluteStrokeWidth aria-hidden="true" />}
    </button>
  );
}
