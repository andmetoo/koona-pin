import "../reader/reader.css";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { ALargeSmall, Check, Ellipsis, ExternalLink, Heart } from "lucide-react";
import type { Route } from "../navigation/stack";
import { usePhone } from "../PhoneContext";
import { Button, CircleButton } from "../ui/buttons";
import { PhIcon } from "../ui/icons";
import { Screen } from "../ui/Screen";
import { ArticleFailure, ReaderBar } from "../reader/parts";
import { phoneReaderLook, useScreenLook } from "../reader/look";
import { ArticleView, type ArticleStatus } from "../../../components/reader/ArticleView";
import { SiteMark } from "../../../components/library/Bookmarks";
import { usePicture } from "../../../hooks/usePicture";
import { useReadingProgress } from "../../../hooks/useReadingProgress";
import { api } from "../../../services/api";
import { coverOf, siteName } from "../../../services/cover";
import { knownMinutes, readingMinutes } from "../../../services/reader";
import type { Bookmark, BookmarkChange } from "../../../types";

/**
 * R1 Reader (NP-072b): one bookmark, full bleed, pushed over its tab. Glass circles over the top
 * edge's fade (Back; Aa, the reading look as a sheet; more, the bookmark's menu); the hero picture
 * with the site and a big title; the source line, the title, the authors, a short rule and the
 * page's text in Literata (`ArticleView`, the reader's extraction; no offline copy: the text
 * comes from the page). A floating action pill: favourite, open original, how far it is read, and
 * Done, which takes the bookmark out of Reading and goes back. A page that cannot be read shows
 * why and opens the original. There is no Share: the app has no way to share on a phone yet.
 */
export function ReaderScreen({ route, hidden }: { route: Extract<Route, { name: "reader" }>; hidden: boolean }) {
  const { app, stack, sheets } = usePhone();
  const { t } = app;
  const bookmark = useRouteBookmark(route.bookmarkId, app.library.bookmarks);
  if (!bookmark)
    return (
      <Screen label={t("phone.reader.title")} hidden={hidden} route className="rd-screen">
        <ReaderBar
          onBack={stack.back}
          actions={<CircleButton icon={Ellipsis} size={44} label={t("phone.reader.more")} onClick={() => sheets.open({ kind: "bookmarkMenu", props: { bookmarkId: route.bookmarkId } })} />}
        />
        <div className="rd-column rd-loading" role="status" aria-label={t("reader.loading")} />
      </Screen>
    );
  return <Reader key={bookmark.id} bookmark={bookmark} hidden={hidden} />;
}

function Reader({ bookmark: b, hidden }: { bookmark: Bookmark; hidden: boolean }) {
  const { app, stack, sheets } = usePhone();
  const { t, readerLook } = app;
  const scroller = useRef<HTMLElement | null>(null);
  const [status, setStatus] = useState<ArticleStatus | null>(null);
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const progress = useReadingProgress(b, scroller, ready);
  const article = status?.kind === "article" ? status.article : null;
  const minutes = article ? readingMinutes(article.words) : knownMinutes(b.url);
  const percent = Math.round(progress * 100);
  const look = useMemo(() => phoneReaderLook(readerLook.look, readerLook.choice), [readerLook.look, readerLook.choice]);
  useScreenLook(scroller, look);

  // Where reading stopped: the article, once on the page, scrolls there; from then on scrolling counts.
  const restore = () =>
    requestAnimationFrame(() => {
      const element = scroller.current;
      if (element && b.reading_progress > 0 && b.reading_progress < 1)
        element.scrollTo({ top: b.reading_progress * (element.scrollHeight - element.clientHeight) });
      setReady(true);
    });

  const done = () => {
    if (b.reading_at) app.readingChange(b, { action: "reading", reading: false });
    stack.back();
  };

  return (
    <Screen label={b.title || b.url} hidden={hidden} route className="rd-screen" scrollRef={scroller}>
      <>
        <ReaderBar
          onBack={stack.back}
          actions={
            <>
              <CircleButton icon={ALargeSmall} size={44} label={t("readerAa.label")} onClick={() => sheets.open({ kind: "readerLook", props: {} })} />
              <CircleButton
                icon={Ellipsis}
                size={44}
                label={t("phone.reader.more")}
                onClick={() => sheets.open({ kind: "bookmarkMenu", props: { bookmarkId: b.id } })}
              />
            </>
          }
        />
        <div className="rd-column">
          <Hero b={b} articleTitle={article?.title ?? null} />
          <ArticleView
            url={b.url}
            title={b.title || b.url}
            domain={b.domain}
            bookmarkId={b.id}
            offlineAt={null}
            attempt={attempt}
            onOpen={app.open}
            onStatus={setStatus}
            onReady={restore}
            header={
              <p className="rd-source">
                <SiteMark b={b} size={20} />
                <span className="truncate">{[b.domain, minutes !== null && t("reader.minutes", { count: minutes })].filter(Boolean).join(" · ")}</span>
              </p>
            }
            byline={
              <>
                {article?.author && <p className="rd-authors">{article.author}</p>}
                <hr className="rd-rule" />
              </>
            }
            failure={(failure) => (
              <ArticleFailure failure={failure} onOpen={() => app.open(b.url)} onRetry={() => setAttempt((n) => n + 1)} />
            )}
          />
        </div>
      </>
      <div className="rd-dock">
        <div className="rd-fade-bottom" aria-hidden="true" />
        <div role="toolbar" aria-label={t("phone.reader.actions")} className="rd-actions ph-glass">
          <button
            type="button"
            className="rd-action ph-hit"
            aria-label={b.is_favorite ? t("card.unfavorite") : t("card.favorite")}
            aria-pressed={b.is_favorite}
            onClick={() => app.actions.favorite(b)}
          >
            <PhIcon icon={Heart} className={b.is_favorite ? "rd-filled" : undefined} />
          </button>
          <button type="button" className="rd-action ph-hit" aria-label={t("phone.reader.openOriginal")} onClick={() => app.open(b.url)}>
            <PhIcon icon={ExternalLink} />
          </button>
          <div className="rd-progress" role="progressbar" aria-label={t("phone.reader.progress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <span className="rd-percent">{t("phone.reader.percent", { percent })}</span>
            <span className="rd-track" aria-hidden="true">
              <span className="rd-fill" style={{ "--value": progress } as CSSProperties} />
            </span>
          </div>
          <span className="rd-divider" aria-hidden="true" />
          <Button kind="primary" icon={Check} className="rd-done" onClick={done}>
            {t("phone.reader.done")}
          </Button>
        </div>
      </div>
    </Screen>
  );
}

const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * R1's hero (r 24): the page's picture, or the site's gradient when it has none, with the site
 * (and the collection) as its eyebrow and the saved title over it. When the saved title is the
 * article's own, it is not said twice: a picture keeps only its eyebrow, a gradient shows the
 * site's name as the desktop's poster covers do.
 */
function Hero({ b, articleTitle }: { b: Bookmark; articleTitle: string | null }) {
  const { app } = usePhone();
  const picture = usePicture("bookmark-image", b.id, b.image_url);
  const cover = useMemo(() => coverOf(b.domain, b.url), [b.domain, b.url]);
  const site = siteName(b);
  const collection = app.library.collections.find((c) => c.id === b.collection_id)?.name;
  const own = b.title || b.url;
  const repeats = plain(own) === plain(articleTitle ?? own);
  const overlay = !repeats ? own : picture.src ? null : site;
  const eyebrow = [overlay === site ? b.domain : site, collection].filter(Boolean).join(" · ");
  return (
    <figure
      className="rd-hero"
      data-picture={picture.src ? "" : undefined}
      style={{ "--from": cover.from, "--to": cover.to, "--angle": `${cover.angle}deg` } as CSSProperties}
    >
      {picture.src && (
        <img key={picture.src} src={picture.src} alt="" decoding="async" referrerPolicy="no-referrer" onError={picture.onError} onLoad={picture.onLoad} />
      )}
      <figcaption>
        <span className="ph-eyebrow">{eyebrow}</span>
        {overlay && <span className="rd-hero-title">{overlay}</span>}
      </figcaption>
    </figure>
  );
}

/**
 * The bookmark of the route: the library's copy while the list has it, else read once by id (a
 * bookmark the list has not paged in, or one moved out of the section meanwhile), kept up to
 * date by the library's change events. Null until known.
 */
function useRouteBookmark(id: number, loaded: Bookmark[]): Bookmark | null {
  const listed = loaded.find((b) => b.id === id) ?? null;
  const [own, setOwn] = useState<Bookmark | null>(null);
  useEffect(() => {
    if (listed) return;
    let alive = true;
    api.getBookmarks({}, { id, limit: 1 }).then(
      (page) => alive && page.items[0] && setOwn(page.items[0]),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [id, !!listed]);
  useEffect(() => {
    const take = (change: BookmarkChange) => change.id === id && change.bookmark && setOwn(change.bookmark);
    const offs = [api.onBookmarkChanged(take), api.onBookmarksChanged((changes) => changes.forEach(take))];
    return () => offs.forEach((off) => off());
  }, [id]);
  // The last one known stays on screen: a bookmark moved to the Trash from its menu is still read.
  const last = useRef<Bookmark | null>(null);
  last.current = listed ?? own ?? last.current;
  return last.current;
}
