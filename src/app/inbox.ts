import { useEffect, useState } from "react";
import { api } from "../services/api";
import { savePreference, storedValue } from "../services/preferences";
import type { Bookmark, FilterState } from "../types";
import type { LibraryView } from "./library";

/**
 * What waits in the inbox, as the notification centre and the Inbox section's pill say it
 * (NP-020, 2026-10-16), and the offer to import from a browser (sheet 43, NP-117).
 */
export function useInbox({ library }: Pick<LibraryView, "library">, filters: FilterState) {
  /** The newest inbox bookmark when the banner was hidden: it returns for a newer one. */
  const [bannerHidden, setBannerHidden] = useState(() => storedValue("inboxBannerHidden"));
  const hideBanner = () => {
    const newest = library.counts.inbox_newest;
    if (!newest) return;
    setBannerHidden(newest);
    savePreference("inboxBannerHidden", newest);
  };
  /**
   * Sheet 43 (NP-117): a new library starts with the starter set, so frame 08
   * with its import button is not the first screen; this banner offers the
   * import instead, until the first import or ×. It never comes back.
   */
  const [importOffer, setImportOffer] = useState(() => storedValue("importBanner") === "show");
  useEffect(() => {
    if (library.firstRun) setImportOffer(true);
  }, [library.firstRun]);
  const endImportOffer = () => {
    setImportOffer(false);
    savePreference("importBanner", "done");
  };
  /** The newest three waiting bookmarks, fanned in the inbox notification. */
  const [inboxThumbs, setInboxThumbs] = useState<Bookmark[]>([]);
  useEffect(() => {
    if (!library.counts.inbox) return setInboxThumbs([]);
    let current = true;
    api
      .getBookmarks({ onlyInbox: true }, { limit: 3 })
      .then((page) => current && setInboxThumbs(page.items))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [library.counts.inbox, library.counts.inbox_newest]);
  const { counts } = library;
  // The inbox notification is hidden until a bookmark newer than the remembered one arrives (NP-020).
  const inboxHidden = !!(bannerHidden && counts.inbox_newest && counts.inbox_newest <= bannerHidden);
  // In the inbox itself the banner stays on the page, never hidden: it leads to triage (NP-025).
  const inboxBanner = counts.inbox > 0 && filters.onlyInbox;
  return { hideBanner, importOffer, endImportOffer, inboxThumbs, inboxHidden, inboxBanner };
}

export type Inbox = ReturnType<typeof useInbox>;
