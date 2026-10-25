import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Smile } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Collection } from "../../types";
import { COLLECTION_ICONS, collectionTint, iconKind, PALETTE, typedEmoji } from "../../services/collections";
import { COLLECTION_GLYPHS, CollectionIcon } from "../ui/CollectionIcon";
import { Icon } from "../icons";
import { Button } from "../ui/Button";

/**
 * «Icon and colour» (2.19.0, frame N5): the collection's name, five colours,
 * forty icons, a field for an emoji and «Use a dot». Every pick is written at
 * once; «Done», Esc or a press outside closes it.
 */
export function CollectionStyle({
  collection,
  anchor,
  onStyle,
  onClose,
}: {
  collection: Collection;
  anchor: DOMRect;
  onStyle: (color: string | null, icon: string | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState({ left: -9999, top: -9999 });
  const kind = iconKind(collection.icon);
  /** The saved emoji, from the collection itself: an icon or a dot picked since clears the field (2.19.0). */
  const saved = kind?.kind === "emoji" ? kind.text : "";
  /** What is typed that is no emoji yet (an IME's word, a letter); dropped once the icon changes. */
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [collection.icon]);
  const tint = collectionTint(collection);
  const chosenColor = (PALETTE as readonly string[]).includes(collection.color ?? "") ? collection.color : null;

  useLayoutEffect(() => {
    if (!returnTo.current) returnTo.current = document.activeElement as HTMLElement | null;
    const box = ref.current!.getBoundingClientRect();
    // Beside the row, like a submenu; above the bottom of the window.
    let left = anchor.right + 8;
    if (left + box.width > innerWidth - 8) left = Math.max(8, anchor.left - box.width - 8);
    const top = Math.max(8, Math.min(anchor.top - 12, innerHeight - box.height - 8));
    setPosition({ left, top });
    ref.current!.querySelector<HTMLElement>("[aria-checked=true]")?.focus();
  }, []);
  const close = () => {
    onClose();
    returnTo.current?.focus();
  };
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);

  /** Arrows move within a group of choices (radio-like); Tab goes to the next group. */
  const arrows = (columns: number) => (e: React.KeyboardEvent<HTMLDivElement>) => {
    const all = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[role=radio]"));
    const at = all.indexOf(document.activeElement as HTMLElement);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[e.key];
    if (at < 0 || !step) return;
    e.preventDefault();
    all[Math.min(all.length - 1, Math.max(0, at + step))].focus();
  };

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={t("collectionStyle.label", { name: collection.name })}
      data-collection-style
      style={{ left: position.left, top: position.top }}
      className="menu-glass fixed z-50 flex w-[288px] animate-appear flex-col gap-3 rounded-[13px] p-3.5 text-sm text-ink"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
    >
      <div className="flex items-center gap-2">
        <CollectionIcon collection={collection} />
        <span className="min-w-0 flex-1 truncate font-semibold">{collection.name}</span>
        <span className="text-xs text-subtle">{t("collectionStyle.title")}</span>
      </div>
      <div role="radiogroup" aria-label={t("collectionStyle.colour")} className="flex gap-2" onKeyDown={arrows(1)}>
        {PALETTE.map((name) => {
          const on = chosenColor === name;
          return (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={t(`collectionStyle.colours.${name}`)}
              title={t(`collectionStyle.colours.${name}`)}
              tabIndex={on || (!chosenColor && name === PALETTE[0]) ? 0 : -1}
              onClick={() => onStyle(name, kind ? collection.icon : null)}
              className={`flex size-[26px] items-center justify-center rounded-full ${on ? "shadow-[0_0_0_2px_var(--np-card),0_0_0_3.5px_var(--np-ink)]" : ""}`}
              style={{ background: `var(--np-${name})` }}
            />
          );
        })}
      </div>
      <div role="radiogroup" aria-label={t("collectionStyle.icon")} className="grid grid-cols-8 gap-0.5" onKeyDown={arrows(8)}>
        {COLLECTION_ICONS.map((name, i) => {
          const on = kind?.kind === "lucide" && kind.name === name;
          return (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={name.replace(/-\d+$/, "").replace(/-/g, " ")}
              tabIndex={on || (kind?.kind !== "lucide" && i === 0) ? 0 : -1}
              onClick={() => onStyle(chosenColor, name)}
              className={`flex size-8 items-center justify-center rounded-lg transition-colors duration-100 hover:bg-hover ${on ? "bg-hover shadow-[inset_0_0_0_1.5px_var(--np-accent)]" : "text-icon"}`}
              style={on ? { color: tint } : undefined}
            >
              <Icon icon={COLLECTION_GLYPHS[name]} />
            </button>
          );
        })}
      </div>
      <div className="h-px bg-line" />
      <label className="flex h-[34px] items-center gap-2 rounded-lg border border-border bg-card px-2.5 focus-within:border-accent">
        <Icon icon={Smile} className="text-subtle" />
        <input
          value={draft ?? saved}
          aria-label={t("collectionStyle.emoji")}
          placeholder={t("collectionStyle.emoji")}
          onChange={(e) => {
            // The newest emoji replaces the saved one, wherever it was typed or pasted; an emptied
            // field takes it off (the dot); other text stays as typed, an IME's word on its way.
            const text = e.target.value;
            const one = typedEmoji(text, saved || null);
            if (one && one !== saved) onStyle(chosenColor, one);
            else if (saved && !text.trim()) onStyle(chosenColor, null);
            else setDraft(text === saved ? null : text);
          }}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-subtle"
        />
      </label>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => onStyle(collection.color, null)}
          className="rounded-sm px-1 py-0.5 text-sm text-ink hover:text-accent disabled:text-subtle"
          disabled={!kind}
        >
          {t("collectionStyle.dot")}
        </button>
        <Button variant="primary" onClick={close}>
          {t("common.done")}
        </Button>
      </div>
    </div>,
    document.body,
  );
}
