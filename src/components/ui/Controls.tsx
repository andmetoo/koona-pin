import { ReactNode, useId } from "react";

/** A labelled form field with an optional hint or error under it. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (id: string, describedBy?: string) => ReactNode;
}) {
  const id = useId();
  const note = error || hint;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {label}
      </label>
      {children(id, note ? `${id}-note` : undefined)}
      {note && (
        <p id={`${id}-note`} className={`text-xs ${error ? "text-danger" : "text-subtle"}`}>
          {note}
        </p>
      )}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 disabled:opacity-45 ${checked ? "bg-accent" : "bg-border"}`}
    >
      <span
        className={`absolute top-0.5 left-0 size-4 rounded-full bg-white shadow-active transition-transform duration-150 ${checked ? "translate-x-[18px]" : "translate-x-0.5"}`}
      />
    </button>
  );
}

/** Pick one of a few values; a radio group to assistive technology. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex shrink-0 gap-0.5 rounded-lg bg-secondary p-[3px]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            e.preventDefault();
            const index = options.findIndex((o) => o.value === value);
            const next = options[(index + (e.key === "ArrowRight" ? 1 : -1) + options.length) % options.length];
            onChange(next.value);
            (e.currentTarget.parentElement?.children[options.indexOf(next)] as HTMLElement)?.focus();
          }}
          tabIndex={value === option.value ? 0 : -1}
          className={`h-6 rounded-sm px-2.5 text-xs transition-[background-color,color] duration-150 ${value === option.value ? "bg-card text-ink shadow-active" : "text-muted hover:text-ink"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A coloured dot for collections and statuses. */
export function Dot({ color, className = "" }: { color: string; className?: string }) {
  return <span className={`inline-block size-2 shrink-0 rounded-full ${className}`} style={{ background: color }} />;
}
