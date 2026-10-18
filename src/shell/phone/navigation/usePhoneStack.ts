import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppState } from "../../../app/appState";
import { onBack } from "../../../platform/back";
import { selection } from "../../../platform/haptics";
import { atRoot, back, detailOf, forPhone, initialStack, leave, push, replaceTop, type Route, type RouteName, select, selectTab, type Stack, type Tab, topRoute } from "./stack";

/** What a tab shows of the app: its section of the library, or Feeds on the feed last open. */
export function enterTab(app: Pick<AppState, "navigate" | "openFeeds" | "feedPlace">, tab: Tab) {
  if (tab === "inbox") app.navigate({ onlyInbox: true });
  else if (tab === "reading") app.navigate({ onlyReading: true });
  else if (tab === "feeds") app.openFeeds(app.feedPlace.feed);
  else app.navigate();
}

export type PhoneStack = Stack & {
  top: Route | null;
  atRoot: boolean;
  /** What the Fold's detail pane shows (the topmost detail route); null with nothing selected. */
  detail: Route | null;
  /** Shows a tab: the app's section follows, with a haptic tick when the tab actually changes. */
  selectTab: (tab: Tab) => void;
  push: (route: Route) => void;
  replaceTop: (route: Route) => void;
  /**
   * A row's tap: on a phone the reader (or the post) is pushed; on the Fold the bookmark's detail
   * (or the post) is selected into the detail pane instead.
   */
  openBookmark: (bookmarkId: number) => void;
  openPost: (feedUid: string | null, itemId: number) => void;
  /** Closes the topmost route of that name and what was opened over it. */
  leave: (name: RouteName) => void;
  /** One level back, as system Back does; false at the tab's root. */
  back: () => boolean;
};

/**
 * The phone's stack in React (NP-072b). It owns system Back at the very bottom (place 0 of
 * src/platform/back.ts): sheets, dialogs and `useBack` users take newer places and close first;
 * then Back pops a pushed route (on the Fold, the selection first); at a tab's root it says false
 * and Android moves the app to the background. When the Fold closes, a bookmark's detail becomes
 * its reader ({@link forPhone}); a phone's pushed reader or post shows in the Fold's detail pane.
 */
export function usePhoneStack(app: AppState, fold = false): PhoneStack {
  const [stack, setStack] = useState(initialStack);
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const appRef = useRef(app);
  appRef.current = app;
  const foldRef = useRef(fold);
  foldRef.current = fold;

  const change = useCallback((next: Stack) => {
    if (next === stackRef.current) return;
    stackRef.current = next;
    setStack(next);
  }, []);

  const goBack = useCallback(() => {
    const next = back(stackRef.current);
    if (!next) return false;
    change(next);
    return true;
  }, [change]);

  useEffect(() => onBack(goBack, 0), [goBack]);
  useEffect(() => {
    if (!fold) change(forPhone(stackRef.current));
  }, [fold, change]);

  return useMemo(
    () => ({
      ...stack,
      top: topRoute(stack),
      atRoot: atRoot(stack),
      detail: detailOf(stack),
      selectTab: (tab: Tab) => {
        if (stackRef.current.tab !== tab) {
          void selection();
          enterTab(appRef.current, tab);
        }
        change(selectTab(stackRef.current, tab));
      },
      push: (route: Route) => change(push(stackRef.current, route)),
      replaceTop: (route: Route) => change(replaceTop(stackRef.current, route)),
      openBookmark: (bookmarkId: number) =>
        change(
          foldRef.current ? select(stackRef.current, { name: "bookmark", bookmarkId }) : push(stackRef.current, { name: "reader", bookmarkId }),
        ),
      openPost: (feedUid: string | null, itemId: number) => {
        const route: Route = { name: "post", feedUid, itemId };
        change(foldRef.current ? select(stackRef.current, route) : push(stackRef.current, route));
      },
      leave: (name: RouteName) => change(leave(stackRef.current, name)),
      back: goBack,
    }),
    [stack, change, goBack],
  );
}
