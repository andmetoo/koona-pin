import type { ReactNode } from "react";

/*
 * Every page's title stands on one line (2.25.1): 8 px under the window bar, centred in a 36 px row,
 * 32 px in from the sidebar (24 px in a narrow window), 22 px semibold with its count beside it.
 * The library toolbar, Settings, Duplicates, Link check, Feeds and Sort inbox all take it from here,
 * so «Reading» and «All feeds» can't drift apart again when the mode changes.
 */

/** The page's side inset. */
export const pageInset = (narrow: boolean) => (narrow ? "px-6" : "px-8");
/** The start side alone, for a column whose far edge follows its own rows (the feed list). */
export const pageInsetStart = (narrow: boolean) => (narrow ? "pl-6" : "pl-8");
/**
 * A list whose rows are cards reaching 12 px past their text (the feed list, 2.25.2): its start side stands
 * 12 px less far in than the page's, so the text under the title starts where the title does and the card's
 * edge hangs out. Kept beside `pageInsetStart`: change one, change the other.
 */
export const listInsetStart = (narrow: boolean) => (narrow ? "pl-3" : "pl-5");
/**
 * The far side of such a list, scrolled in a `.pane-scroll`: 12 px, and the 8 px the scrollbar keeps make the
 * header's 20. A Mac's overlay scrollbar keeps none (app.css), so there the list takes all 20 itself.
 */
export const listInsetEnd = "pr-3 [[data-mac]_&]:pr-5";
/** From the window bar to the title row. */
export const pageTop = "pt-2";
/** The title row: the title and whatever stands beside it, centred in 36 px. */
export const pageRow = "flex h-9 items-center";

interface PageTitleProps {
  title: string;
  /** The size beside the title, in the quiet type. */
  count?: number | string;
  /** Read the count out as it changes (a search narrowing the section). */
  countLive?: boolean;
  /** Anything else on the title's baseline after the count (Sort inbox's «1 of 12», «3 new»). */
  children?: ReactNode;
  className?: string;
}

/** The page's title: cut short with «…» when the row runs out, the count never. */
export function PageTitle({ title, count, countLive, children, className = "" }: PageTitleProps) {
  return (
    <h1 className={`flex min-w-0 items-baseline gap-2 ${className}`}>
      <span className="min-w-0 truncate text-2xl font-semibold">{title}</span>
      {count !== undefined && (
        <span className="shrink-0 text-md text-subtle" aria-live={countLive ? "polite" : undefined}>
          {count}
        </span>
      )}
      {children}
    </h1>
  );
}
