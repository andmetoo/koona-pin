import { ReactNode, Ref, useEffect, useMemo, useState } from "react";
import { ArrowLeft, BookOpen, Check, Heart, Link, Plus, Rss } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Bookmark, Feed, FeedArticle as CachedPost, FeedItem } from "../../types";
import { feedName, getFeedArticle } from "../../services/feeds";
import { articleOfPost, captionOf, pictureUrl, publishedLine, startsWithPicture } from "../../services/feedsView";
import { Article, cachedArticle, readingMinutes } from "../../services/reader";
import { ReaderChoice, ReaderLook, readerStyle } from "../../services/readerLook";
import { describeError } from "../../services/errors";
import { Icon } from "../icons";
import { Hint } from "../ui/Hint";
import { AaButton } from "../reader/AaPanel";
import { ArticleView, failureText } from "../reader/ArticleView";
import { FeedIcon } from "./FeedIcon";

export interface AaProps {
  choice: ReaderChoice;
  unlocked: boolean;
  onChoice: (choice: ReaderChoice) => void;
  onLocked: (wish: Pick<ReaderChoice, "theme">) => void;
  onSupporter: () => void;
}

/**
 * The article sheet (NP-132): a raised sheet inset 10 px with radius 18. ← on the left; on the
 * right Save S, Read later R, Favorite F, a hairline, Open O and Aa — the reading look of the
 * Aa panel. The cached post renders through `ArticleView` with an `Article` built by
 * `sanitize()`; a summary-only post offers «Load the full article», read on that click only.
 */
export function FeedArticleSheet({
  item,
  feed,
  bookmark,
  look,
  aa,
  narrow,
  scrollerRef,
  onBack,
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
  scrollerRef: Ref<HTMLDivElement>;
  onBack: () => void;
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
      aria-label={item ? item.title : t("feeds.article")}
      data-feed-article
      data-reader-look={look.theme}
      style={readerStyle(look)}
      className={`reading-look feed-sheet flex min-w-0 flex-1 flex-col overflow-hidden rounded-[18px] bg-sheet text-sheet-ink ${narrow ? "m-2.5" : "my-2.5 mr-2.5 ml-2.5"}`}
    >
      <header className="feed-toolbar flex h-[76px] shrink-0 items-center gap-[3px] pr-3 pl-[19px]">
        <ToolButton label={t("feeds.back")} keys="Esc" onClick={onBack}>
          <Icon icon={ArrowLeft} size={16} />
        </ToolButton>
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
      <div ref={scrollerRef} tabIndex={-1} data-feed-scroll className="feed-scroll min-h-0 flex-1 overflow-y-auto px-6 pt-1 pb-24 outline-none sm:px-16">
        {item ? (
          <Post key={item.id} item={item} feed={feed} onOpen={onOpen} onFeed={onFeed} />
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
  const showPicture = !!picture && !!cached && !page && !startsWithPicture(cached.html);
  const caption = showPicture && post ? captionOf(item.excerpt, post.html) : null;

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
      className="feed-chip inline-flex h-7 max-w-full items-center gap-2 rounded-full border border-sheet-line pr-3 pl-1 text-sm font-semibold transition-colors duration-150 hover:bg-hover"
    >
      <FeedIcon feed={feed} size={20} round />
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
  const lead = showPicture ? (
    <figure className="feed-lead">
      <img src={picture} alt="" referrerPolicy="no-referrer" className="aspect-[680/382] w-full rounded-2xl bg-well object-cover" />
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
        className={`flex size-[34px] items-center justify-center rounded-full transition-colors duration-150 hover:bg-read-track disabled:opacity-45 ${pressed ? "text-accent" : "text-read-text"}`}
      >
        {children}
      </button>
    </Hint>
  );
}
