import { forwardRef, useState } from "react";
import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { composing } from "../../services/ime";
import { shortcut } from "../../services/keys";
import { Icon } from "../icons";

/**
 * The library's search (2026-10-16): under the logo of the sidebar, or in the toolbar of a narrow
 * window, where the sidebar is a strip (`well`). One field is on screen at a time, so `Ctrl K` /
 * `⌘K` focuses whichever it is through the one ref; the query itself lives in the filters.
 */
export const SearchField = forwardRef<
  HTMLInputElement,
  { search: string; onSearch: (value: string) => void; placeholder: string; well?: boolean; className?: string }
>(function SearchField({ search, onSearch, placeholder, well = false, className = "" }, ref) {
  const { t } = useTranslation();
  // What an IME is still building (NP-090): the field shows it, the list
  // waits for the finished character. `from` is the query it started on: a
  // query changed meanwhile from outside («Clear search», Esc on the window)
  // wins, and the end of the composition does not bring the old text back.
  const [composition, setComposition] = useState<{ text: string; from: string } | null>(null);
  const composed = composition && composition.from === search ? composition.text : null;
  // Esc also takes back a character the IME is composing: the field is not empty then either.
  const filled = !!(composed ?? search);
  return (
    <label className={`relative flex h-9 items-center ${className}`}>
      <Icon icon={Search} size={15} className="pointer-events-none absolute left-3 text-subtle" />
      <input
        ref={ref}
        value={composed ?? search}
        onChange={(e) =>
          composed !== null || (e.nativeEvent as InputEvent).isComposing
            ? setComposition({ text: e.target.value, from: search })
            : onSearch(e.target.value)
        }
        onCompositionStart={(e) => setComposition({ text: e.currentTarget.value, from: search })}
        onCompositionEnd={(e) => {
          setComposition(null);
          if (composed !== null) onSearch(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          // Esc inside an IME cancels the character, not the query.
          if (composing(e)) return;
          // Esc clears the query first (frame 09). On an empty field it lets go: the field rests
          // again (its hint back, no halo) and Esc goes on to close what is open behind it.
          if (e.key === "Escape" && search) {
            e.preventDefault();
            e.stopPropagation();
            onSearch("");
          } else if (e.key === "Escape") {
            e.currentTarget.blur();
          }
        }}
        aria-label={t("toolbar.searchLabel")}
        placeholder={placeholder}
        data-well={well || undefined}
        className="search peer min-w-0 pr-16"
      />
      {/* The shortcut steps aside while the field is in use; with a query the chip says Esc clears it. */}
      <kbd
        className={`pointer-events-none absolute right-2 inline-flex h-5 items-center rounded-sm bg-card px-1.5 font-sans text-2xs font-medium whitespace-nowrap text-muted shadow-[0_0_0_1px_var(--np-line),0_1px_0_1px_var(--np-line)] transition-opacity duration-[120ms] ${filled ? "" : "peer-focus-visible:opacity-0"}`}
      >
        {filled ? "Esc" : shortcut("K")}
      </kbd>
    </label>
  );
});
