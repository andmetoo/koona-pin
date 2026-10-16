import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, LucideIcon } from "lucide-react";
import { Icon } from "../icons";
import { isMac, shortcut } from "../../services/keys";

export interface MenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Key shown on the right, 11 px. */
  keys?: string;
  /** Second line under the label. */
  description?: string;
  count?: number | string;
  dot?: string;
  checked?: boolean;
  /** One of a choice (the list's order, NP-114): a screen reader hears it as chosen or not. */
  radio?: boolean;
  disabled?: boolean;
  /** Why a disabled item is not available yet. */
  disabledHint?: string;
  onSelect?: () => void;
  submenu?: MenuEntry[];
}
export type MenuEntry = MenuItem | { heading: string } | "separator";
export type CloseReason = "escape" | "selected" | "outside";

const isItem = (entry: MenuEntry): entry is MenuItem => typeof entry === "object" && "id" in entry;

/**
 * A menu at a point or next to a rectangle (frames 06 and 15): arrows move,
 * Enter selects, → opens a submenu, ← and Escape close a level, focus returns
 * to where it came from.
 */
export function Menu({
  entries,
  anchor,
  align = "end",
  label,
  width = 264,
  onClose,
  nested = false,
  trigger,
}: {
  entries: MenuEntry[];
  anchor: DOMRect | { x: number; y: number };
  align?: "start" | "end";
  label: string;
  width?: number;
  /** `escape` returns focus to where the menu was opened from. */
  onClose: (reason: CloseReason) => void;
  nested?: boolean;
  /** The button that opened the menu: a press on it is not «outside», so its click can close the menu. */
  trigger?: Element | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState({ left: -9999, top: -9999 });
  const [open, setOpen] = useState<{ id: string; rect: DOMRect } | null>(null);
  const items = entries.filter(isItem);

  useLayoutEffect(() => {
    // Once: a repeated effect (StrictMode) would see the focused menu item.
    if (!returnTo.current) returnTo.current = document.activeElement as HTMLElement | null;
    const menu = ref.current!.getBoundingClientRect();
    const rect = "width" in anchor ? anchor : new DOMRect(anchor.x, anchor.y, 0, 0);
    let left = nested ? rect.right + 4 : align === "end" ? rect.right - width : rect.left;
    let top = nested ? rect.top - 6 : rect.bottom + 6;
    if (left + width > innerWidth - 8) left = nested ? rect.left - width - 4 : innerWidth - width - 8;
    if (top + menu.height > innerHeight - 8) top = Math.max(8, (nested ? rect.bottom + 6 : rect.top - 6) - menu.height);
    setPosition({ left: Math.max(8, left), top });
    focusItem(0);
  }, []);

  useEffect(() => {
    if (nested) return;
    const outside = (e: PointerEvent) => {
      if (trigger?.contains(e.target as Node)) return;
      if (!(e.target as Element).closest?.("[data-menu]")) onClose("outside");
    };
    const blur = () => onClose("outside");
    document.addEventListener("pointerdown", outside);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const buttons = () => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem], [role=menuitemradio]") ?? []);
  function focusItem(index: number) {
    const all = buttons();
    if (!all.length) return;
    all[(index + all.length) % all.length].focus();
  }
  const close = (reason: CloseReason) => {
    onClose(reason);
    if (reason !== "outside") returnTo.current?.focus();
  };
  const select = (item: MenuItem, element: HTMLElement) => {
    if (item.disabled) return;
    if (item.submenu) {
      setOpen({ id: item.id, rect: element.getBoundingClientRect() });
      return;
    }
    close("selected");
    item.onSelect?.();
  };

  const menu = (
    <div
      ref={ref}
      data-menu
      role="menu"
      aria-label={label}
      style={{ left: position.left, top: position.top, width }}
      className={`menu-glass fixed z-50 rounded-[13px] ${nested ? "" : "animate-appear"} p-1.5 text-sm text-ink`}
      onKeyDown={(e) => {
        const all = buttons();
        const index = all.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "ArrowDown") focusItem(index + 1);
        else if (e.key === "ArrowUp") focusItem(index - 1);
        else if (e.key === "Home") focusItem(0);
        else if (e.key === "End") focusItem(-1);
        else if (e.key === "Escape" || (nested && e.key === "ArrowLeft")) close("escape");
        else if (e.key === "Tab") close("outside");
        else if (e.key === "ArrowRight" && index >= 0) {
          const item = items[index];
          if (item?.submenu && !item.disabled) setOpen({ id: item.id, rect: all[index].getBoundingClientRect() });
        } else {
          // The keys shown on the right select their item; Enter stays with the focused one.
          // With the platform's modifier the key is written as the item shows it: ⌘C on a Mac, Ctrl C elsewhere (#319).
          const key = e.key === "Delete" ? "Del" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
          const mod = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
          const pressed = mod ? shortcut(key) : e.ctrlKey || e.metaKey ? null : key;
          const own = (e.target as Element).closest("[role=menu]") === ref.current;
          const match = own && pressed !== null && pressed !== "Enter" && items.findIndex((item) => item.keys === pressed && !item.disabled);
          if (match === false || match < 0) return;
          select(items[match], all[match]);
        }
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {entries.map((entry, i) =>
        entry === "separator" ? (
          <div key={`s${i}`} role="separator" className="mx-[9px] my-[5px] h-px bg-line" />
        ) : !isItem(entry) ? (
          <div key={`h${i}`} className="px-[9px] pt-1.5 pb-1 text-2xs font-semibold tracking-[0.08em] uppercase text-subtle">
            {entry.heading}
          </div>
        ) : (
          <button
            key={entry.id}
            type="button"
            role={entry.radio ? "menuitemradio" : "menuitem"}
            aria-checked={entry.radio ? !!entry.checked : undefined}
            aria-disabled={entry.disabled || undefined}
            aria-haspopup={entry.submenu ? "menu" : undefined}
            aria-expanded={entry.submenu ? open?.id === entry.id : undefined}
            title={entry.disabled ? entry.disabledHint : undefined}
            tabIndex={-1}
            onClick={(e) => select(entry, e.currentTarget)}
            onPointerEnter={(e) => {
              if (entry.submenu && !entry.disabled) setOpen({ id: entry.id, rect: e.currentTarget.getBoundingClientRect() });
              else if (open) setOpen(null);
            }}
            className={`flex min-h-[30px] w-full items-center gap-2.5 rounded-lg px-[9px] py-1.5 text-left outline-none transition-colors duration-100 focus-visible:bg-hover hover:bg-hover ${entry.disabled ? "text-subtle" : ""}`}
          >
            {entry.dot ? (
              <span className="flex size-4 items-center justify-center">
                <span className="size-2 rounded-full" style={{ background: entry.dot }} />
              </span>
            ) : entry.icon ? (
              <Icon icon={entry.icon} className={entry.disabled ? "text-faint" : "text-icon"} />
            ) : null}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{entry.label}</span>
              {entry.description && <span className="block text-xs text-subtle">{entry.description}</span>}
            </span>
            {entry.checked && <Icon icon={Check} className="text-accent" />}
            {entry.count !== undefined && <span className="text-2xs text-subtle">{entry.count}</span>}
            {entry.keys && <span className="text-2xs text-subtle">{entry.keys}</span>}
            {entry.submenu && <Icon icon={ChevronRight} size={14} className="text-subtle" />}
          </button>
        ),
      )}
      {open &&
        (() => {
          const parent = items.find((item) => item.id === open.id);
          return parent?.submenu ? (
            <Menu
              nested
              entries={parent.submenu}
              anchor={open.rect}
              label={parent.label}
              width={232}
              onClose={(reason) => {
                setOpen(null);
                // Picking in the submenu or leaving it closes the whole menu.
                if (reason !== "escape") close(reason);
              }}
            />
          ) : null;
        })()}
    </div>
  );
  // A submenu too goes to <body>: inside the glass of its parent it would be cut to the parent's
  // backdrop (a backdrop-filter starts a backdrop root) and placed from it, not from the window.
  return createPortal(menu, document.body);
}
