import { DetailEmpty } from "./fold/DetailEmpty";
import { paneOf, type Route, type Tab } from "./navigation/stack";
import { usePhone } from "./PhoneContext";
import { BookmarkScreen } from "./screens/BookmarkScreen";
import { FeedsScreen } from "./screens/FeedsScreen";
import { InboxScreen } from "./screens/InboxScreen";
import { LibraryScreen } from "./screens/LibraryScreen";
import { PostScreen } from "./screens/PostScreen";
import { ReaderScreen } from "./screens/ReaderScreen";
import { SearchScreen } from "./screens/SearchScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

/**
 * The tab's root screen and the routes pushed over it, all mounted so going back keeps each one's
 * scroll. A screen is a component with `hidden` (and its `route`).
 *
 * On a phone only the top one shows. On the Fold (two panes, FL1/FL2) the list pane shows the tab
 * or Search over it, and the detail pane the topmost detail route (a bookmark, the reader, a post,
 * Settings) or a calm empty state. The same elements stay mounted in both, in the same containers
 * (on a phone the panes take no box of their own), so folding and unfolding keeps each screen's
 * state: a search typed, a list's scroll.
 */
export function ScreenStack() {
  const { stack, fold } = usePhone();
  const { tab, routes } = stack;
  const all = routes.map((route, i) => ({ route, i, pane: paneOf(route) }));
  const top = routes.length - 1;
  const lists = all.filter((r) => r.pane === "list");
  const details = all.filter((r) => r.pane === "detail");
  const topList = lists.at(-1)?.i ?? -1;
  const topDetail = details.at(-1)?.i ?? -1;
  const shown = (i: number, pane: "list" | "detail") => (fold ? i === (pane === "list" ? topList : topDetail) : i === top);
  return (
    <>
      <div className="ph-pane-list" data-pane="list">
        <TabScreen key={tab} tab={tab} hidden={fold ? topList >= 0 : routes.length > 0} />
        {lists.map(({ route, i }) => (
          <RouteScreen key={`${i}:${route.name}`} route={route} hidden={!shown(i, "list")} />
        ))}
        {fold && <div className="ph-fade-bottom ph-pane-fade" aria-hidden="true" />}
      </div>
      <section className="ph-pane-detail" data-pane="detail" data-empty={(fold && topDetail < 0) || undefined}>
        <div className="ph-pane-body">
          {details.map(({ route, i }) => (
            <RouteScreen key={`${i}:${route.name}`} route={route} hidden={!shown(i, "detail")} />
          ))}
          {fold && topDetail < 0 && <DetailEmpty tab={tab} />}
        </div>
      </section>
    </>
  );
}

function TabScreen({ tab, hidden }: { tab: Tab; hidden: boolean }) {
  switch (tab) {
    case "inbox":
      return <InboxScreen hidden={hidden} />;
    case "reading":
      return <LibraryScreen section="reading" hidden={hidden} />;
    case "feeds":
      return <FeedsScreen hidden={hidden} />;
    default:
      return <LibraryScreen section="all" hidden={hidden} />;
  }
}

function RouteScreen({ route, hidden }: { route: Route; hidden: boolean }) {
  switch (route.name) {
    case "reader":
      return <ReaderScreen route={route} hidden={hidden} />;
    case "bookmark":
      return <BookmarkScreen route={route} hidden={hidden} />;
    case "post":
      return <PostScreen route={route} hidden={hidden} />;
    case "search":
      return <SearchScreen hidden={hidden} />;
    case "settings":
      return <SettingsScreen route={route} hidden={hidden} />;
  }
}
