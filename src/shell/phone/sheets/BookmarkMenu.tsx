import { FolderInput, Pencil, Trash2 } from "lucide-react";
import { usePhone } from "../PhoneContext";
import { Sheet, useCloseSheet } from "../ui/Sheet";
import { Shelf, ShelfRow } from "../ui/Shelf";

export type BookmarkMenuProps = { bookmarkId: number };

/**
 * A bookmark's long-press menu (stub, NP-072b wave 0; wave 1 replaces it): long-press menus are
 * sheets; this one opens with a haptic tick (useSheets).
 */
export function BookmarkMenu({ props }: { props: BookmarkMenuProps }) {
  const { app, sheets } = usePhone();
  const { t } = app;
  const close = useCloseSheet();
  const bookmark = app.library.bookmarks.find((b) => b.id === props.bookmarkId);
  return (
    <Sheet label={bookmark?.title || bookmark?.url || t("phone.reader.more")} title={bookmark?.title || bookmark?.url} subtitle={bookmark?.domain}>
      <Shelf className="-mx-4">
        <ShelfRow
          icon={Pencil}
          title={t("phone.bookmarkMenu.edit")}
          onClick={() => {
            close();
            if (bookmark) app.setEditing(bookmark);
          }}
        />
        <ShelfRow
          icon={FolderInput}
          title={t("phone.bookmarkMenu.collection")}
          onClick={() => {
            close();
            sheets.open({ kind: "collectionPicker", props: { bookmarkIds: [props.bookmarkId] } });
          }}
        />
        <ShelfRow
          icon={Trash2}
          title={t("phone.bookmarkMenu.trash")}
          onClick={() => {
            close();
            if (bookmark) app.actions.trash(bookmark);
          }}
        />
      </Shelf>
    </Sheet>
  );
}
