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
 * screen in ../screens/registry.ts.
 */
export type Route =
  /** R1: a bookmark in the reader. */
  | { name: "reader"; bookmarkId: number }
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
