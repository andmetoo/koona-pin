import { Search } from "lucide-react";
import { usePhone } from "../PhoneContext";
import { CircleButton } from "../ui/buttons";
import { Screen, Header } from "../ui/Screen";
import { Shelf } from "../ui/Shelf";
import { useLongPress } from "../ui/useLongPress";
import type { Bookmark } from "../../../types";

/**
 * L1/L2 Library (stub, NP-072b wave 0; wave 1 replaces it): All bookmarks, and the Reading tab with
 * `section="reading"`. The app's filters already show the tab's section (navigation/usePhoneStack).
 */
export function LibraryScreen({ section, hidden }: { section: "all" | "reading"; hidden: boolean }) {
  const { app, stack } = usePhone();
  const { t } = app;
  const title = section === "reading" ? t("phone.nav.reading") : t("phone.library.title");
  return (
    <Screen label={title} hidden={hidden}>
      <Header
        title={title}
        meta={t("phone.library.count", { count: app.sectionCount })}
        actions={<CircleButton icon={Search} label={t("phone.search.title")} onClick={() => stack.push({ name: "search" })} />}
      />
      <Shelf>
        {app.library.bookmarks.slice(0, 12).map((b) => (
          <Row key={b.id} bookmark={b} />
        ))}
      </Shelf>
      <p className="ph-stub">{t("phone.stub")}</p>
    </Screen>
  );
}

/** A plain row: a tap opens the reader, a long press the bookmark's menu. */
function Row({ bookmark }: { bookmark: Bookmark }) {
  const { stack, sheets } = usePhone();
  const press = useLongPress(() => sheets.open({ kind: "bookmarkMenu", props: { bookmarkId: bookmark.id } }));
  return (
    <button type="button" className="ph-shelf-row" data-bookmark-id={bookmark.id} onClick={() => stack.push({ name: "reader", bookmarkId: bookmark.id })} {...press}>
      <span className="ph-shelf-text">
        <span className="ph-row">{bookmark.title || bookmark.url}</span>
        <span className="ph-meta">{bookmark.domain}</span>
      </span>
    </button>
  );
}
