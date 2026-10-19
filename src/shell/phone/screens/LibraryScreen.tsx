import { type CSSProperties, type MutableRefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Heart, LayoutGrid, List, Plus, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { selection } from "../../../platform/haptics";
import { collectionColor } from "../../../services/collections";
import { groupOf } from "../../../services/dateGroups";
import { byTime, listTime } from "../../../services/library";
import type { Bookmark, Collection } from "../../../types";
import { BookmarkCard, BookmarkRow } from "../library/BookmarkTiles";
import { Empty } from "../library/Empty";
import { ShelfList } from "../library/ShelfList";
import { scaledSizes, shelfEntries } from "../library/shelfEntries";
import { usePullToRefresh } from "../library/usePullToRefresh";
import { useTextScale } from "../library/useTextScale";
import "../library/library.css";
import { usePhone } from "../PhoneContext";
import { Button } from "../ui/buttons";
import { Chip, Segmented } from "../ui/controls";
import { PhIcon } from "../ui/icons";
import { Screen, Header } from "../ui/Screen";

/** Grid cards: at least this wide (two columns on a phone and in the Fold's list pane, more where wider), 12 apart. */
const CARD_MIN = 160;
const CARD_GAP = 12;
/** L2's card: the picture inset 4 at 166.5 × 109; title, meta and padding below it (scaledSizes). */
const PICTURE_RATIO = 109 / 166.5;
/** A pull refreshes the previews of this many rows at the top that have no picture yet. */
const PREVIEW_ROWS = 30;

/** The sections' labels: the desktop's date groups, and Reading's unread and read. */
const LABELS = {
  today: "groups.today",
  yesterday: "groups.yesterday",
  week: "groups.week",
  earlier: "groups.earlier",
  unread: "phone.library.unread",
  read: "phone.library.read",
} as const;

type ChipValue = "all" | "favorites" | number;

/**
 * L1/L2 Library (NP-072b): All bookmarks, and the Reading tab with `section="reading"`. The header
 * with the count and the account cluster; the search field, which opens Search; the list/grid
 * switch (the desktop's view preference: its compact grid shows as the list here); filter chips —
 * All, Favorites, the collections — narrowing the tab's section; the bookmarks on shelves by day
 * (the desktop's date groups), Reading's by unread and read. Virtualized and paged as on the
 * desktop; pull to refresh at the top.
 */
export function LibraryScreen({ section, hidden }: { section: "all" | "reading"; hidden: boolean }) {
  const { app, stack, sheets, selected } = usePhone();
  const { t, i18n, library, filters, counts, sort, view, setView, navigate } = app;
  const reading = section === "reading";
  const title = reading ? t("phone.nav.reading") : t("phone.library.title");
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const width = useWidth(scroller);
  const probe = useRef<HTMLSpanElement>(null);
  const scale = useTextScale(probe);
  const sizes = scaledSizes(scale);

  // The app's list keeps its scroll here (a new link while scrolled waits behind "N new"; another
  // section starts at the top), while this screen is the one on top.
  const scrollRef = app.scrollRef as MutableRefObject<HTMLElement | null>;
  useEffect(() => {
    if (!scroller || hidden) return;
    scrollRef.current = scroller;
    return () => {
      if (scrollRef.current === scroller) scrollRef.current = null;
    };
  }, [scroller, hidden, scrollRef]);

  // The tab's section with a chip's narrowing on top: All, Favorites or a collection.
  const base = reading ? { onlyReading: true } : {};
  const chip: ChipValue = filters.onlyFavorites ? "favorites" : (filters.collectionId ?? "all");
  const choose = (value: ChipValue) => {
    if (value === chip) return;
    void selection();
    navigate({ ...base, onlyFavorites: value === "favorites", collectionId: typeof value === "number" ? value : null });
  };

  const grid = view === "grid";
  const columns = Math.max(2, Math.floor((width - 32 + CARD_GAP) / (CARD_MIN + CARD_GAP)));
  const cardWidth = (width - 32 - CARD_GAP * (columns - 1)) / columns;
  const cardHeight = Math.round((cardWidth - 8) * PICTURE_RATIO) + sizes.cardText;
  const { starts } = library.dateGroups;
  const grouping = reading ? "reading" : byTime(sort) ? "time" : "none";
  const entries = useMemo(
    () =>
      shelfEntries(library.bookmarks, {
        groupOf:
          grouping === "time"
            ? (b) => groupOf(listTime(b), starts)
            : grouping === "reading"
              ? (b) => (b.read_at ? "read" : "unread")
              : () => null,
        keyOf: (b) => b.id,
        columns: grid ? columns : null,
        cardHeight,
        rowHeight: sizes.row,
        labelHeight: sizes.label,
      }),
    [library.bookmarks, grouping, starts, grid, columns, cardHeight, sizes.row, sizes.label],
  );

  const collections = useMemo(() => new Map(library.collections.map((c) => [c.id, c])), [library.collections]);
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const onOpen = useCallback((b: Bookmark) => stackRef.current.openBookmark(b.id), []);
  const onMenu = useCallback((b: Bookmark) => sheets.open({ kind: "bookmarkMenu", props: { bookmarkId: b.id, bookmark: b } }), [sheets]);
  const dotOf = (b: Bookmark) => (b.collection_id !== null && collections.has(b.collection_id) ? collectionColor(b.collection_id) : null);
  const favorite = t("phone.library.favorite");

  // Pull to refresh: the list and the counts read again, as when the app comes back to the screen,
  // and the previews of the rows at the top that have no picture yet, as "Refresh previews" does.
  const indicator = useRef<HTMLDivElement>(null);
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const previews = app.previews;
  const refresh = useCallback(async () => {
    const lib = libraryRef.current;
    if (lib.pendingCount) lib.reveal();
    const missing = lib.bookmarks.slice(0, PREVIEW_ROWS).filter((b) => !b.image_url || !b.site_name);
    await Promise.all([lib.refresh(), lib.refreshCatalog(), missing.length ? previews.start({ ids: missing.map((b) => b.id) }).catch(() => {}) : null]);
  }, [previews]);
  const refreshing = usePullToRefresh(scroller, indicator, refresh, !hidden);

  const empty = !library.loading && library.bookmarks.length === 0;
  return (
    <Screen label={title} hidden={hidden} scrollRef={setScroller} className="lib-screen">
      <div className="lib-pull" aria-hidden={!refreshing}>
        <div ref={indicator} className="lib-pull-disc" role={refreshing ? "status" : undefined} aria-label={refreshing ? t("phone.library.refreshing") : undefined}>
          <PhIcon icon={RefreshCw} at="field" />
        </div>
      </div>
      <span ref={probe} className="ph-meta lib-probe" aria-hidden="true">
        Ag
      </span>
      <Header title={title} meta={t("phone.library.count", { count: app.sectionCount })} />
      <div className="lib-tools">
        <button type="button" className="ph-search ph-hit lib-search" onClick={() => stack.push({ name: "search" })}>
          <PhIcon icon={Search} at="field" />
          <span>{t("phone.library.search", { count: counts.total })}</span>
        </button>
        <Segmented
          className="lib-segmented"
          label={t("phone.library.view")}
          value={grid ? "grid" : "list"}
          options={[
            { value: "list", label: t("phone.library.list"), icon: List },
            { value: "grid", label: t("phone.library.grid"), icon: LayoutGrid },
          ]}
          onChange={setView}
        />
      </div>
      <div className="ph-chips lib-chips" role="group" aria-label={t("phone.library.filters")}>
        <Chip active={chip === "all"} onClick={() => choose("all")}>
          {t("phone.library.all")}
        </Chip>
        <Chip active={chip === "favorites"} icon={Heart} onClick={() => choose("favorites")}>
          {t("nav.favorites")}
        </Chip>
        {library.collections.map((c) => (
          <Chip key={c.id} active={chip === c.id} dot={collectionColor(c.id)} onClick={() => choose(c.id)}>
            {c.name}
          </Chip>
        ))}
      </div>
      {library.pendingCount > 0 && (
        <div className="lib-new">
          <button type="button" className="lib-new-pill" onClick={library.reveal}>
            {t("phone.library.newLinks", { count: library.pendingCount })}
          </button>
        </div>
      )}
      {empty ? (
        library.error ? (
          <Empty icon={TriangleAlert} title={library.error}>
            <Button kind="clear" icon={RefreshCw} onClick={() => void library.refresh()}>
              {t("common.retry")}
            </Button>
          </Empty>
        ) : (
          <EmptySection reading={reading} chip={chip} collection={typeof chip === "number" ? collections.get(chip) : undefined} />
        )
      ) : library.bookmarks.length === 0 ? (
        app.slowLoading && <Skeleton label={t("library.loading")} />
      ) : (
        <ShelfList
          entries={entries}
          scrollElement={scroller}
          hasMore={library.hasMore}
          loadingMore={library.loadingMore}
          onMore={library.loadMore}
          renderLabel={(group) => <h2 className="lib-label">{t(LABELS[group as keyof typeof LABELS])}</h2>}
          renderRow={(b, entry) => (
            <BookmarkRow
              bookmark={b}
              dot={dotOf(b)}
              language={i18n.language}
              favorite={favorite}
              onOpen={onOpen}
              onMenu={onMenu}
              first={entry.first}
              selected={b.id === selected.bookmarkId}
              last={entry.last}
            />
          )}
          renderCards={(entry) => (
            <div className="lib-cards" style={{ "--columns": columns, "--lib-scale": scale, height: cardHeight } as CSSProperties}>
              {entry.items.map((b) => (
                <BookmarkCard key={b.id} bookmark={b} dot={dotOf(b)} language={i18n.language} favorite={favorite} onOpen={onOpen} onMenu={onMenu} selected={b.id === selected.bookmarkId} />
              ))}
            </div>
          )}
          footer={
            <p className="lib-more ph-meta" role="status">
              {library.loadingMore ? t("library.loadingMore") : ""}
            </p>
          }
        />
      )}
    </Screen>
  );
}

/** What the tab shows with nothing in it: the section's own words, and a way to add a link. */
function EmptySection({ reading, chip, collection }: { reading: boolean; chip: ChipValue; collection: Collection | undefined }) {
  const { app, sheets } = usePhone();
  const { t } = app;
  const add = (
    <Button kind="ink" icon={Plus} onClick={() => sheets.open({ kind: "newLink", props: {} })}>
      {t("phone.nav.new")}
    </Button>
  );
  if (collection) return <Empty title={t("empty.emptyCollection", { name: collection.name })} text={t("phone.library.empty.collectionHint")} />;
  if (chip === "favorites") return <Empty icon={Heart} title={t("empty.noFavorites")} text={t("phone.library.empty.favoritesHint")} />;
  if (reading) return <Empty icon={BookOpen} title={t("empty.reading")} text={t("phone.library.empty.readingHint")} />;
  return (
    <Empty title={t("empty.library")} text={t("phone.library.empty.libraryHint")}>
      {add}
    </Empty>
  );
}

/** A slow first read: a shelf of empty rows in the well's colour. */
function Skeleton({ label }: { label: string }) {
  return (
    <div className="lib-skeleton" role="status" aria-label={label}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className="lib-skeleton-row">
          <span className="lib-skeleton-text">
            <span />
            <span />
          </span>
          <span className="lib-skeleton-thumb" />
        </span>
      ))}
    </div>
  );
}

/** The width of the screen, for the grid's columns. */
function useWidth(el: HTMLElement | null) {
  const [width, setWidth] = useState(393);
  useLayoutEffect(() => {
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return width;
}
