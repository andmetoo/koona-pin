/**
 * Where the phone is (NP-072b): one of the four top-level tabs of the nav pill, and the routes
 * pushed over it. Pure: the hook in ./usePhoneStack.ts holds it in React and connects it to the
 * app's state and to system Back.
 */

/** The nav pill's places, in its order; "+" is an action, not a tab. */
export const TABS = ["inbox", "all", "reading", "feeds"] as const;
export type Tab = (typeof TABS)[number];

/**
 * A screen pushed over a tab; the nav pill hides while one is open. Add a route here with its
 * screen in ../ScreenStack.tsx (and its pane on the Fold in {@link paneOf}).
 */
export type Route =
  /** R1: a bookmark in the reader. */
  | { name: "reader"; bookmarkId: number }
  /** FL1: a bookmark's detail in the Fold's detail pane; a phone has none and reads it ({@link forPhone}). */
  | { name: "bookmark"; bookmarkId: number }
  /** A feed's post (F1 → post view); `feedUid` null: opened from All feeds. */
  | { name: "post"; feedUid: string | null; itemId: number }
  /** Q1: search over the library. */
  | { name: "search" }
  /** Settings; `page` names a sub-page (Appearance, Language, Backups, About…), none: the list. */
  | { name: "settings"; page?: string };
export type RouteName = Route["name"];

export interface Stack {
  tab: Tab;
  /** Pushed routes, the top last; empty at the tab's root. */
  routes: Route[];
}

export const initialStack = (tab: Tab = "all"): Stack => ({ tab, routes: [] });

/** The route on top, or null at the tab's root. */
export const topRoute = (stack: Stack): Route | null => stack.routes[stack.routes.length - 1] ?? null;

export const atRoot = (stack: Stack) => stack.routes.length === 0;

/**
 * Another tab starts at its root; the tab already shown goes back to its root. The same stack when
 * nothing changes, so a tap on the open tab at its root renders nothing new.
 */
export function selectTab(stack: Stack, tab: Tab): Stack {
  if (stack.tab === tab && atRoot(stack)) return stack;
  return { tab, routes: [] };
}

export function push(stack: Stack, route: Route): Stack {
  return { ...stack, routes: [...stack.routes, route] };
}

/** The top route replaced (a reader moving to the next bookmark); pushed at the root. */
export function replaceTop(stack: Stack, route: Route): Stack {
  return { ...stack, routes: [...stack.routes.slice(0, -1), route] };
}

/**
 * One level back: the top route closes. Null at the tab's root: Back has nothing to close there,
 * and Android moves the app to the background (the owner's choice, not a jump to another tab).
 */
export function back(stack: Stack): Stack | null {
  if (atRoot(stack)) return null;
  return { ...stack, routes: stack.routes.slice(0, -1) };
}

/**
 * Where a route shows on the Fold (two panes, NP-072b wave 2): Search takes the list pane's place;
 * a bookmark, the reader, a post and Settings fill the detail pane on the far side.
 */
export const paneOf = (route: Route): "list" | "detail" => (route.name === "search" ? "list" : "detail");

/** How many routes from the bottom belong to the list: up to the topmost list route. */
function listDepth(stack: Stack) {
  for (let i = stack.routes.length - 1; i >= 0; i--) if (paneOf(stack.routes[i]) === "list") return i + 1;
  return 0;
}

const sameRoute = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A tap on a row on the Fold: the bookmark or post becomes the detail pane's only route above the
 * list (what showed there closes), so Back clears the selection first. The same stack when it is
 * the one shown already.
 */
export function select(stack: Stack, route: Route): Stack {
  const keep = listDepth(stack);
  const above = stack.routes.slice(keep);
  if (above.length === 1 && sameRoute(above[0], route)) return stack;
  return { ...stack, routes: [...stack.routes.slice(0, keep), route] };
}

/** What the Fold's detail pane shows: the topmost detail route, or null with nothing selected. */
export function detailOf(stack: Stack): Route | null {
  for (let i = stack.routes.length - 1; i >= 0; i--) if (paneOf(stack.routes[i]) === "detail") return stack.routes[i];
  return null;
}

/**
 * The stack as a phone shows it once the Fold closes: a bookmark's detail becomes its reader, and a
 * reader opened from that detail stays alone, not twice. The same stack when nothing changes.
 */
export function forPhone(stack: Stack): Stack {
  if (!stack.routes.some((r) => r.name === "bookmark")) return stack;
  const routes: Route[] = [];
  stack.routes.forEach((route, i) => {
    if (route.name !== "bookmark") return void routes.push(route);
    const next = stack.routes[i + 1];
    if (next?.name === "reader" && next.bookmarkId === route.bookmarkId) return;
    routes.push({ name: "reader", bookmarkId: route.bookmarkId });
  });
  return { ...stack, routes };
}

/**
 * Closes the topmost route named `name` and everything opened over it (Search's Cancel on the Fold
 * also closes the result chosen from it). The same stack when no such route is open.
 */
export function leave(stack: Stack, name: RouteName): Stack {
  for (let i = stack.routes.length - 1; i >= 0; i--) if (stack.routes[i].name === name) return { ...stack, routes: stack.routes.slice(0, i) };
  return stack;
}
