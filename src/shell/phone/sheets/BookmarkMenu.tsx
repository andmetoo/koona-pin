import { useEffect, useState } from "react";
import { BookCheck, BookOpen, Copy, ExternalLink, FolderInput, Heart, Pencil, Trash2 } from "lucide-react";
import { api } from "../../../services/api";
import type { Bookmark } from "../../../types";
import "../library/library.css";
import { usePhone } from "../PhoneContext";
import { Sheet, useCloseSheet } from "../ui/Sheet";
import { Shelf, ShelfRow } from "../ui/Shelf";

/**
 * `bookmark`: the one the opener has at hand (a search result is not in the app's list); the menu
 * takes the app's own copy when it has it, and reads it by id when neither is there.
 */
export type BookmarkMenuProps = {
  bookmarkId: number;
  bookmark?: Bookmark;
  /**
   * Opened from the reader: its own "finish" (read, onto Reading's Read page, one Undo, once),
   * which "Mark as read" runs there, so the reader's state and its guard see it.
   */
  onFinish?: () => void;
};

/**
 * A bookmark's long-press menu (NP-072b): a detached sheet with its title and site, and the
 * actions of the desktop's card menu that make sense on a phone — open the original, edit, the
 * favourite, Reading (and read or unread there), file into a collection (the collection picker),
 * copy the link, and the trash with Undo in the snackbar. Left out: offline copies (the phone keeps
 * none), "Refresh preview" (pull to refresh does it for the list), tags (not on the desktop's menu
 * yet) and sharing as a list (the share bundle is not on the phone). Opens with a haptic tick.
 */
export function BookmarkMenu({ props }: { props: BookmarkMenuProps }) {
  const { app, sheets } = usePhone();
  const { t, actions } = app;
  const close = useCloseSheet();
  const bookmark = useBookmark(props.bookmarkId, props.bookmark);
  const run = (action: (b: Bookmark) => void) => () => {
    close();
    if (bookmark) action(bookmark);
  };
  const name = bookmark ? bookmark.title || bookmark.url : "";
  return (
    <Sheet label={name || t("phone.reader.more")} title={name && <span className="lib-menu-title">{name}</span>} subtitle={bookmark?.domain}>
      {bookmark && (
        <>
          <Shelf className="lib-menu-shelf">
            <ShelfRow icon={ExternalLink} title={t("phone.bookmarkMenu.open")} onClick={run((b) => actions.open(b.url))} />
            <ShelfRow icon={Pencil} title={t("phone.bookmarkMenu.edit")} onClick={run(actions.edit)} />
            <ShelfRow icon={Heart} title={bookmark.is_favorite ? t("card.unfavorite") : t("card.favorite")} onClick={run(actions.favorite)} />
            <ShelfRow
              icon={BookOpen}
              title={bookmark.reading_at ? t("card.fromReading") : t("card.toReading")}
              onClick={run(actions.reading)}
            />
            {/* Read or not matters in Reading, and for an article read once (as on the desktop). */}
            {(bookmark.reading_at || bookmark.read_at) && (
              <ShelfRow
                icon={BookCheck}
                title={bookmark.read_at ? t("card.markUnread") : t("card.markRead")}
                onClick={run(props.onFinish && bookmark.reading_at && !bookmark.read_at ? props.onFinish : actions.read)}
              />
            )}
            <ShelfRow
              icon={FolderInput}
              title={t("phone.bookmarkMenu.collection")}
              onClick={run((b) => sheets.open({ kind: "collectionPicker", props: { bookmarkIds: [b.id] } }))}
            />
            <ShelfRow icon={Copy} title={t("card.copyLink")} onClick={run((b) => actions.copy(b.url))} />
          </Shelf>
          <Shelf className="lib-menu-shelf">
            <ShelfRow icon={Trash2} title={t("phone.bookmarkMenu.trash")} onClick={run(actions.trash)} />
          </Shelf>
        </>
      )}
    </Sheet>
  );
}

/** The bookmark by id: the app's loaded copy (live), else the one given, else read once. */
function useBookmark(id: number, given: Bookmark | undefined): Bookmark | null {
  const { app } = usePhone();
  const loaded = app.library.bookmarks.find((b) => b.id === id);
  const [read, setRead] = useState<Bookmark | null>(null);
  const known = loaded ?? given;
  useEffect(() => {
    if (known) return;
    let alive = true;
    void api
      .getBookmarks({}, { id, limit: 1 })
      .then((page) => alive && setRead(page.items[0] ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, !!known]);
  return known ?? (read?.id === id ? read : null);
}
