import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Check, Unlink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CheckedLink, Collection, LinkCheckProgress, LinkCheckReport } from "../../types";
import { api } from "../../services/api";
import { bulkFailure, bulkNotice } from "../../services/bulk";
import { collectionColor } from "../../services/collections";
import { describeError } from "../../services/errors";
import { checkedWhen, etaText, finishedLine, FIRST_ROWS, replacedNotice, resultLabel } from "../../services/linkcheck";
import { Icon } from "../icons";
import { Button } from "../ui/Button";
import { Dot } from "../ui/Controls";
import { Preview } from "./Bookmarks";

type Group = "gone" | "moved" | "failed";
const GROUPS: Group[] = ["gone", "moved", "failed"];

/**
 * The section «Проверка ссылок» (NP-036, sheet 35): before the first check
 * what it will do, then the run with «Остановить», and the results by group —
 * links that no longer open, pages that moved, links that could not be
 * checked. Nothing is deleted on its own; trash and replace are one journal
 * command each, so the caller's notice offers `Ctrl Z`.
 */
export function LinkCheckPage({
  collections,
  padding,
  onOpen,
  onDone,
  onFailed,
}: {
  collections: Collection[];
  padding: string;
  onOpen: (url: string) => void;
  /** A finished action: the notice, alert or not, and the command to undo. */
  onDone: (text: string, alert: boolean, command: number | null) => void;
  onFailed: (text: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [report, setReport] = useState<LinkCheckReport | null>(null);
  const [open, setOpen] = useState<Set<Group>>(new Set());
  const [busy, setBusy] = useState(false);
  const timer = useRef(0);

  const load = useCallback(() => {
    void api
      .getLinkCheck()
      .then(setReport)
      .catch((err) => onFailed(describeError(err)));
  }, [onFailed]);
  useEffect(() => {
    load();
    const later = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(load, 150);
    };
    // Progress moves the strip at once; written results are read again.
    const progress = (p: LinkCheckProgress) => {
      setReport((prev) => prev && { ...prev, state: p.state, done: p.done, total: p.total, eta_seconds: p.eta_seconds });
      if (p.written || p.state !== "running") later();
      if (p.error) onFailed(t("links.writeFailed", { reason: p.error }));
    };
    const offs = [api.onLinkCheck(progress), api.onBookmarkChanged(later), api.onBookmarksChanged(later), api.onLibraryInvalidated(later)];
    return () => {
      window.clearTimeout(timer.current);
      offs.forEach((off) => off());
    };
  }, [load, onFailed, t]);

  const start = (ids: number[] | null, resume: boolean) => {
    setReport((prev) => prev && { ...prev, state: "running", eta_seconds: null });
    api.startLinkCheck(ids, resume).catch((err) => {
      onFailed(describeError(err));
      load();
    });
  };
  const stop = () => void api.stopLinkCheck().catch((err) => onFailed(describeError(err)));
  const trash = async (ids: number[]) => {
    setBusy(true);
    try {
      const result = await api.bulkUpdate(ids, { action: "trash" });
      onDone(bulkNotice(t, { action: "trash" }, result.count), false, result.command);
    } catch (err) {
      onFailed(bulkFailure(t, { action: "trash" }, ids.length, err));
    } finally {
      setBusy(false);
      load();
    }
  };
  const replace = async (ids: number[]) => {
    setBusy(true);
    try {
      const result = await api.replaceAddresses(ids);
      const { text, alert } = replacedNotice(t, result);
      onDone(text, alert, result.command);
    } catch (err) {
      onFailed(t("links.replaceFailed", { reason: describeError(err) }));
    } finally {
      setBusy(false);
      load();
    }
  };

  const collectionName = (id: number | null) => collections.find((c) => c.id === id)?.name ?? null;
  const running = report?.state === "running";
  const count = report ? report.gone.length + report.moved.length : 0;
  const results = report ? GROUPS.some((g) => report[g].length > 0) : false;
  const checkedOnce = !!report && (report.finished_at !== null || report.unchecked < report.library || results);

  const strip = (() => {
    if (!report) return null;
    if (report.state === "running")
      return (
        <div className="flex items-center gap-3 rounded-lg bg-panel py-2.5 pr-3 pl-3" role="status" data-link-check="running">
          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            <p className="flex items-baseline gap-3 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium">{t("links.running", { done: report.done, total: report.total })}</span>
              <span className="shrink-0 text-muted">{etaText(t, report.eta_seconds)}</span>
            </p>
            <div className="h-1 overflow-hidden rounded-full bg-line" aria-hidden>
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${report.total ? Math.min(100, (report.done / report.total) * 100) : 0}%` }}
              />
            </div>
          </div>
          <Button variant="outline" onClick={stop}>
            {t("links.stop")}
          </Button>
        </div>
      );
    const line = (text: string, action: ReactNode, state: string) => (
      <div className="flex min-h-9 items-center gap-3 rounded-lg bg-panel py-1 pr-1 pl-3 text-sm text-icon" data-link-check={state}>
        <p className="min-w-0 flex-1">{text}</p>
        {action}
      </div>
    );
    if (report.state === "stopped")
      return line(
        t("links.stopped", { done: report.done, total: report.total }),
        <Button variant="primary" onClick={() => start(null, true)}>
          {t("links.continue")}
        </Button>,
        "stopped",
      );
    if (report.state === "offline")
      return line(
        t("links.offline", { done: report.done, total: report.total }),
        <Button variant="outline" onClick={() => start(null, true)}>
          {t("common.retry")}
        </Button>,
        "offline",
      );
    if (report.finished_at && results)
      return line(
        finishedLine(t, report, i18n.language),
        <Button variant="outline" onClick={() => start(null, false)}>
          {t("links.checkAgain")}
        </Button>,
        "finished",
      );
    return null;
  })();

  return (
    <>
      <div className={`${padding} pt-2 pb-4`}>
        <h1 className="flex h-9 items-baseline gap-2 pt-1.5">
          <span className="text-2xl font-semibold">{t("links.title")}</span>
          {report && count > 0 && <span className="text-md text-subtle">{count}</span>}
        </h1>
      </div>
      <div className={`min-h-0 flex-1 overflow-y-auto pb-8 ${padding}`}>
        {report === null ? (
          <p role="status" className="text-sm text-muted">
            {t("links.loading")}
          </p>
        ) : !checkedOnce && !running ? (
          // Before the first check: what will happen, and that it is the person's call.
          <Empty icon={Unlink} title={t("links.introTitle")} wide>
            <p className="text-sm text-muted">{t("links.introText", { count: report.library })}</p>
            <p className="text-xs text-subtle">{t("links.introSmall")}</p>
            <Button variant="primary" className="mt-3" disabled={report.library === 0} onClick={() => start(null, false)}>
              {t("links.start", { count: report.library })}
            </Button>
          </Empty>
        ) : (
          <div className="flex flex-col gap-3">
            {strip}
            {!results && !running && report.state === "idle" ? (
              <Empty icon={Check} title={t("links.allOpenTitle")} accent>
                <p className="text-sm text-muted">{finishedLine(t, report, i18n.language)}</p>
                <Button variant="outline" className="mt-3" onClick={() => start(null, false)}>
                  {t("links.checkAgain")}
                </Button>
              </Empty>
            ) : (
              GROUPS.filter((g) => report[g].length > 0).map((g) => {
                const links = report[g];
                const shown = open.has(g) ? links : links.slice(0, FIRST_ROWS);
                const ids = links.map((l) => l.bookmark.id);
                const replaceable = links.filter((l) => !l.conflict).map((l) => l.bookmark.id);
                return (
                  <section key={g} aria-labelledby={`links-${g}`} data-link-group={g} className="rounded-xl border border-line bg-card">
                    <header className="flex min-h-11 items-center gap-2 py-2 pr-4 pl-4">
                      <h2 id={`links-${g}`} className="text-sm font-semibold">
                        {t(`links.group_${g}`)}
                      </h2>
                      <span className="text-sm text-subtle">{t("links.bookmarks", { count: links.length })}</span>
                      <span className="flex-1" />
                      {g === "gone" && (
                        <Button variant="outline" disabled={busy} onClick={() => void trash(ids)}>
                          {t("links.trashAll")}
                        </Button>
                      )}
                      {g === "moved" && (
                        <Button variant="primary" disabled={busy || replaceable.length === 0} onClick={() => void replace(replaceable)}>
                          {t("links.replaceAll")}
                        </Button>
                      )}
                      {g === "failed" && (
                        <Button variant="outline" disabled={running} onClick={() => start(ids, false)}>
                          {t("links.checkAgain")}
                        </Button>
                      )}
                    </header>
                    <ul className="border-y border-divider px-1.5 py-1">
                      {shown.map((link) => (
                        <Row
                          key={link.bookmark.id}
                          link={link}
                          group={g}
                          busy={busy}
                          label={resultLabel(t, link, g)}
                          collection={collectionName(link.bookmark.collection_id)}
                          checked={checkedWhen(t, link.checked_at, i18n.language)}
                          onOpen={() => onOpen(link.bookmark.url)}
                          onTrash={() => void trash([link.bookmark.id])}
                          onReplace={() => void replace([link.bookmark.id])}
                        />
                      ))}
                    </ul>
                    <footer className="flex items-start gap-4 px-4 py-2.5 text-xs">
                      <p className="min-w-0 flex-1 text-muted">{t(`links.footer_${g}`)}</p>
                      {links.length > FIRST_ROWS && (
                        <button
                          type="button"
                          onClick={() => setOpen((prev) => new Set(prev).add(g))}
                          hidden={open.has(g)}
                          className="shrink-0 font-medium text-accent hover:underline"
                        >
                          {t("links.showMore", { count: links.length - FIRST_ROWS })}
                        </button>
                      )}
                    </footer>
                  </section>
                );
              })
            )}
          </div>
        )}
      </div>
    </>
  );
}

function Empty({
  icon,
  title,
  wide = false,
  accent = false,
  children,
}: {
  icon: typeof Check;
  title: string;
  wide?: boolean;
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`mx-auto flex flex-col items-center gap-2 pt-16 text-center ${wide ? "max-w-[560px]" : "max-w-[440px]"}`}>
      <span className={`mb-2 flex size-14 items-center justify-center rounded-full bg-secondary ${accent ? "text-accent" : "text-icon"}`}>
        <Icon icon={icon} size={22} />
      </span>
      <h2 className="text-xl font-semibold">{title}</h2>
      {children}
    </div>
  );
}

/** One bookmark and its result (sheet 35). Actions show on hover and keyboard focus; «Заменить адрес» always. */
function Row({
  link,
  group,
  busy,
  label,
  collection,
  checked,
  onOpen,
  onTrash,
  onReplace,
}: {
  link: CheckedLink;
  group: Group;
  busy: boolean;
  label: string;
  collection: string | null;
  checked: string;
  onOpen: () => void;
  onTrash: () => void;
  onReplace: () => void;
}) {
  const { t } = useTranslation();
  const b = link.bookmark;
  const hover = group !== "moved";
  return (
    <li
      data-bookmark-id={b.id}
      className="group/row flex min-h-[52px] items-center gap-3.5 rounded-lg px-2.5 py-1 transition-colors duration-150 hover:bg-panel focus-within:bg-panel"
    >
      <span className="h-11 w-16 shrink-0 overflow-hidden rounded-md">
        <Preview b={b} mark={16} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-md font-medium" title={b.title}>
          {b.title}
        </span>
        <span className="truncate text-xs text-subtle">
          {group === "moved" && link.target ? (
            <>
              {b.url}
              <span aria-hidden> → </span>
              <span className="sr-only">{t("links.movedTo")}</span>
              <span className="text-icon">{link.target}</span>
            </>
          ) : (
            b.url
          )}
        </span>
      </span>
      <span className="w-[170px] shrink-0">
        <span className="inline-block max-w-full truncate rounded-[5px] bg-line px-1.5 py-px text-2xs text-icon group-hover/row:bg-border" data-result>
          {label}
        </span>
      </span>
      <span className={`flex w-[130px] shrink-0 items-center gap-2 text-xs max-[1099px]:hidden ${hover ? "group-focus-within/row:invisible group-hover/row:invisible" : ""}`}>
        {collection ? (
          <>
            <Dot color={collectionColor(b.collection_id!)} />
            <span className="truncate text-icon">{collection}</span>
          </>
        ) : (
          <span className="text-subtle">{t("duplicates.noCollection")}</span>
        )}
      </span>
      <span className="relative flex w-[210px] shrink-0 items-center justify-end">
        {group === "moved" ? (
          link.conflict ? (
            <span className="text-right text-xs text-subtle">{t("links.alreadySaved")}</span>
          ) : (
            <Button variant="outline" disabled={busy} onClick={onReplace}>
              {t("links.replace")}
            </Button>
          )
        ) : (
          <>
            <span className="text-xs text-subtle group-focus-within/row:invisible group-hover/row:invisible">{checked}</span>
            <span className="absolute inset-y-0 right-0 flex items-center gap-2 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100">
              <Button variant="ghost" onClick={onOpen}>
                {t("links.open_action")}
              </Button>
              {group === "gone" && (
                <Button variant="outline" disabled={busy} onClick={onTrash}>
                  {t("links.trash")}
                </Button>
              )}
            </span>
          </>
        )}
      </span>
    </li>
  );
}
