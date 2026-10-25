import "../reader/reader.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ALargeSmall, BookmarkCheck, BookmarkPlus, BookOpen, ExternalLink, Heart } from "lucide-react";
import type { Route } from "../navigation/stack";
import { usePhone, usePrimaryAction } from "../PhoneContext";
import { PaneBar } from "../fold/PaneBar";
import { updatePost, usePost } from "../feeds/posts";
import { phoneReaderLook, useScreenLook } from "../reader/look";
import { ReaderBar } from "../reader/parts";
import { Button, CircleButton } from "../ui/buttons";
import { Screen } from "../ui/Screen";
import { FeedIcon } from "../../../components/feeds/FeedIcon";
import { ArticleView, failureText } from "../../../components/reader/ArticleView";
import { usePicture } from "../../../hooks/usePicture";
import { api } from "../../../services/api";
import { describeError } from "../../../services/errors";
import { feedName, getFeedArticle, saveFeedItem, setFeedItemsRead } from "../../../services/feeds";
import { markViewable, unmarkViewable } from "../../../services/articlePictures";
import { articleOfPost, captionOf, pictureUrl, publishedLine, startsWithPicture } from "../../../services/feedsView";
import { type Article, cachedArticle, readingMinutes } from "../../../services/reader";
import type { Bookmark, BookmarkChange, FeedArticle } from "../../../types";

/** Opening a post marks it read after this long, as on the desktop (NP-132). */
const READ_AFTER_MS = 1000;

/**
 * A feed's post (FL2's content on a phone), pushed over Feeds: the source with the feed's avatar,
 * the author, the date and the minutes; the title; the post in Literata at the reading look.
 * Glass circles: Aa, open original, favourite and "Save as bookmark" — a post becomes a bookmark
 * only when saved (favourite saves it too, as the desktop's F does). A summary-only post offers
 * the full article, read from the page on that tap only. Back returns to the list.
 *
 * On the Fold (FL2) it fills the detail sheet beside Feeds: clear circles along its top — Aa on the
 * outer side; open original, favourite and Reading next to the list — and Save as the rail's
 * primary circle.
 */
export function PostScreen({ route, hidden }: { route: Extract<Route, { name: "post" }>; hidden: boolean }) {
  const { app, stack, sheets, fold } = usePhone();
  const { t, i18n, readerLook } = app;
  const id = route.itemId;
  const item = usePost(id);
  const feed = item ? app.feeds?.find((f) => f.uid === item.feed_uid) : route.feedUid ? app.feeds?.find((f) => f.uid === route.feedUid) : undefined;
  const scroller = useRef<HTMLElement | null>(null);
  const look = useMemo(() => phoneReaderLook(readerLook.look, readerLook.choice), [readerLook.look, readerLook.choice]);
  useScreenLook(scroller, look);

  const [post, setPost] = useState<FeedArticle | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [page, setPage] = useState<Article | null>(null);
  const [full, setFull] = useState<{ busy: boolean; failure: string | null }>({ busy: false, failure: null });
  useEffect(() => {
    let alive = true;
    getFeedArticle(id).then(
      (next) => alive && setPost(next),
      (err) => alive && setFailure(describeError(err)),
    );
    return () => {
      alive = false;
    };
  }, [id]);

  // Read after a second on screen, as the desktop marks it.
  const unread = !!item && !item.read;
  useEffect(() => {
    if (!unread || hidden) return;
    const timer = window.setTimeout(() => {
      updatePost(id, { read: true });
      void setFeedItemsRead([id], true).catch(() => {});
    }, READ_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [id, unread, hidden]);

  const { bookmark, hold, reload } = usePostBookmark(item?.bookmark_id ?? null);
  // Saved here: the list underneath shows it at once, also for a post it keeps on Unread.
  const savedAs = bookmark?.id ?? null;
  useEffect(() => {
    if (savedAs !== null) updatePost(id, { bookmark_id: savedAs });
  }, [id, savedAs]);
  const url = post?.url ?? item?.url ?? null;
  const saved = !!bookmark || (item?.bookmark_id ?? null) !== null;
  const favorite = !!bookmark?.is_favorite;
  const reading = !!bookmark?.reading_at;

  const name = feed ? feedName(feed) : null;
  const cached = useMemo(() => (post ? articleOfPost(post, name) : null), [post, name]);
  const article = page ?? cached;
  const opensWithPicture = useMemo(() => !cached || startsWithPicture(cached.html), [cached]);
  const leadPicture = page || opensWithPicture ? null : pictureUrl(item?.thumbnail_url);
  const lead = usePicture("post-thumb", id, leadPicture, { webFirst: true });
  const caption = useMemo(() => (leadPicture && post && item ? captionOf(item.excerpt, post.html) : null), [leadPicture, post, item]);

  const failed = (err: unknown) => app.say(describeError(err), true);
  /**
   * "Save as bookmark", the heart and (on the Fold) Reading: the post becomes a bookmark (the
   * desktop's S, F and R); the heart and Reading again take a saved one out.
   */
  const save = async (kind: "library" | "favorite" | "reading") => {
    if (!url) return app.say(t("feeds.notice.noLink"), true);
    try {
      if (kind === "library" && saved) return app.say(t("feeds.notice.alreadySaved"));
      if (kind === "favorite" && bookmark?.is_favorite) {
        const { command } = await api.bulkUpdate([bookmark.id], { action: "favorite", favorite: false });
        await reload(bookmark.id);
        return app.say(t("feeds.notice.unfavorited"), false, app.undoing(command));
      }
      if (kind === "reading" && bookmark?.reading_at) {
        const { command } = await api.bulkUpdate([bookmark.id], { action: "reading", reading: false });
        await reload(bookmark.id);
        return app.say(t("notice.fromReading"), false, app.undoing(command));
      }
      const result = await saveFeedItem(id, kind === "reading" ? "reading" : "library", kind === "favorite");
      let command = result.command;
      let topped = false;
      // A link already in the library comes back as it was: the heart and Reading still do what they say.
      if (kind === "favorite" && !result.bookmark.is_favorite) {
        ({ command } = await api.bulkUpdate([result.bookmark.id], { action: "favorite", favorite: true }));
        topped = true;
      } else if (kind === "reading" && !result.bookmark.reading_at) {
        ({ command } = await api.bulkUpdate([result.bookmark.id], { action: "reading", reading: true }));
        topped = true;
      }
      if (topped) await reload(result.bookmark.id);
      else hold(result.bookmark);
      const undo = result.created && !topped ? () => app.unsave(result.bookmark.id, false) : command !== null ? app.undoing(command) : undefined;
      const there = !result.created && result.command === null && !topped;
      const text = there
        ? t("feeds.notice.alreadySaved")
        : kind === "favorite"
          ? t("feeds.notice.favorited")
          : kind === "reading"
            ? t("notice.toReading")
            : t("add.savedTo", { place: t("import.library") });
      app.say(text, false, undo);
    } catch (err) {
      failed(err);
    }
  };

  // On the Fold, Save is the rail's primary circle (FL2).
  usePrimaryAction(
    { icon: saved ? BookmarkCheck : BookmarkPlus, label: saved ? t("phone.post.saved") : t("phone.post.save"), pressed: saved, run: () => void save("library") },
    fold && !hidden,
  );

  const title = post?.title ?? item?.title ?? "";
  const meta = [
    publishedLine(post?.published_at ?? item?.published_at ?? null, t, i18n.language),
    article && t("reader.minutes", { count: readingMinutes(article.words) }),
  ]
    .filter(Boolean)
    .join(" · ");
  const author = article?.author ?? item?.author ?? null;

  return (
    <Screen label={title || t("phone.post.title")} hidden={hidden} route className="rd-screen rd-post" scrollRef={scroller}>
      {fold ? (
        // FL2: clear circles along the detail sheet's top; Save is the rail's primary circle.
        <PaneBar
          outer={<CircleButton icon={ALargeSmall} kind="clear" size={44} label={t("readerAa.label")} onClick={() => sheets.open({ kind: "readerLook", props: {} })} />}
          near={
            <>
              <CircleButton icon={ExternalLink} kind="clear" size={44} label={t("phone.reader.openOriginal")} disabled={!url} onClick={() => url && app.open(url)} />
              <CircleButton
                icon={Heart}
                kind="clear"
                size={44}
                label={favorite ? t("card.unfavorite") : t("card.favorite")}
                aria-pressed={favorite}
                className={favorite ? "rd-pressed" : undefined}
                onClick={() => void save("favorite")}
              />
              <CircleButton
                icon={BookOpen}
                kind="clear"
                size={44}
                label={reading ? t("phone.post.inReading") : t("phone.post.toReading")}
                aria-pressed={reading}
                className={reading ? "rd-pressed" : undefined}
                onClick={() => void save("reading")}
              />
            </>
          }
        />
      ) : (
        <ReaderBar
          onBack={stack.back}
          actions={
            // One glass capsule for the four, flat circles on it: the screen keeps to four blurred layers.
            <div className="rd-cluster ph-glass">
              <CircleButton icon={ALargeSmall} kind="flat" size={40} label={t("readerAa.label")} onClick={() => sheets.open({ kind: "readerLook", props: {} })} />
              <CircleButton icon={ExternalLink} kind="flat" size={40} label={t("phone.reader.openOriginal")} disabled={!url} onClick={() => url && app.open(url)} />
              <CircleButton
                icon={Heart}
                kind="flat"
                size={40}
                label={favorite ? t("card.unfavorite") : t("card.favorite")}
                aria-pressed={favorite}
                className={favorite ? "rd-pressed" : undefined}
                onClick={() => void save("favorite")}
              />
              <CircleButton
                icon={saved ? BookmarkCheck : BookmarkPlus}
                kind="flat"
                size={40}
                label={saved ? t("phone.post.saved") : t("phone.post.save")}
                aria-pressed={saved}
                className={saved ? "rd-pressed" : undefined}
                onClick={() => void save("library")}
              />
            </div>
          }
        />
      )}
      <div className="rd-column">
        {failure ? (
          <p role="status" className="rd-failure ph-subhead">
            {failure}
          </p>
        ) : (
          <ArticleView
            url={url ?? ""}
            title={title}
            domain=""
            onOpen={app.open}
            article={article ?? undefined}
            // The post's own copy, never the page while it is on its way (NP-120).
            fetches={false}
            header={
              <div className="rd-post-source">
                <span className="rd-post-feed">
                  {feed && <FeedIcon feed={feed} size={24} round />}
                  <span className="truncate" data-user-text>{[name, author].filter(Boolean).join(" · ")}</span>
                </span>
                {meta && <span>{meta}</span>}
              </div>
            }
            lead={
              lead.src ? (
                <figure className="rd-post-lead">
                  <img
                    src={lead.src}
                    alt=""
                    referrerPolicy="no-referrer"
                    // A button for the picture viewer once it has loaded; none while it fails.
                    onError={(e) => {
                      unmarkViewable(e.currentTarget);
                      lead.onError();
                    }}
                    onLoad={(e) => {
                      lead.onLoad(e);
                      markViewable(e.currentTarget, t("viewer.label"));
                    }}
                  />
                  {caption && <figcaption>{caption}</figcaption>}
                </figure>
              ) : null
            }
          />
        )}
        {post && !post.full && !page && url && (
          <div className="rd-load-full" data-load-full>
            <Button
              kind="clear"
              disabled={full.busy}
              onClick={() => {
                setFull({ busy: true, failure: null });
                // The page itself, through the reader's request, on this tap only (NP-120).
                cachedArticle(url).then(
                  (read) => {
                    if (read.ok) {
                      setPage(read.article);
                      setFull({ busy: false, failure: null });
                    } else setFull({ busy: false, failure: failureText(read.failure, t) });
                  },
                  (err: unknown) => setFull({ busy: false, failure: describeError(err) }),
                );
              }}
            >
              {full.busy ? t("feeds.loadingFull") : t("feeds.loadFull")}
            </Button>
            {full.failure && (
              <p role="status" className="ph-subhead">
                {full.failure}
              </p>
            )}
          </div>
        )}
      </div>
    </Screen>
  );
}

/**
 * The bookmark a post was saved as: read by id, held from a save's answer, kept up to date by the
 * library's change events. Null while the post is not saved.
 */
function usePostBookmark(id: number | null) {
  const [bookmark, setBookmark] = useState<Bookmark | null>(null);
  const reload = useCallback(async (which: number) => {
    const found = await api.getBookmarks({}, { id: which, limit: 1 }).then(
      (page) => page.items[0] ?? null,
      () => null,
    );
    setBookmark(found);
  }, []);
  useEffect(() => {
    if (id === null) return;
    void reload(id);
  }, [id, reload]);
  const current = bookmark?.id ?? id;
  useEffect(() => {
    if (current === null) return;
    const take = (change: BookmarkChange) => change.id === current && setBookmark(change.bookmark && !change.bookmark.deleted_at ? change.bookmark : null);
    const offs = [api.onBookmarkChanged(take), api.onBookmarksChanged((changes) => changes.forEach(take))];
    return () => offs.forEach((off) => off());
  }, [current]);
  return { bookmark, hold: setBookmark, reload };
}
