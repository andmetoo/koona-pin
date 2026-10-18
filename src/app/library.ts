import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useLibrary } from "../hooks/useLibrary";
import { api } from "../services/api";
import type { Navigation } from "./navigation";
import type { Notices } from "./notices";

/**
 * The library's list for the section on screen (useLibrary), with what follows it: the skeleton
 * after a slow load, and the counts a link check in the background changes (NP-036).
 * `handingOff` says a refresh of previews is handing its pages to the link check.
 */
export function useLibraryView(
  t: TFunction,
  { filters, sort, scrollRef, pageRef, openLinksRef }: Pick<Navigation, "filters" | "sort" | "scrollRef" | "pageRef" | "openLinksRef">,
  { setNotice }: Pick<Notices, "setNotice">,
  handingOff: () => boolean,
) {
  const library = useLibrary(filters, sort, scrollRef);
  const libraryRef = useRef(library);
  libraryRef.current = library;
  /** The loaded order, for `Shift`+click ranges. */
  const loadedRef = useRef(library.bookmarks);
  loadedRef.current = library.bookmarks;
  const [slowLoading, setSlowLoading] = useState(false);
  const handingOffRef = useRef(handingOff);
  handingOffRef.current = handingOff;
  useEffect(() => {
    // A link check runs in the background (NP-036): written results change the
    // sidebar count; its end is announced when the section is not open.
    let running = false;
    let timer = 0;
    const off = api.onLinkCheck((progress) => {
      // The count follows written results every few seconds, and at once at the end.
      if (progress.written && progress.state === "running" && !timer)
        timer = window.setTimeout(() => {
          timer = 0;
          void libraryRef.current.refreshCatalog();
        }, 2000);
      if (progress.state === "running") running = true;
      else if (running) {
        running = false;
        window.clearTimeout(timer);
        timer = 0;
        void libraryRef.current.refreshCatalog();
        // A check of the pages a refresh of previews could not open reports in the notification centre.
        if (progress.state === "idle" && pageRef.current !== "links" && !handingOffRef.current())
          void api.getCounts().then((counts) => {
            if (counts.links > 0)
              setNotice({ text: t("links.finished", { count: counts.links }), alert: false, long: true, show: () => openLinksRef.current() });
          });
      }
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [t]);
  useEffect(() => {
    // Frame 11: a skeleton only when the library takes longer than 300 ms.
    if (!library.loading) return setSlowLoading(false);
    const timer = window.setTimeout(() => setSlowLoading(true), 300);
    return () => window.clearTimeout(timer);
  }, [library.loading]);
  return { library, libraryRef, loadedRef, slowLoading };
}

export type LibraryView = ReturnType<typeof useLibraryView>;
