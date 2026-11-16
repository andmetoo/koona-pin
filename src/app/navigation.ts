import { useEffect, useRef, useState } from "react";
import { SORTS } from "../services/library";
import { parsePlace } from "../services/feedsView";
import { preference, savePreference, storedValue } from "../services/preferences";
import type { BookmarkSort, FilterState, ViewMode } from "../types";
import type { Editing } from "./editing";
import type { Notices } from "./notices";
import { initialFilters, noSection, Section } from "./sections";

export type Page = "library" | "settings" | "duplicates" | "links" | "feeds";
/**
 * The window's two modes (2.24.0): Bookmarks (the library, its sections and tools) and Feeds (the
 * followed sites, Today and «Saved from feeds»). The sidebar shows one at a time; Settings belongs
 * to both. The last one is remembered, and the app opens in it.
 */
export type Mode = "bookmarks" | "feeds";

/**
 * Where the person is (filters and sections): the page, the library's section with its search, tag
 * and site, triage over the inbox, the feed and post open on Feeds, and how the list looks.
 * `inbox` says how many bookmarks wait, for triage.
 */
export function useNavigation({ setEditing }: Pick<Editing, "setEditing">, { setNotice }: Pick<Notices, "setNotice">, inbox: () => number) {
  const [view, setView] = useState<ViewMode>(() => preference("view", ["grid", "dense", "list"], "dense"));
  /** The order of every list but the trash, kept like the view (NP-114). */
  const [sort, setSort] = useState<BookmarkSort>(() => preference("sort", SORTS, "newest"));
  const [filters, setFilters] = useState(initialFilters);
  const [mode, setMode] = useState<Mode>(() => preference("mode", ["bookmarks", "feeds"], "bookmarks"));
  const [page, setPage] = useState<Page>(() => (mode === "feeds" ? "feeds" : "library"));
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  /** Where Bookmarks was when the person went to Feeds: it comes back with the mode. */
  const bookmarksPlace = useRef<{ filters: FilterState; page: Page } | null>(null);
  /** The Feeds page (NP-132): the feed shown (null: All feeds) and the open post, remembered. */
  const [feedPlace, setFeedPlace] = useState(() => parsePlace(storedValue("feeds.last")));
  const pageRef = useRef(page);
  pageRef.current = page;
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Inbox triage (NP-025) and the filters to go back to when it ends. */
  const [triage, setTriage] = useState<FilterState | null>(null);
  const triageRef = useRef(triage);
  triageRef.current = triage;

  useEffect(() => savePreference("view", view), [view]);
  useEffect(() => savePreference("feeds.last", JSON.stringify(feedPlace)), [feedPlace]);
  useEffect(() => savePreference("sort", sort), [sort]);
  useEffect(() => savePreference("mode", mode), [mode]);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  /** Leaving Bookmarks for Feeds: remember where it was (not a Feeds view of the library). */
  const leaveBookmarks = () => {
    if (modeRef.current === "bookmarks") bookmarksPlace.current = { filters: filtersRef.current, page: pageRef.current };
  };

  const changeFilters = (partial: Partial<FilterState>) => {
    const next = { ...filtersRef.current, ...partial };
    // «Saved from feeds» is the library seen from the Feeds mode; every other section is Bookmarks.
    if (next.onlyFeed) leaveBookmarks();
    setMode(next.onlyFeed ? "feeds" : "bookmarks");
    setPage("library");
    setTriage(null);
    scrollRef.current?.scrollTo({ top: 0 });
    filtersRef.current = next;
    setFilters(next);
  };
  /** One section at a time: All, Inbox, Favorites, Reading, Trash or a collection. */
  const navigate = (section: Section = {}) => changeFilters({ ...noSection, ...section, tag: null, domain: null });
  const openInbox = () => navigate({ onlyInbox: true });
  /** «Разобрать»: triage over the whole inbox; the sidebar shows «Входящие» meanwhile. */
  const openTriage = () => {
    if (inbox() === 0) return;
    setMode("bookmarks");
    setPage("library");
    setEditing(null);
    setNotice(null);
    setTriage(filters);
    setFilters({ ...initialFilters, onlyInbox: true });
  };
  /** The section «Дубликаты» (NP-035): from the sidebar or the menu «⋯». */
  const openDuplicates = () => {
    setMode("bookmarks");
    setTriage(null);
    setEditing(null);
    setPage("duplicates");
  };
  /** The Feeds page (NP-132) on a feed, on All feeds or on Today; another place closes the open post. */
  const openFeeds = (feedUid: string | null, { today = false } = {}) => {
    leaveBookmarks();
    setMode("feeds");
    setTriage(null);
    setEditing(null);
    setPage("feeds");
    setFeedPlace((place) => (place.feed === feedUid && !!place.today === today ? place : { feed: feedUid, item: null, today }));
  };
  /** The section «Проверка ссылок» (NP-036): from the sidebar or the menu «⋯». */
  const openLinks = () => {
    setMode("bookmarks");
    setTriage(null);
    setEditing(null);
    setPage("links");
  };
  const openLinksRef = useRef(openLinks);
  openLinksRef.current = openLinks;
  /** Settings, from the sidebar, a notification or a dialog that sends the person there. */
  const openSettings = () => {
    setTriage(null);
    setPage("settings");
  };
  /**
   * The mode switch (⌘1, ⌘2): each mode comes back where it was left. Pressed on the mode already
   * shown, it goes to that mode's home (the library, or the posts) from any other page, and on the
   * home itself it does nothing: an open editor or triage stays.
   */
  const switchMode = (next: Mode) => {
    const home: Page = next === "feeds" ? "feeds" : "library";
    if (modeRef.current === next && pageRef.current === home) return;
    setTriage(null);
    setEditing(null);
    if (next === "feeds") {
      leaveBookmarks();
      setMode("feeds");
      setPage("feeds");
      return;
    }
    if (modeRef.current === "bookmarks") {
      // Already here (Settings, Duplicates, Link check): back to the library as it was.
      setPage("library");
      return;
    }
    const back = bookmarksPlace.current;
    setMode("bookmarks");
    const filters = back && !back.filters.onlyFeed ? back.filters : { ...initialFilters };
    filtersRef.current = filters;
    setFilters(filters);
    setPage(back && back.page !== "feeds" && back.page !== "settings" ? back.page : "library");
  };
  /** «Закончить» `Esc`: back where triage was opened. */
  const finishTriage = () => {
    if (!triage) return;
    setNotice(null);
    setFilters(triage);
    setTriage(null);
  };

  return {
    view,
    setView,
    sort,
    setSort,
    filters,
    setFilters,
    page,
    setPage,
    mode,
    switchMode,
    pageRef,
    feedPlace,
    setFeedPlace,
    scrollRef,
    triage,
    setTriage,
    triageRef,
    changeFilters,
    navigate,
    openInbox,
    openTriage,
    openDuplicates,
    openFeeds,
    openLinks,
    openLinksRef,
    openSettings,
    finishTriage,
  };
}

export type Navigation = ReturnType<typeof useNavigation>;
