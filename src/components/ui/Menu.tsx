import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, LucideIcon, Search } from "lucide-react";
import { Icon } from "../icons";
import { isMac, shortcut } from "../../services/keys";
import { layerFor, windowBox } from "./place";

export interface MenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Drawn in place of `icon` or `dot`: a collection's own mark (2.19.0). */
  leading?: ReactNode;
  /** Levels of a tree, 16 px each (2.19.0): collections inside collections. */
  indent?: number;
  /** Muted before the label: the path of a collection found by a search, «Development › Web › » (2.19.0). */
  prefix?: string;
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
  /** The submenu's width; 232 px by default. */
  submenuWidth?: number;
}
/**
 * A field on top of a long list (2.19.0, frame N7): while it holds a query,
 * `results` stand in place of every entry after it.
 */
export interface MenuSearch {
  search: { label: string; results: (query: string) => MenuEntry[] };
}
export type MenuEntry = MenuItem | { heading: string } | { hint: ReactNode } | MenuSearch | "separator";
export type CloseReason = "escape" | "selected" | "outside";

const isItem = (entry: MenuEntry): entry is MenuItem => typeof entry === "object" && "id" in entry;
const isSearch = (entry: MenuEntry): entry is MenuSearch => typeof entry === "object" && "search" in entry;

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
  const field = useRef<HTMLInputElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState({ left: -9999, top: -9999 });
  const [open, setOpen] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [query, setQuery] = useState("");
  const searchAt = entries.findIndex(isSearch);
  const search = searchAt >= 0 ? (entries[searchAt] as MenuSearch) : null;
  const shown = search && query.trim() ? [...entries.slice(0, searchAt + 1), ...search.search.results(query)] : entries;
  const items = shown.filter(isItem);

  useLayoutEffect(() => {
    // Once: a repeated effect (StrictMode) would see the focused menu item.
    if (!returnTo.current) returnTo.current = document.activeElement as HTMLElement | null;
    const menu = ref.current!.getBoundingClientRect();
    const rect = "width" in anchor ? anchor : new DOMRect(anchor.x, anchor.y, 0, 0);
    const { left: minLeft, right: maxRight, top: minTop, bottom: maxBottom } = windowBox();
    let left = nested ? rect.right + 4 : align === "end" ? rect.right - width : rect.left;
    let top = nested ? rect.top - 6 : rect.bottom + 6;
    if (left + width > maxRight) left = nested ? rect.left - width - 4 : maxRight - width;
    if (top + menu.height > maxBottom) top = Math.max(minTop, (nested ? rect.bottom + 6 : rect.top - 6) - menu.height);
    setPosition({ left: Math.max(minLeft, left), top });
    // A list with a search field starts in the field: typing narrows it at once.
    if (field.current) field.current.focus();
    else focusItem(0);
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

  const buttons = () =>
    Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(":scope > [role=menuitem], :scope > [role=menuitemradio]") ?? []);
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
        if (e.target === field.current) {
          // In the field the keys type; the arrows go down to the list, Enter takes the first
          // found: with nothing typed it picks nothing, the field having focus as the menu opens.
          if (e.key === "ArrowDown") focusItem(0);
          else if (e.key === "ArrowUp") focusItem(-1);
          else if (e.key === "Enter") {
            if (query.trim() && items[0] && all[0]) select(items[0], all[0]);
          }
          else if (e.key === "Escape" || e.key === "Tab") close(e.key === "Tab" ? "outside" : "escape");
          else {
            // Nothing typed yet: the keys shown on the right still pick their item (1–9).
            const match = query || e.ctrlKey || e.metaKey || e.altKey ? -1 : items.findIndex((item) => item.keys === e.key && !item.disabled);
            if (match < 0 || !all[match]) return e.stopPropagation();
            select(items[match], all[match]);
          }
        } else if (e.key === "ArrowDown") focusItem(index + 1);
        else if (e.key === "ArrowUp") {
          if (index === 0 && field.current) field.current.focus();
          else focusItem(index - 1);
        } else if (e.key === "Home") focusItem(0);
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
          if (match === false || match < 0) {
            // Letters typed in a list with a field go to the field (2.19.0).
            if (own && field.current && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) field.current.focus();
            return;
          }
          select(items[match], all[match]);
        }
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {shown.map((entry, i) =>
        entry === "separator" ? (
          <div key={`s${i}`} role="separator" className="mx-[9px] my-[5px] h-px bg-line" />
        ) : isSearch(entry) ? (
          <label key="search" className="mb-1 flex h-[30px] items-center gap-2 rounded-lg border border-border bg-card px-2 focus-within:border-accent">
            <Icon icon={Search} size={14} className="text-subtle" />
            <input
              ref={field}
              type="search"
              aria-label={entry.search.label}
              placeholder={entry.search.label}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(null);
              }}
              className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-subtle [&::-webkit-search-cancel-button]:appearance-none"
            />
          </label>
        ) : "hint" in entry ? (
          <div key={`n${i}`} className="px-[9px] pt-1.5 pb-1 text-2xs text-subtle">
            {entry.hint}
          </div>
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
            // The pointer's way in opened the submenu and focused its first stop (its search field): the
            // press of the click must not take the focus back to this item.
            onMouseDown={entry.submenu ? (e) => e.preventDefault() : undefined}
            onPointerEnter={(e) => {
              if (entry.submenu && !entry.disabled) setOpen({ id: entry.id, rect: e.currentTarget.getBoundingClientRect() });
              else if (open) setOpen(null);
            }}
            style={entry.indent ? { paddingLeft: 9 + 16 * entry.indent } : undefined}
            className={`flex min-h-[30px] w-full items-center gap-2.5 rounded-lg px-[9px] py-1.5 text-left outline-none transition-colors duration-100 focus-visible:bg-hover hover:bg-hover ${entry.disabled ? "text-subtle" : ""}`}
          >
            {entry.leading ? (
              entry.leading
            ) : entry.dot ? (
              <span className="flex size-4 items-center justify-center">
                <span className="size-2 rounded-full" style={{ background: entry.dot }} />
              </span>
            ) : entry.icon ? (
              <Icon icon={entry.icon} className={entry.disabled ? "text-faint" : "text-icon"} />
            ) : null}
            <span className="min-w-0 flex-1">
              <span className="block truncate">
                {entry.prefix && <span className="text-subtle">{entry.prefix}</span>}
                {entry.label}
              </span>
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
              width={parent.submenuWidth ?? 232}
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
  // Every menu goes to the top: a submenu inside the glass of its parent would be cut to the parent's
  // backdrop (a backdrop-filter starts a backdrop root) and placed from it, not from the window.
  // Opened from a modal dialog (the reading sheet's «Saved offline», NP-126), it lives in that
  // dialog: the top layer would cover anything in the body. A submenu follows its parent there.
  return createPortal(menu, nested ? (document.querySelector<HTMLElement>("dialog[open]") ?? document.body) : layerFor(trigger));
}
