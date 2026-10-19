import "../reader/reader.css";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { ALargeSmall, BookCheck, Ellipsis, ExternalLink, Heart } from "lucide-react";
import type { Route } from "../navigation/stack";
import { useBottomLift, usePhone } from "../PhoneContext";
import { CircleButton } from "../ui/buttons";
import { PhIcon } from "../ui/icons";
import { Screen } from "../ui/Screen";
import { ArticleFailure, ReaderBar } from "../reader/parts";
import { LiquidProgress } from "../reader/LiquidProgress";
import { ColumnActions, ColumnThumb } from "../ui/ColumnActions";
import { phoneReaderLook, useScreenLook } from "../reader/look";
import { ArticleView, type ArticleStatus } from "../../../components/reader/ArticleView";
import { SiteMark } from "../../../components/library/Bookmarks";
import { usePicture } from "../../../hooks/usePicture";
import { useReadingProgress } from "../../../hooks/useReadingProgress";
import { api } from "../../../services/api";
import { describeError } from "../../../services/errors";
import { coverOf, siteName } from "../../../services/cover";
import { knownMinutes, readingMinutes } from "../../../services/reader";
import type { Bookmark, BookmarkChange } from "../../../types";

/**
 * R1 Reader (NP-072b): one bookmark, full bleed, pushed over its tab. Glass circles over the top
 * edge's fade (Back; Aa, the reading look as a sheet; more, the bookmark's menu); the hero picture
 * with the site and a big title; the source line, the title, the authors, a short rule and the
 * page's text in Literata (`ArticleView`, the reader's extraction; no offline copy: the text
 * comes from the page). A floating action pill: favourite, open original and how far it is read,
 * a pie (owner, 19 October: no Done). Pulling the pie up out of the pill finishes the reading (it
 * leaves Reading, with Undo); a tap asks first; at the article's end a quiet row offers the same,
 * as the ⋯ menu does. On iPhone Duo's outer display the pill gives way to the column (DO2): the
 * actions on a slab under the status block, the navigation, and the progress as a drop to pull up
 * in the thumb zone with the time left above it. A page that cannot be read shows why and opens
 * the original. There is no Share: the app has no way to share on a phone yet.
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
  const { app, stack, sheets, bar, fold } = usePhone();
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

  // Finishing takes the bookmark out of Reading, with Undo in the snackbar; the reader stays.
  const inReading = !!b.reading_at;
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    if (inReading) setFinished(false);
  }, [inReading]);
  const finish = () => {
    if (!b.reading_at) return;
    setFinished(true);
    void api
      .bulkUpdate([b.id], { action: "reading", reading: false })
      .then(({ command }) => app.say(t("phone.reader.finished", { title: b.title || b.domain || b.url }), false, app.undoing(command)))
      .catch((err) => {
        setFinished(false);
        app.say(describeError(err), true);
      });
  };
  const ask = () => sheets.open({ kind: "finishReading", props: { onFinish: finish } });
  const left = minutes !== null && progress < 1 ? Math.max(1, Math.ceil(minutes * (1 - progress))) : null;
  const value = finished
    ? t("phone.reader.finishedState")
    : left !== null
      ? t("phone.reader.readLeft", { percent, count: left })
      : t("phone.reader.readValue", { percent });
  const outer = !!bar && !fold;
  // "Finished · Undo" and the other notices sit above the pill, not over it.
  useBottomLift(72, !hidden && !outer && !fold);
  const progressProps = {
    progress,
    label: t("phone.reader.progress"),
    value,
    finishLabel: inReading ? t("phone.reader.finish") : null,
    finished,
    onFinish: finish,
    onAsk: ask,
  };
  const favorite = (
    <button
      type="button"
      className="rd-action ph-hit"
      aria-label={b.is_favorite ? t("card.unfavorite") : t("card.favorite")}
      aria-pressed={b.is_favorite}
      onClick={() => app.actions.favorite(b)}
    >
      <PhIcon icon={Heart} className={b.is_favorite ? "rd-filled" : undefined} />
    </button>
  );
  const original = (
    <button type="button" className="rd-action ph-hit" aria-label={t("phone.reader.openOriginal")} onClick={() => app.open(b.url)}>
      <PhIcon icon={ExternalLink} />
    </button>
  );

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
          {/* The quiet way out of Reading at the article's end (with the ⋯ menu's "Remove from Reading"). */}
          {article && inReading && !finished && (
            <div className="rd-end" data-reader-end>
              <span className="rd-end-text">
                <span className="ph-headline">{t("phone.reader.end")}</span>
                {minutes !== null && <span className="ph-meta">{t("reader.minutes", { count: minutes })}</span>}
              </span>
              <button type="button" className="rd-end-action ph-hit" onClick={finish}>
                <PhIcon icon={BookCheck} at="field" />
                {t("card.fromReading")}
              </button>
            </div>
          )}
        </div>
      </>
      {outer ? (
        // DO2: the actions on a slab under the status block, the progress as the drop in the thumb zone.
        <>
          <div className="rd-dock">
            <div className="rd-fade-bottom" aria-hidden="true" />
          </div>
          <ColumnActions rank={0} active={!hidden}>
            <div role="toolbar" aria-label={t("phone.reader.actions")} className="ph-vbar-slab ph-glass">
              {favorite}
              {original}
            </div>
          </ColumnActions>
          {/* Nothing to read (loading, a page that cannot be shown): no drop, the navigation stays low. */}
          <ColumnThumb active={!hidden && !!article}>
            <LiquidProgress
              variant="drop"
              threshold={120}
              caption={finished ? t("phone.reader.finishedState") : left !== null ? t("phone.reader.minLeft", { count: left }) : undefined}
              {...progressProps}
            />
          </ColumnThumb>
        </>
      ) : (
        <div className="rd-dock">
          <div className="rd-fade-bottom" aria-hidden="true" />
          <div role="toolbar" aria-label={t("phone.reader.actions")} className="rd-actions ph-glass">
            {favorite}
            {original}
            <span className="rd-divider" aria-hidden="true" />
            <LiquidProgress variant="pie" threshold={80} {...progressProps} />
          </div>
        </div>
      )}
    </Screen>
  );
}

const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * R1's hero (r 24), and FL1's in the Fold's detail sheet: the page's picture, or the site's
 * gradient when it has none, with the site (and the collection) as its eyebrow. A picture keeps
 * only its eyebrow: pages' pictures often carry words of their own, and a title over them cannot be
 * read. A gradient shows the saved title, or the site's name (as the desktop's poster covers do)
 * when the title is the article's own.
 */
export function Hero({ b, articleTitle }: { b: Bookmark; articleTitle: string | null }) {
  const { app } = usePhone();
  const picture = usePicture("bookmark-image", b.id, b.image_url);
  const cover = useMemo(() => coverOf(b.domain, b.url), [b.domain, b.url]);
  const site = siteName(b);
  const collection = app.library.collections.find((c) => c.id === b.collection_id)?.name;
  const own = b.title || b.url;
  const repeats = plain(own) === plain(articleTitle ?? own);
  const overlay = picture.src ? null : !repeats ? own : site;
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
export function useRouteBookmark(id: number, loaded: Bookmark[]): Bookmark | null {
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
