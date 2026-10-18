import type { Route, Tab } from "./navigation/stack";
import { usePhone } from "./PhoneContext";
import { FeedsScreen } from "./screens/FeedsScreen";
import { InboxScreen } from "./screens/InboxScreen";
import { LibraryScreen } from "./screens/LibraryScreen";
import { PostScreen } from "./screens/PostScreen";
import { ReaderScreen } from "./screens/ReaderScreen";
import { SearchScreen } from "./screens/SearchScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

/**
 * The tab's root screen and the routes pushed over it, all mounted so going back keeps each one's
 * scroll; only the top one shows. A screen is a component with `hidden` (and its `route`).
 */
export function ScreenStack() {
  const { stack } = usePhone();
  const { tab, routes } = stack;
  return (
    <>
      <TabScreen key={tab} tab={tab} hidden={routes.length > 0} />
      {routes.map((route, i) => (
        <RouteScreen key={`${i}:${route.name}`} route={route} hidden={i < routes.length - 1} />
      ))}
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
    case "post":
      return <PostScreen route={route} hidden={hidden} />;
    case "search":
      return <SearchScreen hidden={hidden} />;
    case "settings":
      return <SettingsScreen route={route} hidden={hidden} />;
  }
}
