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
 * Where the person is (filters and sections): the page, the library's section with its search, tag
 * and site, triage over the inbox, the feed and post open on Feeds, and how the list looks.
 * `inbox` says how many bookmarks wait, for triage.
 */
export function useNavigation({ setEditing }: Pick<Editing, "setEditing">, { setNotice }: Pick<Notices, "setNotice">, inbox: () => number) {
  const [view, setView] = useState<ViewMode>(() => preference("view", ["grid", "dense", "list"], "dense"));
  /** The order of every list but the trash, kept like the view (NP-114). */
  const [sort, setSort] = useState<BookmarkSort>(() => preference("sort", SORTS, "newest"));
  const [filters, setFilters] = useState(initialFilters);
  const [page, setPage] = useState<Page>("library");
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

  const changeFilters = (partial: Partial<FilterState>) => {
    setPage("library");
    setTriage(null);
    scrollRef.current?.scrollTo({ top: 0 });
    setFilters((prev) => ({ ...prev, ...partial }));
  };
  /** One section at a time: All, Inbox, Favorites, Reading, Trash or a collection. */
  const navigate = (section: Section = {}) => changeFilters({ ...noSection, ...section, tag: null, domain: null });
  const openInbox = () => navigate({ onlyInbox: true });
  /** «Разобрать»: triage over the whole inbox; the sidebar shows «Входящие» meanwhile. */
  const openTriage = () => {
    if (inbox() === 0) return;
    setPage("library");
    setEditing(null);
    setNotice(null);
    setTriage(filters);
    setFilters({ ...initialFilters, onlyInbox: true });
  };
  /** The section «Дубликаты» (NP-035): from the sidebar or the menu «⋯». */
  const openDuplicates = () => {
    setTriage(null);
    setEditing(null);
    setPage("duplicates");
  };
  /** The Feeds page (NP-132) on a feed, or on All feeds; another feed closes the open post. */
  const openFeeds = (feedUid: string | null) => {
    setTriage(null);
    setEditing(null);
    setPage("feeds");
    setFeedPlace((place) => (place.feed === feedUid ? place : { feed: feedUid, item: null }));
  };
  /** The section «Проверка ссылок» (NP-036): from the sidebar or the menu «⋯». */
  const openLinks = () => {
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
