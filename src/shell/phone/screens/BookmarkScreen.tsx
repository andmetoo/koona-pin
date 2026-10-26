import "../reader/reader.css";
import "../fold/fold.css";
import { BookOpen, Ellipsis, ExternalLink, Hash, Heart, Pencil } from "lucide-react";
import type { Route } from "../navigation/stack";
import { usePhone, usePrimaryAction } from "../PhoneContext";
import { PaneBar } from "../fold/PaneBar";
import { ColumnActions } from "../ui/ColumnActions";
import { savedLine } from "../fold/savedLine";
import { CircleButton } from "../ui/buttons";
import { Chip } from "../ui/controls";
import { CollectionGlyph } from "../ui/CollectionGlyph";
import { PhIcon } from "../ui/icons";
import { Screen } from "../ui/Screen";
import { Hero, useRouteBookmark } from "./ReaderScreen";
import { SiteMark } from "../../../components/library/Bookmarks";
import { knownMinutes } from "../../../services/reader";
import type { Bookmark } from "../../../types";

/**
 * FL1 · a bookmark in the Fold's detail sheet (route `bookmark`, chosen from a list on the unfolded
 * Fold; a phone opens the reader instead). Clear circles along the sheet's top — more (the
 * bookmark's menu) on the outer side; open original and favourite next to the list — then the
 * reader's hero, the title, "site · Saved today, 9:12 · 12 min read", the description, chips for the
 * collection and the tags, and the note. The rail's primary circle reads it: the reader opens in
 * this sheet. There is no Share: the app has no way to share on a phone yet.
 */
export function BookmarkScreen({ route, hidden }: { route: Extract<Route, { name: "bookmark" }>; hidden: boolean }) {
  const { app, stack, fold } = usePhone();
  const { t } = app;
  const bookmark = useRouteBookmark(route.bookmarkId, app.library.bookmarks);
  usePrimaryAction(
    { icon: BookOpen, label: t("phone.detail.read"), run: () => stack.push({ name: "reader", bookmarkId: route.bookmarkId }) },
    fold && !hidden,
  );
  return (
    <Screen label={bookmark ? bookmark.title || bookmark.url : t("phone.reader.title")} hidden={hidden} route className="rd-screen fl-detail">
      {bookmark ? <Detail b={bookmark} shown={fold && !hidden} /> : <div className="rd-loading" role="status" aria-label={t("reader.loading")} />}
    </Screen>
  );
}

function Detail({ b, shown }: { b: Bookmark; shown: boolean }) {
  const { app, sheets } = usePhone();
  const { t, i18n } = app;
  const collection = app.library.collections.find((c) => c.id === b.collection_id);
  const minutes = knownMinutes(b.url);
  const source = [b.domain, savedLine(b.created_at, t, i18n.language), minutes !== null && t("reader.minutes", { count: minutes })].filter(Boolean).join(" · ");
  const edit = () => app.setEditing(b);
  return (
    <>
      <PaneBar
        outer={<CircleButton icon={Ellipsis} kind="clear" size={44} label={t("phone.reader.more")} onClick={() => sheets.open({ kind: "bookmarkMenu", props: { bookmarkId: b.id, bookmark: b } })} />}
        near={
          // On iPhone Duo they move into the vertical bar's slots, unless the list pane holds them (DU1).
          <ColumnActions rank={2} active={shown}>
            <CircleButton icon={ExternalLink} kind="clear" size={44} label={t("phone.reader.openOriginal")} onClick={() => app.open(b.url)} />
            <CircleButton
              icon={Heart}
              kind="clear"
              size={44}
              label={b.is_favorite ? t("card.unfavorite") : t("card.favorite")}
              aria-pressed={b.is_favorite}
              className={b.is_favorite ? "rd-pressed" : undefined}
              onClick={() => app.actions.favorite(b)}
            />
          </ColumnActions>
        }
      />
      <div className="fl-detail-body">
        <Hero b={b} articleTitle={null} />
        <h1 className="fl-detail-title">{b.title || b.url}</h1>
        <p className="rd-source fl-detail-source">
          <SiteMark b={b} size={18} />
          <span className="truncate">{source}</span>
        </p>
        {b.description && <p className="fl-detail-description">{b.description}</p>}
        {(collection || (b.tags?.length ?? 0) > 0) && (
          <div className="fl-detail-chips">
            {collection && (
              <Chip glyph={<CollectionGlyph collection={collection} />} onClick={() => sheets.open({ kind: "collectionPicker", props: { bookmarkIds: [b.id] } })}>
                {collection.name}
              </Chip>
            )}
            {b.tags?.map((tag) => (
              <Chip key={tag} icon={Hash} onClick={edit}>
                {tag}
              </Chip>
            ))}
          </div>
        )}
        {b.notes && (
          <button type="button" className="fl-note" onClick={edit}>
            <span className="fl-note-label">
              <PhIcon icon={Pencil} size={14} strokeWidth={1.5} />
              {t("phone.edit.noteField")}
            </span>
            <span className="fl-note-text">{b.notes}</span>
          </button>
        )}
      </div>
    </>
  );
}
