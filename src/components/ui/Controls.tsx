import { ReactNode, useId, useLayoutEffect, useRef } from "react";

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
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 disabled:opacity-45 ${checked ? "bg-accent" : "bg-border dark:bg-white/[14%]"}`}
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

/**
 * The content of every tab in one grid cell: the tallest sets the height, so a dialog with tabs keeps
 * its size and its place on screen when the tab changes, in any language. Only the chosen tab is
 * seen, read and reached with the keyboard.
 */
export function TabPanels<T extends string>({
  value,
  tabs,
  children,
}: {
  value: T;
  tabs: readonly T[];
  children: (tab: T) => ReactNode;
}) {
  return (
    <div className="grid">
      {tabs.map((tab) => {
        const active = tab === value;
        return (
          <div
            key={tab}
            data-tab-panel={tab}
            data-active={active || undefined}
            aria-hidden={!active || undefined}
            inert={!active}
            className={`flex min-w-0 flex-col gap-4 [grid-area:1/1] ${active ? "" : "invisible"}`}
          >
            {children(tab)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The states of a dialog in one grid cell (NP-118): each state is laid out once more, unseen, with
 * its largest content, and the tallest sets the height. So the dialog opens at its final size and its
 * title and buttons stay in place until it closes; the state shown takes that height, its footer at
 * the bottom, a long report scrolling inside. Only the shown state is seen, read and reached with the
 * keyboard. It mounts anew on each change, so `autoFocus` in it works; without one, focus goes to it.
 */
export function StatePanels<T extends string>({
  value,
  states,
  children,
}: {
  value: T;
  states: readonly T[];
  /** `sizing` is the unseen copy: the state with its largest content, or null when it fits any height. */
  children: (state: T, sizing: boolean) => ReactNode;
}) {
  const shown = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  useLayoutEffect(() => {
    // The first state is focused by the dialog itself.
    if (!opened.current) {
      opened.current = true;
      return;
    }
    const panel = shown.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus();
  }, [value]);
  // In a window lower than the tallest state the cell gets what is left, and the state shown gives way;
  // -m-1 p-1 here and on it keep focus rings from being cut.
  return (
    <div className="-m-1 grid min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden p-1">
      {/* Takes the height of the cell without adding to it. */}
      <div
        key={value}
        ref={shown}
        tabIndex={-1}
        data-state-panel={value}
        className="-m-1 flex min-w-0 flex-col gap-4 overflow-y-auto p-1 outline-none [contain:size] [grid-area:1/1]"
      >
        {children(value, false)}
      </div>
      {states.map((state) => {
        const sizing = children(state, true);
        return (
          sizing && (
            <div key={`sizing-${state}`} aria-hidden inert className="invisible flex min-w-0 flex-col gap-4 [grid-area:1/1]">
              {sizing}
            </div>
          )
        );
      })}
    </div>
  );
}
