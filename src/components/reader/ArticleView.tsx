import { MouseEvent, ReactNode, useEffect, useState } from "react";
import { ArrowUpRight, FileX } from "lucide-react";
import { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Article, cachedArticle, ReadFailure, readingMinutes } from "../../services/reader";
import { Icon } from "../icons";
import { Button } from "../ui/Button";

type State = { url: string } & ({ kind: "loading" } | { kind: "article"; article: Article } | { kind: "failed"; failure: ReadFailure | null });

/**
 * The article of `url`, read once per address (`cachedArticle`); a newer address wins over an older answer.
 * A new `attempt` asks again: a timeout or a lost connection is not kept in the cache.
 */
function useArticle(url: string, attempt: number) {
  const [state, setState] = useState<State>({ url, kind: "loading" });
  useEffect(() => {
    let current = true;
    setState({ url, kind: "loading" });
    cachedArticle(url).then(
      (read) => current && setState(read.ok ? { url, kind: "article", article: read.article } : { url, kind: "failed", failure: read.failure }),
      () => current && setState({ url, kind: "failed", failure: null }),
    );
    return () => {
      current = false;
    };
  }, [url, attempt]);
  // Until the effect runs for a new address, the old article must not show under the new title.
  return state.url === url ? state : ({ url, kind: "loading" } as const);
}

export type ArticleStatus = { kind: "loading" } | { kind: "article"; article: Article } | { kind: "failed"; failure: ReadFailure | null };

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
}) {
  const { t } = useTranslation();
  const state = useArticle(url, attempt);
  const article = state.kind === "article" ? state.article : null;
  useEffect(() => {
    if (article) onReady?.(article);
    // Once per article, not per render of the caller.
  }, [article]);
  useEffect(() => {
    onStatus?.(state);
    // Once per state, not per render of the caller.
  }, [state.kind, state.kind === "article" ? state.article : state.kind === "failed" ? state.failure : null]);

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
    <article lang={article?.language ?? undefined} aria-busy={!article || undefined} className="reader-article mx-auto w-full max-w-[600px]">
      <p className="reader-meta">
        {article?.site ?? domain}
        {article && (
          <>
            <span aria-hidden> · </span>
            {t("reader.minutes", { count: readingMinutes(article.words) })}
          </>
        )}
      </p>
      <h1 className="reader-title">{article?.title ?? title}</h1>
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
