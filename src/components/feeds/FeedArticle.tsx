import { ReactNode, Ref, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, BookOpen, Check, ChevronDown, ChevronUp, Heart, Link, Maximize2, Minimize2, Plus, Rss } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Bookmark, Feed, FeedArticle as CachedPost, FeedItem } from "../../types";
import { feedName, getFeedArticle } from "../../services/feeds";
import { markViewable, unmarkViewable } from "../../services/articlePictures";
import { articleOfPost, captionOf, pictureUrl, publishedLine, startsWithPicture } from "../../services/feedsView";
import { Article, cachedArticle, readingMinutes } from "../../services/reader";
import { ReaderChoice, ReaderLook, readerStyle } from "../../services/readerLook";
import { describeError } from "../../services/errors";
import { Icon } from "../icons";
import { Hint } from "../ui/Hint";
import { AaButton } from "../reader/AaPanel";
import { ArticleView, failureText } from "../reader/ArticleView";
import { FeedIcon } from "./FeedIcon";
import { usePicture } from "../../hooks/usePicture";

export interface AaProps {
  choice: ReaderChoice;
  unlocked: boolean;
  onChoice: (choice: ReaderChoice) => void;
  onLocked: (wish: Pick<ReaderChoice, "theme">) => void;
  onSupporter: () => void;
}

/**
 * The article sheet (NP-132, Lunacy «Feeds 2.2 · 1» and «· 5»): a card inset 10 px, radius 18, its
 * bottom below the window's edge. On the left ← in a narrow window, else the expand button that
 * lays the card over the list up to the sidebar, then ⌃ K and ⌄ J (2.17.0); on the right Save S, Read later R, Favorite F,
 * a hairline, Open O and Aa — the reading look of the Aa panel. The cached post renders through
 * `ArticleView` with an `Article` built by `sanitize()`; a summary-only post offers «Load the full
 * article», read on that click only. At the end «Next story» J, with the next post's card peeking
 * below this one: going on flies this card up and that one into its place (FeedsPage).
 */
export function FeedArticleSheet({
  item,
  feed,
  bookmark,
  look,
  aa,
  narrow,
  expanded,
  next,
  nextFeed,
  scrollerRef,
  sheetRef,
  className = "",
  onBack,
  onExpand,
  onNext,
  onPrevious,
  hasNext = false,
  onSave,
  onReading,
  onFavorite,
  onOpen,
  onFeed,
}: {
  item: FeedItem | null;
  feed: Feed | undefined;
  /** The bookmark the post was saved as: ✓, Reading and the heart show its state. */
  bookmark: Bookmark | null;
  look: ReaderLook;
  aa: AaProps;
  narrow: boolean;
  /** Laid over the list (wide window only). */
  expanded: boolean;
  /** The post after this one in the list: its card peeks below the end. */
  next: FeedItem | null;
  nextFeed: Feed | undefined;
  scrollerRef?: Ref<HTMLDivElement>;
  sheetRef?: Ref<HTMLElement>;
  className?: string;
  onBack: () => void;
  onExpand: () => void;
  onNext: () => void;
  /** Absent on the first post of the list. */
  onPrevious?: () => void;
  /** A post after this one in the list: ⌄ moves to it. */
  hasNext?: boolean;
  onSave: () => void;
  onReading: () => void;
  onFavorite: () => void;
  onOpen: (url: string) => void;
  /** The chip: the list shows that feed. */
  onFeed: (uid: string) => void;
}) {
  const { t } = useTranslation();
  const saved = !!item && item.bookmark_id !== null;
  const reading = !!bookmark?.reading_at;
  const favorite = !!bookmark?.is_favorite;
  return (
    <section
      ref={sheetRef}
      aria-label={item ? item.title : t("feeds.article")}
      data-feed-article
      data-reader-look={look.theme}
      data-reader-font={look.font}
      style={readerStyle(look)}
      className={`reading-look feed-sheet mx-2.5 mt-2.5 -mb-6 flex min-w-0 flex-1 flex-col overflow-hidden rounded-[18px] bg-sheet text-sheet-ink ${className}`}
    >
      <header data-drop-head className="feed-toolbar flex h-[76px] shrink-0 items-center gap-[3px] pr-3 pl-[19px]">
        {/* ← where the sheet stands in for the list; beside it the card can spread over the list instead. */}
        {narrow ? (
          <ToolButton label={t("feeds.back")} keys="Esc" onClick={onBack}>
            <Icon icon={ArrowLeft} size={16} />
          </ToolButton>
        ) : (
          item && (
            <ToolButton label={expanded ? t("feeds.collapse") : t("feeds.expand")} keys="E" pressed={expanded} onClick={onExpand}>
              <Icon icon={expanded ? Minimize2 : Maximize2} size={16} />
            </ToolButton>
          )
        )}
        {/* J and K as buttons, for a mouse; dimmed at the ends of the list. */}
        {item && (
          <>
            <ToolButton label={t("feeds.previous")} keys="K" disabled={!onPrevious} onClick={() => onPrevious?.()}>
              <Icon icon={ChevronUp} size={18} />
            </ToolButton>
            <ToolButton label={t("feeds.next")} keys="J" disabled={!hasNext} onClick={onNext}>
              <Icon icon={ChevronDown} size={18} />
            </ToolButton>
          </>
        )}
        <span className="flex-1" />
        {item && (
          <>
            <ToolButton label={saved ? t("feeds.savedLabel") : t("feeds.save")} keys="S" pressed={saved} onClick={onSave}>
              <Icon icon={saved ? Check : Plus} size={16} />
            </ToolButton>
            <ToolButton label={t("feeds.readLater")} keys="R" pressed={reading} onClick={onReading}>
              <Icon icon={BookOpen} size={16} className={reading ? "fill-accent/15 text-accent" : ""} />
            </ToolButton>
            <ToolButton label={t("feeds.favorite")} keys="F" pressed={favorite} onClick={onFavorite}>
              <Icon icon={Heart} size={16} className={favorite ? "fill-accent text-accent" : ""} />
            </ToolButton>
            <span aria-hidden className="mx-1.5 h-5 w-px bg-sheet-line" />
            <ToolButton label={t("feeds.open")} keys="O" disabled={!item.url} onClick={() => item.url && onOpen(item.url)} end>
              <Icon icon={Link} size={16} />
            </ToolButton>
            <AaButton choice={aa.choice} look={look} unlocked={aa.unlocked} narrow onChoice={aa.onChoice} onLocked={aa.onLocked} onSupporter={aa.onSupporter} />
          </>
        )}
      </header>
      <div
        ref={scrollerRef}
        tabIndex={-1}
        data-feed-scroll
        className={`feed-scroll min-h-0 flex-1 overflow-y-auto px-6 pt-1 outline-none sm:px-16 ${item && next ? "" : "pb-24"}`}
      >
        {item ? (
          <>
            <Post key={item.id} item={item} feed={feed} onOpen={onOpen} onFeed={onFeed} />
            {(next || onPrevious) && <EndOfPost item={next} feed={nextFeed} onNext={onNext} onPrevious={onPrevious} />}
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 pb-16 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-secondary text-icon">
              <Icon icon={Rss} size={20} />
            </span>
            <p className="text-lg font-semibold text-ink">{t("feeds.pick")}</p>
            <p className="text-sm text-muted">{t("feeds.pickHint")}</p>
          </div>
        )}
      </div>
    </section>
  );
}

/** One post: the cached article, or the page itself after «Load the full article». */
function Post({ item, feed, onOpen, onFeed }: { item: FeedItem; feed: Feed | undefined; onOpen: (url: string) => void; onFeed: (uid: string) => void }) {
  const { t, i18n } = useTranslation();
  const [post, setPost] = useState<CachedPost | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [page, setPage] = useState<Article | null>(null);
  useEffect(() => {
    let alive = true;
    getFeedArticle(item.id).then(
      (next) => alive && setPost(next),
      (err) => alive && setFailure(describeError(err)),
    );
    return () => {
      alive = false;
    };
  }, [item.id]);
  const name = feed ? feedName(feed) : null;
  const cached = useMemo(() => (post ? articleOfPost(post, name) : null), [post, name]);
  const article = page ?? cached;
  const picture = pictureUrl(item.thumbnail_url);
  // These checks parse a whole article into a temporary DOM. Read marks, feed
  // counts and reader settings can rerender this post without changing its text.
  const opensWithPicture = useMemo(() => !cached || startsWithPicture(cached.html), [cached]);
  const leadPicture = page || opensWithPicture ? null : picture;
  // The lead is the post's thumbnail at full size: from the web while online,
  // the local copy of the thumbnail when the web does not answer (NP-146).
  const leadImage = usePicture("post-thumb", item.id, leadPicture, { webFirst: true });
  const caption = useMemo(() => (leadPicture && post ? captionOf(item.excerpt, post.html) : null), [leadPicture, post, item.excerpt]);

  if (failure)
    return (
      <p role="status" className="mx-auto max-w-[460px] py-20 text-center text-sm text-muted">
        {failure}
      </p>
    );

  const chip: ReactNode = feed ? (
    <button
      type="button"
      onClick={() => onFeed(feed.uid)}
      className="feed-chip inline-flex h-9 max-w-full items-center gap-2.5 rounded-full pr-4 pl-1.5 text-sm font-semibold"
    >
      <FeedIcon feed={feed} size={24} round />
      <span className="truncate">{name}</span>
    </button>
  ) : null;
  const byline = (
    <p className="feed-byline">
      {[publishedLine(item.published_at, t, i18n.language), article?.author ?? item.author, article && t("reader.minutes", { count: readingMinutes(article.words) })]
        .filter(Boolean)
        .join(" · ")}
    </p>
  );
  const lead = leadImage.src ? (
    <figure className="feed-lead">
      {/* It opens in the picture viewer (ArticleView), by Tab and Enter too, once it has loaded. */}
      <img src={leadImage.src} alt="" referrerPolicy="no-referrer"
        onError={(e) => {
          unmarkViewable(e.currentTarget);
          leadImage.onError();
        }}
        onLoad={(e) => {
          leadImage.onLoad(e);
          markViewable(e.currentTarget, t("viewer.label"));
        }}
        className="aspect-[680/382] w-full rounded-2xl bg-well object-cover" />
      {caption && <figcaption className="feed-caption">{caption}</figcaption>}
    </figure>
  ) : null;
  const url = item.url;
  return (
    <div className="feed-article">
      <ArticleView
        url={url ?? ""}
        title={item.title}
        domain=""
        onOpen={onOpen}
        article={article ?? undefined}
        // Until the cached post arrives the skeleton shows: the page itself is read only
        // on «Load the full article» (NP-120), never while the post is on its way.
        fetches={false}
        header={chip ?? undefined}
        byline={byline}
        lead={lead}
        onLoadFull={
          post && !post.full && !page && url
            ? async () => {
                // The page itself, through reading mode's request, on this click only (NP-120).
                const read = await cachedArticle(url);
                if (!read.ok) throw new Error(failureText(read.failure, t));
                setPage(read.article);
              }
            : undefined
        }
      />
    </div>
  );
}

/**
 * The end of a post (Lunacy «Feeds 2.2 · 5»): «Previous story» K and «Next story» J, this card's
 * round bottom, and the next post's card peeking below with its chip and title where the next
 * sheet will show them.
 */
function EndOfPost({ item, feed, onNext, onPrevious }: { item: FeedItem | null; feed: Feed | undefined; onNext: () => void; onPrevious?: () => void }) {
  const { t } = useTranslation();
  return (
    <div data-feed-next>
      <div className="flex flex-wrap justify-center gap-3 pt-12 pb-14">
        {onPrevious && (
          <Hint label={t("feeds.previous")} keys="K">
            <button
              type="button"
              data-feed-previous
              onClick={onPrevious}
              className="flex h-12 items-center gap-2.5 rounded-full pr-2.5 pl-5 text-[15px] font-semibold text-sheet-ink shadow-[inset_0_0_0_1px_var(--np-sheet-line)] transition-colors duration-150 hover:bg-hover"
            >
              <Icon icon={ArrowUp} size={16} />
              {t("feeds.previous")}
              <kbd className="flex size-7 items-center justify-center rounded-lg bg-hover font-sans text-xs">K</kbd>
            </button>
          </Hint>
        )}
        {item && (
          <Hint label={t("feeds.next")} keys="J">
            <button
              type="button"
              onClick={onNext}
              className="flex h-12 items-center gap-2.5 rounded-full bg-ink-btn pr-2.5 pl-6 text-[15px] font-semibold text-on-ink-btn shadow-[0_1px_2px_rgb(0_0_0/0.2),inset_0_1px_0_rgb(255_255_255/0.12)] transition-colors duration-150 hover:bg-ink-btn-hover"
            >
              {t("feeds.next")}
              <Icon icon={ArrowDown} size={16} />
              <kbd className="flex size-7 items-center justify-center rounded-lg bg-current/15 font-sans text-xs">J</kbd>
            </button>
          </Hint>
        )}
      </div>
      {item && <Peek item={item} feed={feed} onNext={onNext} />}
    </div>
  );
}

/** The next post's card below this one: its top laid out as the next sheet's own. */
function Peek({ item, feed, onNext }: { item: FeedItem; feed: Feed | undefined; onNext: () => void }) {
  return (
    // On the page's colour edge to edge: outside its round corners the page shows, not this card.
    <div className="-mx-6 bg-bg sm:-mx-16">
      <div aria-hidden className="feed-gap" />
      <button type="button" tabIndex={-1} data-feed-peek onClick={onNext} className="feed-peek block w-full text-left">
        <span aria-hidden className="block h-[76px]" />
        <span className="block px-6 pt-1 pb-40 sm:px-16">
          <span className="feed-article block">
            <span className="reader-article mx-auto block w-full max-w-[var(--reader-column,600px)]">
              {feed && (
                <span className="feed-chip inline-flex h-9 max-w-full items-center gap-2.5 rounded-full pr-4 pl-1.5 text-sm font-semibold">
                  <FeedIcon feed={feed} size={24} round />
                  <span className="truncate">{feedName(feed)}</span>
                </span>
              )}
              <span className="reader-title block">{item.title}</span>
            </span>
          </span>
        </span>
      </button>
    </div>
  );
}

/** A round 34 px button of the sheet's toolbar with its hint and key. */
function ToolButton({
  label,
  keys,
  pressed,
  disabled,
  end = false,
  onClick,
  children,
}: {
  label: string;
  keys: string;
  pressed?: boolean;
  disabled?: boolean;
  /** Near the right edge: the hint's right edge at the button's. */
  end?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Hint label={label} keys={keys} align={end ? "end" : "center"}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        aria-keyshortcuts={keys === "Esc" ? "Escape" : keys}
        disabled={disabled}
        onClick={onClick}
        className={`flex size-[34px] items-center justify-center rounded-full transition-colors duration-150 hover:bg-read-track disabled:opacity-45 disabled:hover:bg-transparent ${pressed ? "text-accent" : "text-read-text"}`}
      >
        {children}
      </button>
    </Hint>
  );
}
