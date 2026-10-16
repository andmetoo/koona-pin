import { Fragment, MouseEvent, ReactNode, useEffect, useRef, useState } from "react";
import { ArrowUpRight, FileX, WifiOff } from "lucide-react";
import { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Article, openArticle, ReadFailure, readingMinutes } from "../../services/reader";
import { Icon } from "../icons";
import { Button } from "../ui/Button";

type State = { url: string } & (
  | { kind: "loading" }
  /** `offlineAt`: the article is the offline copy saved then (NP-126). */
  | { kind: "article"; article: Article; offlineAt: string | null }
  | { kind: "failed"; failure: ReadFailure | null }
);

/**
 * The article of `url` (`openArticle`): the bookmark's offline copy when it has one,
 * else the page read once per address; a newer address wins over an older answer.
 * A new `attempt` asks again: a timeout or a lost connection is not kept in the cache.
 * The copy is looked for as the bookmark was when it opened: saving one later keeps
 * the article on screen.
 */
function useArticle(url: string, attempt: number, bookmarkId: number | undefined, offlineAt: string | null, live: boolean) {
  const [state, setState] = useState<State>({ url, kind: "loading" });
  const copy = useRef(offlineAt);
  copy.current = offlineAt;
  useEffect(() => {
    let current = true;
    setState({ url, kind: "loading" });
    openArticle({ id: bookmarkId ?? 0, url, offline_at: bookmarkId === undefined ? null : copy.current }, live).then(
      (read) =>
        current &&
        setState(read.ok ? { url, kind: "article", article: read.article, offlineAt: read.offlineAt } : { url, kind: "failed", failure: read.failure }),
      () => current && setState({ url, kind: "failed", failure: null }),
    );
    return () => {
      current = false;
    };
  }, [url, attempt, bookmarkId, live]);
  // Until the effect runs for a new address, the old article must not show under the new title.
  return state.url === url ? state : ({ url, kind: "loading" } as const);
}

export type ArticleStatus =
  | { kind: "loading" }
  | { kind: "article"; article: Article; offlineAt: string | null }
  | { kind: "failed"; failure: ReadFailure | null };

/** «Oct 3», with the year when it is not this one. */
export const savedOn = (iso: string, language: string) => {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(language, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
};

/** Why the page is not shown, in the person's words; `null` — an error the app did not expect. */
export function failureText(failure: ReadFailure | null, t: TFunction) {
  switch (failure?.reason) {
    case "refused":
      return t("reader.failure.refused");
    case "timeout":
      return t("reader.failure.timeout");
    case "network":
      return t("reader.failure.network");
    case "status":
      return t("reader.failure.status", { status: failure.status });
    case "not_html":
      return t("reader.failure.notHtml");
    case "links":
      return t("reader.failure.links");
    case "empty":
    case "too_short":
    case "off_topic":
      return t("reader.failure.empty");
    default:
      return t("reader.failure.network");
  }
}

/**
 * The article of a bookmark (NP-123; the reading mode of NP-122 shows it too):
 * the site and the minutes to read, the title, then the text extracted by
 * `readArticle` — only its sanitized HTML reaches the page. While it loads, a
 * quiet skeleton under the bookmark's own title; when there is no article, a
 * card that offers the browser, or the caller's own card (`failure`).
 * Links of the article open in the browser; links within it stay in it.
 */
export function ArticleView({
  url,
  title,
  domain,
  onOpen,
  onReady,
  failure,
  onStatus,
  attempt = 0,
  saved,
  bookmarkId,
  offlineAt = null,
  live = false,
}: {
  url: string;
  /** The bookmark's title: shown while the article loads and when there is none. */
  title: string;
  domain: string;
  /** A web address in the browser: the page itself, or a link of the article. */
  onOpen: (url: string) => void;
  /** The article is on the page: the caller may restore where reading stopped. */
  onReady?: (article: Article) => void;
  /** The caller's own card in place of the failure card (the reading mode, frames B5 and B6). */
  failure?: (failure: ReadFailure | null) => ReactNode;
  /** Loading, read or failed: the caller's queue and progress line say it too. */
  onStatus?: (status: ArticleStatus) => void;
  /** Bumped by the caller to read the page again («Try again», back online). */
  attempt?: number;
  /** When the bookmark was saved: «saved Oct 3» in the meta line (frame B3). */
  saved?: string;
  /** The bookmark: with `offlineAt`, its offline copy opens instead of the page (NP-126). */
  bookmarkId?: number;
  /** When its offline copy was saved; none without one. */
  offlineAt?: string | null;
  /** The page itself even when there is a copy («Try live page»). */
  live?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const state = useArticle(url, attempt, bookmarkId, offlineAt, live);
  const article = state.kind === "article" ? state.article : null;
  useEffect(() => {
    if (article) onReady?.(article);
    // Once per article, not per render of the caller.
  }, [article]);
  useEffect(() => {
    onStatus?.(state);
    // Once per state, not per render of the caller.
  }, [state.kind, state.kind === "article" ? state.article : state.kind === "failed" ? state.failure : null]);
  // The copy on screen, while the bookmark still has one: «offline copy · saved Oct 3».
  const copySaved = state.kind === "article" && state.offlineAt && offlineAt ? offlineAt : null;

  if (state.kind === "failed" && failure) return failure(state.failure);

  const follow = (e: MouseEvent<HTMLElement>) => {
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
    if (!link) return;
    const href = link.getAttribute("href") ?? "";
    // `#user-content-…`: a place in the article; the browser scrolls to it in the sheet.
    if (href.startsWith("#")) return;
    e.preventDefault();
    if (/^(https?|mailto):/i.test(href)) onOpen(href);
  };

  if (state.kind === "failed")
    return (
      <div data-reader-failure className="mx-auto flex max-w-[460px] flex-col items-center gap-3 px-6 py-20 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-secondary text-icon">
          <Icon icon={FileX} size={20} />
        </span>
        <h2 className="text-lg font-semibold">{t("reader.failure.title")}</h2>
        <p className="text-sm text-muted">{failureText(state.failure, t)}</p>
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          <Button variant="primary" onClick={() => onOpen(url)}>
            {t("reader.openInBrowser")}
            <Icon icon={ArrowUpRight} size={14} />
          </Button>
        </div>
      </div>
    );

  return (
    <article lang={article?.language ?? undefined} aria-busy={!article || undefined} className="reader-article mx-auto w-full max-w-[var(--reader-column,600px)]">
      <p className="reader-meta">
        {[
          article?.site ?? domain,
          article && t("reader.minutes", { count: readingMinutes(article.words) }),
          copySaved && t("reader.offlineCopy"),
          copySaved ? t("reader.saved", { date: savedOn(copySaved, i18n.language) }) : saved && t("reader.saved", { date: savedOn(saved, i18n.language) }),
        ]
          .filter(Boolean)
          .map((part, i) => (
            <Fragment key={i}>
              {i > 0 && <span aria-hidden> · </span>}
              {part}
            </Fragment>
          ))}
      </p>
      <h1 className="reader-title">{article?.title ?? title}</h1>
      {article?.description && <p className="reader-dek">{article.description}</p>}
      {article ? (
        <div className="reader-body" onClick={follow} dangerouslySetInnerHTML={{ __html: article.html }} />
      ) : (
        <div role="status" aria-label={t("reader.loading")} className="flex flex-col gap-3 pt-2">
          {[100, 96, 88, 100, 72].map((width, i) => (
            <span key={i} className="h-4 animate-pulse rounded-xs bg-hover" style={{ width: `${width}%` }} />
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * The line under the reader's bar when there is no connection and the offline
 * copy is on screen (frame O4): «No connection — reading the offline copy saved
 * Oct 3 · Try live page».
 */
export function OfflineBanner({ savedAt, onLive, className = "" }: { savedAt: string; onLive: () => void; className?: string }) {
  const { t, i18n } = useTranslation();
  return (
    <div data-offline-banner role="status" className={`flex shrink-0 items-center justify-center gap-2 border-b border-read-border bg-read-queue px-6 py-2 text-xs text-read-text ${className}`}>
      <Icon icon={WifiOff} size={13} className="shrink-0 text-read-muted" />
      <span className="min-w-0 truncate">{t("reader.offlineBanner", { date: savedOn(savedAt, i18n.language) })}</span>
      <span aria-hidden className="text-read-muted">·</span>
      <button type="button" onClick={onLive} className="shrink-0 font-medium text-read-ink underline-offset-2 hover:underline">
        {t("reader.tryLive")}
      </button>
    </div>
  );
}
